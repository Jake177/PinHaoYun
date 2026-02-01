import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;
const originalBucket = process.env.S3_ORIGINAL_BUCKET;
const thumbnailBucket = process.env.S3_THUMBNAIL_BUCKET;

if (!tableName) {
  console.warn("[videos/list] Missing env VIDEOS_TABLE");
}

const ddb = new DynamoDBClient({ region });
const s3 = new S3Client({ region });

const expiresInSeconds = Number(process.env.PRESIGN_TTL_SECONDS || 900);

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

  // Some older lambdas stored an encoded email segment (e.g. `%40`) while newer code uses `@`.
  // Provide an alternate key so the client can fall back if a thumb URL 404s due to mismatch.
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

    const decodeCursor = (cursor: string) => {
      try {
        return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
      } catch {
        return {};
      }
    };

    const cursorState = cursorParam ? decodeCursor(cursorParam) : {};
    const videoStartKey = cursorState.video || undefined;
    const photoStartKey = cursorState.photo || undefined;

    const queryLimit = searchDate ? limit * 3 : limit + 10;
    const queryByPrefix = async (skPrefix: string, startKey?: Record<string, any>) => {
      const res = await ddb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "email = :email AND begins_with(sk, :skPrefix)",
          ExpressionAttributeValues: {
            ":email": { S: normalizedEmail },
            ":skPrefix": { S: `${skPrefix}#` },
          },
          ExclusiveStartKey: startKey,
          Limit: queryLimit,
        }),
      );
      return {
        items: res.Items?.map((item) => unmarshall(item) as Record<string, any>) || [],
        lastKey: res.LastEvaluatedKey || null,
      };
    };

    const [videoRes, photoRes] = await Promise.all([
      queryByPrefix("VIDEO", videoStartKey),
      queryByPrefix("PHOTO", photoStartKey),
    ]);

    const records = [...videoRes.items, ...photoRes.items];

    const media = records
      .filter(
        (r) =>
          typeof r.sk === "string" &&
          (r.sk.startsWith("VIDEO#") || r.sk.startsWith("PHOTO#")) &&
          r.status !== "DELETING" &&
          r.status !== "DELETED",
      )
      .map((item) => ({
        id: item.videoId || item.photoId || item.sk || "",
        type: item.type || (item.sk?.startsWith("PHOTO#") ? "PHOTO" : "VIDEO"),
        contentType: item.contentType,
        originalKey: item.originalKey,
        originalBucket: item.originalBucket,
        originalPhotoKey: item.originalPhotoKey,
        originalPhotoBucket: item.originalPhotoBucket,
        thumbnailKey: item.thumbnailKey,
        thumbnailBucket: item.thumbnailBucket,
        status: item.status,
        size: item.size,
        createdAt: item.createdAt,
        originalName: item.originalName,
        contentHash: item.contentHash,
        captureTime: item.captureTime,
        fileLastModified: item.fileLastModified,
        captureLocation: item.captureLocation,
        captureLat: item.captureLat,
        captureLon: item.captureLon,
        captureAddress: item.captureAddress,
        captureCity: item.captureCity,
        captureRegion: item.captureRegion,
        captureCountry: item.captureCountry,
        captureAlt: item.captureAlt,
        orientation: item.orientation,
        deviceMake: item.deviceMake,
        deviceModel: item.deviceModel,
        deviceSoftware: item.deviceSoftware,
        durationSec: item.durationSec,
        width: item.width,
        height: item.height,
        fps: item.fps,
        bitrate: item.bitrate,
        codec: item.codec,
        rotation: item.rotation,
        liveVideoKey: item.liveVideoKey,
        liveVideoBucket: item.liveVideoBucket,
        liveVideoSize: item.liveVideoSize,
      }));

    // Sort by capture time, then file last modified, then created at (descending)
    const sorted = media.sort((a, b) => {
      const da = toDate(a.captureTime) ?? toDate(a.fileLastModified) ?? toDate(a.createdAt) ?? 0;
      const db = toDate(b.captureTime) ?? toDate(b.fileLastModified) ?? toDate(b.createdAt) ?? 0;
      return db - da;
    });

    // Apply date filter if provided
    const filtered = searchDate
      ? sorted.filter((v) =>
          [v.captureTime, v.fileLastModified, v.createdAt].some((d) => d?.startsWith(searchDate)),
        )
      : sorted;

    // Paginate results
    const paginated = filtered.slice(0, limit);

    // Generate presigned URLs only for the paginated results
    const withUrls = await Promise.all(
      paginated.map(async (item) => {
        const thumbBucket = item.thumbnailBucket || thumbnailBucket;
        const thumbKey = item.thumbnailKey;
        const thumbKeyAlt = altKeyForEmailSegment(thumbKey) || undefined;
        const originalUrl = await signUrl(
          item.originalBucket || originalBucket,
          item.originalKey,
        );
        // For photos, get the original photo (HEIC/etc) if available
        const originalPhotoUrl = item.type === "PHOTO"
          ? await signUrl(
              item.originalPhotoBucket || originalBucket,
              item.originalPhotoKey,
            )
          : null;
        const thumbnailUrl = await signUrl(thumbBucket, thumbKey);
        const thumbnailUrlAlt = thumbKeyAlt
          ? await signUrl(thumbBucket, thumbKeyAlt)
          : null;
        const liveVideoUrl = await signUrl(
          item.liveVideoBucket || originalBucket,
          item.liveVideoKey,
        );
        return {
          ...item,
          originalUrl,
          originalPhotoUrl,
          thumbnailUrl,
          thumbnailUrlAlt,
          liveVideoUrl,
        };
      }),
    );

    // Prepare next cursor
    let nextCursor: string | null = null;
    const hasMoreVideo = Boolean(videoRes.lastKey);
    const hasMorePhoto = Boolean(photoRes.lastKey);
    
    // Only set cursor if there's actually more data to fetch
    if (hasMoreVideo || hasMorePhoto) {
      nextCursor = Buffer.from(
        JSON.stringify({
          video: videoRes.lastKey || null,
          photo: photoRes.lastKey || null,
        }),
      ).toString("base64");
    }

    // hasMore is true only if we have a valid next cursor
    const hasMore = Boolean(nextCursor);

    return NextResponse.json({
      videos: withUrls,
      nextCursor,
      hasMore,
    });
  } catch (error: any) {
    console.error("[videos/list] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch videos" },
      { status: 500 },
    );
  }
}
