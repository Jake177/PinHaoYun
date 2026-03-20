import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  DynamoDBClient,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";
import {
  mapDbMediaItem,
  queryAllMediaForUser,
  type LibraryMediaItem,
} from "@/app/lib/mediaLibrary";
import { normaliseDatePrefix } from "@/app/lib/mediaTimeline";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;
const originalBucket = process.env.S3_ORIGINAL_BUCKET;
const thumbnailBucket = process.env.S3_THUMBNAIL_BUCKET;
const timelineIndexName = process.env.TIMELINE_INDEX_NAME?.trim() || "";

if (!tableName) {
  console.warn("[videos/list] Missing env VIDEOS_TABLE");
}

const ddb = new DynamoDBClient({ region });
const s3 = new S3Client({ region });

const expiresInSeconds = Number(process.env.PRESIGN_TTL_SECONDS || 900);
const DEFAULT_PAGE_SIZE = 20;

type CursorState = {
  lastEvaluatedKey?: Record<string, AttributeValue> | null;
  offset?: number;
};

type LibraryListItem = LibraryMediaItem & {
  thumbnailUrl: string | null;
  thumbnailUrlAlt: string | null;
  originalUrl: string | null;
  originalPhotoUrl: string | null;
  liveVideoUrl: string | null;
};

async function signUrl(
  bucket: string | undefined,
  key: string | undefined,
): Promise<string | null> {
  if (!bucket || !key) return null;
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  } catch (err) {
    console.warn("[videos/list] Failed to presign", err);
    return null;
  }
}

const altKeyForEmailSegment = (key?: string): string | null => {
  if (!key) return null;
  const parts = String(key).split("/");
  if (parts.length < 3) return null;
  const emailSeg = parts[1];

  let altSeg: string | null = null;
  if (emailSeg.includes("@")) {
    altSeg = encodeURIComponent(emailSeg);
  } else if (/%[0-9A-Fa-f]{2}/.test(emailSeg)) {
    try {
      const decoded = decodeURIComponent(emailSeg);
      if (decoded !== emailSeg) altSeg = decoded;
    } catch {
      // ignore
    }
  }

  if (!altSeg || altSeg === emailSeg) return null;
  const altParts = [...parts];
  altParts[1] = altSeg;
  const altKey = altParts.join("/");
  return altKey !== key ? altKey : null;
};

const decodeCursor = (cursor?: string | null): CursorState => {
  if (!cursor) return {};
  try {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")) as CursorState;
  } catch {
    return {};
  }
};

const encodeCursor = (cursor: CursorState | null): string | null => {
  if (!cursor) return null;
  if (!cursor.lastEvaluatedKey && cursor.offset == null) return null;
  return Buffer.from(JSON.stringify(cursor)).toString("base64");
};

const filterByDatePrefix = (
  items: LibraryMediaItem[],
  datePrefix: string | null,
): LibraryMediaItem[] => {
  if (!datePrefix) return items;
  return items.filter((item) => (item.mediaAt || "").startsWith(datePrefix));
};

const withSignedUrls = async (
  items: LibraryMediaItem[],
): Promise<LibraryListItem[]> =>
  Promise.all(
    items.map(async (item) => {
      const thumbBucket = item.thumbnailBucket || thumbnailBucket;
      const thumbKey = item.thumbnailKey;
      const thumbKeyAlt = altKeyForEmailSegment(thumbKey) || undefined;
      return {
        ...item,
        originalUrl: await signUrl(item.originalBucket || originalBucket, item.originalKey),
        originalPhotoUrl:
          item.type === "PHOTO"
            ? await signUrl(
                item.originalPhotoBucket || originalBucket,
                item.originalPhotoKey,
              )
            : null,
        thumbnailUrl: await signUrl(thumbBucket, thumbKey),
        thumbnailUrlAlt: thumbKeyAlt ? await signUrl(thumbBucket, thumbKeyAlt) : null,
        liveVideoUrl: await signUrl(
          item.liveVideoBucket || originalBucket,
          item.liveVideoKey,
        ),
      };
    }),
  );

const listViaTimelineIndex = async ({
  email,
  limit,
  datePrefix,
  cursor,
}: {
  email: string;
  limit: number;
  datePrefix: string | null;
  cursor: CursorState;
}) => {
  let lastEvaluatedKey = cursor.lastEvaluatedKey || undefined;
  const page: LibraryMediaItem[] = [];

  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: tableName!,
        IndexName: timelineIndexName,
        KeyConditionExpression: datePrefix
          ? "timelinePk = :timelinePk AND begins_with(timelineSk, :timelineSkPrefix)"
          : "timelinePk = :timelinePk",
        ExpressionAttributeValues: {
          ":timelinePk": { S: `USER#${email}` },
          ...(datePrefix
            ? {
                ":timelineSkPrefix": { S: datePrefix },
              }
            : {}),
        },
        ScanIndexForward: false,
        ExclusiveStartKey: lastEvaluatedKey,
        Limit: limit - page.length,
      }),
    );

    const items =
      response.Items?.map((entry) =>
        mapDbMediaItem(unmarshall(entry) as Record<string, unknown>),
      ) || [];

    page.push(
      ...items.filter(
        (item) => item.status !== "DELETING" && item.status !== "DELETED",
      ),
    );
    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (page.length < limit && lastEvaluatedKey);

  return {
    items: page,
    nextCursor: encodeCursor(
      lastEvaluatedKey ? { lastEvaluatedKey } : null,
    ),
    hasMore: Boolean(lastEvaluatedKey),
  };
};

const listViaPrimaryKeyFallback = async ({
  email,
  limit,
  datePrefix,
  cursor,
}: {
  email: string;
  limit: number;
  datePrefix: string | null;
  cursor: CursorState;
}) => {
  const allMedia = await queryAllMediaForUser({
    ddb,
    tableName: tableName!,
    email,
  });
  const filtered = filterByDatePrefix(allMedia, datePrefix);
  const offset = Math.max(0, Number(cursor.offset) || 0);
  const items = filtered.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < filtered.length;

  return {
    items,
    nextCursor: hasMore ? encodeCursor({ offset: nextOffset }) : null,
    hasMore,
  };
};

export async function GET(request: NextRequest) {
  try {
    if (!tableName) {
      return NextResponse.json(
        { error: "Missing table configuration" },
        { status: 500 },
      );
    }

    const cookieStore = await cookies();
    const token = cookieStore.get("id_token")?.value;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = decodeIdToken(token) as Record<string, unknown>;
    const email =
      (payload.email as string) ||
      (payload["cognito:username"] as string) ||
      (payload.sub as string);
    if (!email) {
      return NextResponse.json({ error: "Missing user id" }, { status: 401 });
    }

    const limitParam = request.nextUrl.searchParams.get("limit");
    const cursorParam = request.nextUrl.searchParams.get("cursor");
    const datePrefix = normaliseDatePrefix(
      request.nextUrl.searchParams.get("date"),
    );
    const limit = Math.min(
      Math.max(Number(limitParam) || DEFAULT_PAGE_SIZE, 1),
      100,
    );
    const cursor = decodeCursor(cursorParam);

    let result:
      | {
          items: LibraryMediaItem[];
          nextCursor: string | null;
          hasMore: boolean;
        }
      | null = null;

    if (timelineIndexName) {
      try {
        result = await listViaTimelineIndex({
          email: email.toLowerCase(),
          limit,
          datePrefix,
          cursor,
        });
      } catch (error: any) {
        console.warn("[videos/list] Timeline index query failed, falling back", {
          name: error?.name,
          message: error?.message,
        });
      }
    }

    if (!result) {
      result = await listViaPrimaryKeyFallback({
        email: email.toLowerCase(),
        limit,
        datePrefix,
        cursor,
      });
    }

    const videos = await withSignedUrls(result.items);

    return NextResponse.json({
      videos,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (error: any) {
    console.error("[videos/list] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch videos" },
      { status: 500 },
    );
  }
}
