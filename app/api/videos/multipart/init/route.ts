import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  S3Client,
  CreateMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import crypto from "node:crypto";
import { decodeIdToken } from "@/app/lib/jwt";
import { normaliseContentType } from "@/app/lib/contentType";

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const ALLOWED_VIDEO_EXT = ["mov", "mp4", "hevc", "m4v"];
const ALLOWED_PHOTO_EXT = ["jpg", "jpeg", "png", "heic", "heif"];
const ALLOWED_LIVE_VIDEO_EXT = ["mov"];

const originalBucket = process.env.S3_ORIGINAL_BUCKET;
const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;

const s3 = new S3Client({ region });
const ddb = new DynamoDBClient({ region });
const DEFAULT_QUOTA_BYTES = 256 * 1024 * 1024 * 1024; // 256GB
const GRACE_BYTES = 1024 * 1024 * 1024; // 1GB
const RESERVE_TTL_SECONDS = 24 * 60 * 60; // 1 day

const sanitizeName = (name: string) =>
  name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);

const fileExt = (name: string) => {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
};

export async function POST(request: Request) {
  try {
    if (!originalBucket) {
      return NextResponse.json(
        { error: "Missing S3 bucket configuration" },
        { status: 500 },
      );
    }
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
      fileName?: string;
      contentType?: string;
      size?: number;
      contentHash?: string;
      mediaType?: "VIDEO" | "PHOTO";
      mediaRole?: "image" | "liveVideo";
      photoId?: string;
    };
    const {
      fileName = "",
      contentType = "application/octet-stream",
      size = 0,
      contentHash,
      mediaType = "VIDEO",
      mediaRole = "image",
      photoId: requestedPhotoId,
    } = body || {};
    const sizeNumber = Number(size || 0);

    if (!contentHash && !(mediaType === "PHOTO" && mediaRole === "liveVideo")) {
      return NextResponse.json(
        { error: "Missing content hash" },
        { status: 400 },
      );
    }

    const ext = fileExt(fileName);
    const isPhoto = mediaType === "PHOTO";
    const isLiveVideo = isPhoto && mediaRole === "liveVideo";
    const resolvedContentType =
      normaliseContentType(contentType, fileName) || "application/octet-stream";
    if (isLiveVideo && !requestedPhotoId?.trim()) {
      return NextResponse.json(
        { error: "Missing photo id for live photo video" },
        { status: 400 },
      );
    }
    const allowedExt = isPhoto
      ? isLiveVideo
        ? ALLOWED_LIVE_VIDEO_EXT
        : ALLOWED_PHOTO_EXT
      : ALLOWED_VIDEO_EXT;
    if (!allowedExt.includes(ext)) {
      return NextResponse.json(
        { error: "Unsupported file type" },
        { status: 400 },
      );
    }
    if (sizeNumber <= 0 || sizeNumber > MAX_BYTES) {
      return NextResponse.json(
        { error: "File too large (max 2GB)" },
        { status: 400 },
      );
    }

    if (!isLiveVideo) {
      const hashSk = isPhoto ? `HASH#PHOTO#${contentHash}` : `HASH#${contentHash}`;
      const existing = await ddb.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            email: { S: normalizedUser },
            sk: { S: hashSk },
          },
        }),
      );
      if (existing.Item) {
        return NextResponse.json({ duplicate: true });
      }
    }

    const safeName = sanitizeName(fileName || `upload.${ext || "mp4"}`);
    const id = isPhoto
      ? (requestedPhotoId?.trim() || crypto.randomUUID())
      : crypto.randomUUID();
    const keyPrefix = isPhoto ? "photo" : "video";
    const keyName = isPhoto && isLiveVideo
      ? `${id}_live.${ext || "mov"}`
      : `${id}_${safeName}`;
    const key = `${keyPrefix}/${normalizedUser}/${keyName}`;
    const mediaId = id;
    if (!mediaId) {
      return NextResponse.json(
        { error: "Invalid key format" },
        { status: 400 },
      );
    }
    const now = new Date().toISOString();

    await ddb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: {
          email: { S: normalizedUser },
          sk: { S: "PROFILE" },
        },
        UpdateExpression:
          "SET quotaBytes = if_not_exists(quotaBytes, :quota), usedBytes = if_not_exists(usedBytes, :zero), reservedBytes = if_not_exists(reservedBytes, :zero), createdAt = if_not_exists(createdAt, :now), updatedAt = :now",
        ExpressionAttributeValues: {
          ":quota": { N: String(DEFAULT_QUOTA_BYTES) },
          ":zero": { N: "0" },
          ":now": { S: now },
        },
      }),
    );

    const profileRes = await ddb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          email: { S: normalizedUser },
          sk: { S: "PROFILE" },
        },
      }),
    );
    const profile = profileRes.Item
      ? (Object.fromEntries(
          Object.entries(profileRes.Item).map(([k, v]) => [
            k,
            v.N ? Number(v.N) : v.S,
          ])
        ) as Record<string, any>)
      : {};
    let usedBytes = Number(profile.usedBytes || 0);
    let reservedBytes = Number(profile.reservedBytes || 0);
    const quotaBytes = Number(profile.quotaBytes || DEFAULT_QUOTA_BYTES);

    if (usedBytes + reservedBytes + sizeNumber > quotaBytes + GRACE_BYTES) {
      return NextResponse.json(
        { error: "Insufficient storage space." },
        { status: 403 },
      );
    }

    const result = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: originalBucket,
        Key: key,
        ContentType: resolvedContentType,
        StorageClass: "INTELLIGENT_TIERING",
      }),
    );

    if (!result.UploadId) {
      return NextResponse.json(
        { error: "Failed to initialize multipart upload" },
        { status: 500 },
      );
    }

    const reserveSk = isPhoto ? `RESERVE#PHOTO#${mediaId}` : `RESERVE#${keyName}`;
    const expiresAt = Math.floor(Date.now() / 1000) + RESERVE_TTL_SECONDS;
    let reserved = false;
    let attempt = 0;
    while (!reserved && attempt < 3) {
      attempt += 1;
      try {
        await ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Update: {
                  TableName: tableName,
                  Key: {
                    email: { S: normalizedUser },
                    sk: { S: "PROFILE" },
                  },
                  UpdateExpression:
                    "SET reservedBytes = reservedBytes + :size, updatedAt = :now",
                  ConditionExpression:
                    "usedBytes = :used AND reservedBytes = :reserved",
                  ExpressionAttributeValues: {
                    ":size": { N: String(sizeNumber) },
                    ":now": { S: now },
                    ":used": { N: String(usedBytes) },
                    ":reserved": { N: String(reservedBytes) },
                  },
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    email: { S: normalizedUser },
                    sk: { S: reserveSk },
                    key: { S: key },
                    size: { N: String(sizeNumber) },
                    createdAt: { S: now },
                    expiresAt: { N: String(expiresAt) },
                    mediaType: { S: isPhoto ? "PHOTO" : "VIDEO" },
                    mediaRole: {
                      S: isPhoto ? (isLiveVideo ? "liveVideo" : "image") : "video",
                    },
                  },
                  ConditionExpression: "attribute_not_exists(sk)",
                },
              },
            ],
          }),
        );
        reserved = true;
      } catch (error: any) {
        if (error?.name !== "TransactionCanceledException") {
          throw error;
        }
        const refresh = await ddb.send(
          new GetItemCommand({
            TableName: tableName,
            Key: {
              email: { S: normalizedUser },
              sk: { S: "PROFILE" },
            },
          }),
        );
        const refreshed = refresh.Item
          ? (Object.fromEntries(
              Object.entries(refresh.Item).map(([k, v]) => [
                k,
                v.N ? Number(v.N) : v.S,
              ])
            ) as Record<string, any>)
          : {};
        usedBytes = Number(refreshed.usedBytes || 0);
        reservedBytes = Number(refreshed.reservedBytes || 0);
        const updatedQuota = Number(refreshed.quotaBytes || DEFAULT_QUOTA_BYTES);
        if (usedBytes + reservedBytes + sizeNumber > updatedQuota + GRACE_BYTES) {
          break;
        }
      }
    }

    if (!reserved) {
      try {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: originalBucket,
            Key: key,
            UploadId: result.UploadId,
          }),
        );
      } catch {
        // ignore abort failure
      }
      return NextResponse.json(
        { error: "Insufficient storage space." },
        { status: 403 },
      );
    }

    return NextResponse.json({
      uploadId: result.UploadId,
      key,
      bucket: originalBucket,
      duplicate: false,
      mediaType: isPhoto ? "PHOTO" : "VIDEO",
      photoId: isPhoto ? mediaId : undefined,
    });
  } catch (error: any) {
    console.error("[multipart/init] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to initialize upload" },
      { status: 500 },
    );
  }
}
