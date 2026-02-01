import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";
import { normaliseContentType } from "@/app/lib/contentType";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;

const ddb = new DynamoDBClient({ region });
const DEFAULT_QUOTA_BYTES = 256 * 1024 * 1024 * 1024; // 256GB

export async function POST(request: Request) {
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
    const userId =
      (payload.email as string) ||
      (payload["cognito:username"] as string) ||
      (payload.sub as string);
    if (!userId) {
      return NextResponse.json({ error: "Missing user id" }, { status: 401 });
    }
    const normalizedUser = userId.toLowerCase();

    const body = (await request.json()) as {
      bucket: string;
      key: string;
      originalName?: string;
      contentType?: string;
      size?: number;
      uploadedAt?: string;
      contentHash?: string;
      mediaType?: "VIDEO" | "PHOTO";
      mediaRole?: "image" | "liveVideo";
      videoId?: string;
      photoId?: string;
      fileLastModified?: string;
    };
    const now = new Date().toISOString();
    const createdAt = body.uploadedAt || now;
    const fileLastModified = body.fileLastModified || null;
    const mediaType = body.mediaType === "PHOTO" ? "PHOTO" : "VIDEO";
    const mediaRole = body.mediaRole === "liveVideo" ? "liveVideo" : "image";
    const keyName = body.key?.split("/").pop() || "";
    const derivedPhotoId = keyName ? keyName.split("_")[0] : "";
    const mediaId =
      mediaType === "PHOTO"
        ? (body.photoId || derivedPhotoId || body.videoId || "")
        : (body.videoId || keyName);
    const sk = `${mediaType}#${mediaId}`;
    const contentHash = body.contentHash;
    const resolvedContentType =
      normaliseContentType(body.contentType, body.originalName || body.key) ||
      "application/octet-stream";

    if (!contentHash && !(mediaType === "PHOTO" && mediaRole === "liveVideo")) {
      return NextResponse.json(
        { error: "Missing content hash" },
        { status: 400 },
      );
    }

    const reserveSk = mediaType === "PHOTO"
      ? `RESERVE#PHOTO#${mediaId}`
      : `RESERVE#${mediaId}`;
    const reserveRes = await ddb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          email: { S: normalizedUser },
          sk: { S: reserveSk },
        },
      }),
    );

    if (!reserveRes.Item) {
      return NextResponse.json(
        { error: "Upload reservation not found" },
        { status: 409 },
      );
    }

    const reserve = unmarshall(reserveRes.Item) as Record<string, any>;
    const reservedSize = Number(reserve.size || 0);
    if (!reservedSize || reservedSize <= 0) {
      return NextResponse.json(
        { error: "Invalid reservation size" },
        { status: 409 },
      );
    }
    if (reserve.key && reserve.key !== body.key) {
      return NextResponse.json(
        { error: "Reservation mismatch" },
        { status: 409 },
      );
    }

    try {
      if (mediaType === "PHOTO" && mediaRole === "liveVideo") {
        await ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: tableName,
                  Key: {
                    email: { S: normalizedUser },
                    sk: { S: reserveSk },
                  },
                },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: {
                    email: { S: normalizedUser },
                    sk: { S: sk },
                  },
                  UpdateExpression:
                    "SET liveVideoBucket = :bucket, liveVideoKey = :key, liveVideoName = :name, " +
                    "liveVideoContentType = :contentType, liveVideoSize = :liveSize, updatedAt = :now, " +
                    "#type = if_not_exists(#type, :type), createdAt = if_not_exists(createdAt, :now)",
                  ExpressionAttributeNames: {
                    "#type": "type",
                  },
                    ExpressionAttributeValues: {
                      ":bucket": { S: body.bucket },
                      ":key": { S: body.key },
                      ":name": { S: body.originalName || "" },
                      ":contentType": { S: resolvedContentType },
                      ":liveSize": { N: String(reservedSize) },
                      ":now": { S: now },
                      ":type": { S: "PHOTO" },
                    },
                  },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: {
                    email: { S: normalizedUser },
                    sk: { S: "PROFILE" },
                  },
                  UpdateExpression:
                    "SET quotaBytes = if_not_exists(quotaBytes, :quota), createdAt = if_not_exists(createdAt, :now), updatedAt = :now " +
                    "ADD usedBytes :size, photoBytes :size, reservedBytes :negSize",
                  ConditionExpression: "reservedBytes >= :size",
                  ExpressionAttributeValues: {
                    ":quota": { N: String(DEFAULT_QUOTA_BYTES) },
                    ":now": { S: now },
                    ":size": { N: String(reservedSize) },
                    ":negSize": { N: String(-reservedSize) },
                  },
                },
              },
            ],
          }),
        );
      } else {
        const hashSk = mediaType === "PHOTO" ? `HASH#PHOTO#${contentHash}` : `HASH#${contentHash}`;
        await ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: tableName,
                  Key: {
                    email: { S: normalizedUser },
                    sk: { S: reserveSk },
                  },
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    email: { S: normalizedUser },
                    sk: { S: hashSk },
                    mediaId: { S: mediaId },
                    type: { S: mediaType },
                    createdAt: { S: now },
                  },
                  ConditionExpression: "attribute_not_exists(sk)",
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    email: { S: normalizedUser },
                    sk: { S: sk },
                    ...(mediaType === "PHOTO"
                      ? { photoId: { S: mediaId } }
                      : { videoId: { S: mediaId } }),
                    type: { S: mediaType },
                    originalBucket: { S: body.bucket },
                    originalKey: { S: body.key },
                    originalName: { S: body.originalName || "" },
                    contentType: { S: resolvedContentType },
                    size: { N: String(reservedSize) },
                    status: { S: "READY" },
                    contentHash: { S: contentHash || "" },
                    ...(fileLastModified ? { fileLastModified: { S: fileLastModified } } : {}),
                    createdAt: { S: createdAt },
                    updatedAt: { S: now },
                  },
                  ConditionExpression: "attribute_not_exists(sk)",
                },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: {
                    email: { S: normalizedUser },
                    sk: { S: "PROFILE" },
                  },
                  UpdateExpression:
                    "SET quotaBytes = if_not_exists(quotaBytes, :quota), createdAt = if_not_exists(createdAt, :now), updatedAt = :now " +
                    "ADD usedBytes :size, #bytesType :size, reservedBytes :negSize, #count :one",
                  ConditionExpression: "reservedBytes >= :size",
                  ExpressionAttributeNames: {
                    "#count": mediaType === "PHOTO" ? "photoCount" : "videosCount",
                    "#bytesType": mediaType === "PHOTO" ? "photoBytes" : "videoBytes",
                  },
                  ExpressionAttributeValues: {
                    ":quota": { N: String(DEFAULT_QUOTA_BYTES) },
                    ":now": { S: now },
                    ":size": { N: String(reservedSize) },
                    ":negSize": { N: String(-reservedSize) },
                    ":one": { N: "1" },
                  },
                },
              },
            ],
          }),
        );
      }
    } catch (error: any) {
      try {
        await ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: tableName,
                  Key: {
                    email: { S: normalizedUser },
                    sk: { S: reserveSk },
                  },
                },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: {
                    email: { S: normalizedUser },
                    sk: { S: "PROFILE" },
                  },
                  UpdateExpression:
                    "SET reservedBytes = reservedBytes - :size, updatedAt = :now",
                  ConditionExpression: "reservedBytes >= :size",
                  ExpressionAttributeValues: {
                    ":size": { N: String(reservedSize) },
                    ":now": { S: now },
                  },
                },
              },
            ],
          }),
        );
      } catch (releaseErr) {
        console.warn("[videos/notify] Failed to release reservation", releaseErr);
      }
      if (error?.name === "TransactionCanceledException" && !(mediaType === "PHOTO" && mediaRole === "liveVideo")) {
        return NextResponse.json(
          { error: "Duplicate content", duplicate: true },
          { status: 409 },
        );
      }
      throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[videos/notify] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to enqueue" },
      { status: 500 },
    );
  }
}
