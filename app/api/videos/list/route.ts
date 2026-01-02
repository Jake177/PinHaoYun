import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const region = "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;
const originalBucket = process.env.S3_ORIGINAL_BUCKET;
const thumbnailBucket = process.env.S3_THUMBNAIL_BUCKET;

if (!tableName) {
  console.warn("[videos/list] Missing env VIDEOS_TABLE");
}

const ddb = new DynamoDBClient({ region });
const s3 = new S3Client({ region });

const expiresInSeconds = Number(process.env.PRESIGN_TTL_SECONDS || 900);

type VideoItem = {
  id: string;
  originalKey: string;
  thumbnailKey?: string;
  status?: string;
  size?: number;
  createdAt?: string;
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

const toDate = (value?: string) => {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
};

const DEFAULT_PAGE_SIZE = 20;

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

    const normalizedEmail = email.toLowerCase();
    const searchDate = request.nextUrl.searchParams.get("date"); // YYYY / YYYY-MM / YYYY-MM-DD
    const limitParam = request.nextUrl.searchParams.get("limit");
    const cursorParam = request.nextUrl.searchParams.get("cursor");

    const limit = Math.min(Math.max(Number(limitParam) || DEFAULT_PAGE_SIZE, 1), 100);

    // Decode cursor from base64 if provided
    let exclusiveStartKey: Record<string, any> | undefined;
    if (cursorParam) {
      try {
        exclusiveStartKey = JSON.parse(
          Buffer.from(cursorParam, "base64").toString("utf-8")
        );
      } catch {
        // Invalid cursor, ignore
      }
    }

    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: {
          ":email": { S: normalizedEmail },
        },
        ExclusiveStartKey: exclusiveStartKey,
        // Fetch more than limit to allow filtering, but cap at reasonable number
        Limit: searchDate ? limit * 3 : limit + 10,
      }),
    );

    const records =
      res.Items?.map((item) => unmarshall(item) as Record<string, any>) || [];

    const videos = records
      .filter((r) => typeof r.sk === "string" && r.sk.startsWith("VIDEO#"))
      .map((vid) => ({
        id: vid.videoId || vid.sk || "",
        originalKey: vid.originalKey,
        originalBucket: vid.originalBucket,
        thumbnailKey: vid.thumbnailKey,
        thumbnailBucket: vid.thumbnailBucket,
        status: vid.status,
        size: vid.size,
        createdAt: vid.createdAt,
        originalName: vid.originalName,
        contentHash: vid.contentHash,
        captureTime: vid.captureTime,
        captureLocation: vid.captureLocation,
        captureLat: vid.captureLat,
        captureLon: vid.captureLon,
        captureAlt: vid.captureAlt,
        durationSec: vid.durationSec,
        width: vid.width,
        height: vid.height,
        fps: vid.fps,
        bitrate: vid.bitrate,
        codec: vid.codec,
        rotation: vid.rotation,
      }));

    // Sort by capture time or created at (descending)
    const sorted = videos.sort((a, b) => {
      const da = toDate(a.captureTime) ?? toDate(a.createdAt) ?? 0;
      const db = toDate(b.captureTime) ?? toDate(b.createdAt) ?? 0;
      return db - da;
    });

    // Apply date filter if provided
    const filtered = searchDate
      ? sorted.filter((v) =>
          [v.captureTime, v.createdAt].some((d) => d?.startsWith(searchDate)),
        )
      : sorted;

    // Paginate results
    const paginated = filtered.slice(0, limit);

    // Generate presigned URLs only for the paginated results
    const withUrls = await Promise.all(
      paginated.map(async (item) => {
        const originalUrl = await signUrl(
          item.originalBucket || originalBucket,
          item.originalKey,
        );
        const thumbnailUrl = await signUrl(
          item.thumbnailBucket || thumbnailBucket,
          item.thumbnailKey,
        );
        return {
          ...item,
          originalUrl,
          thumbnailUrl,
        };
      }),
    );

    // Prepare next cursor
    let nextCursor: string | null = null;
    if (res.LastEvaluatedKey) {
      nextCursor = Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString("base64");
    } else if (filtered.length > limit) {
      // If we filtered and have more items locally, we need to continue from last item
      // This is a simplified approach - for production you might need a more robust solution
    }

    return NextResponse.json({
      videos: withUrls,
      nextCursor,
      hasMore: !!nextCursor || filtered.length > limit,
    });
  } catch (error: any) {
    console.error("[videos/list] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch videos" },
      { status: 500 },
    );
  }
}
