import { NextResponse } from "next/server";
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
import { getSessionUser } from "@/app/lib/sessionUser";
import { normaliseContentType } from "@/app/lib/contentType";
import {
  DEFAULT_PLAN_CODE,
  getPlanQuotaBytes,
  UPLOAD_GRACE_BYTES,
} from "@/app/lib/plans";
import { resolveProfileBillingState } from "@/app/lib/profileBilling";
import { backupSuppressed, suppressionCheck } from "@/app/lib/backupDeletion";

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const ALLOWED_VIDEO_EXT = ["mov", "mp4", "hevc", "m4v"];
const ALLOWED_PHOTO_EXT = ["jpg", "jpeg", "png", "heic", "heif"];
const ALLOWED_LIVE_VIDEO_EXT = ["mov"];

const originalBucket = process.env.S3_ORIGINAL_BUCKET;
const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;

const s3 = new S3Client({ region });
const ddb = new DynamoDBClient({ region });
const DEFAULT_QUOTA_BYTES = getPlanQuotaBytes(DEFAULT_PLAN_CODE);
const GRACE_BYTES = UPLOAD_GRACE_BYTES;
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

    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const payload = user.claims;
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
      uploadSource?: "manual" | "automatic";
      requestId?: string;
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
    const automatic = body?.uploadSource === "automatic";
    if (body?.requestId !== undefined && (typeof body.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.requestId))) return NextResponse.json({ error: "Invalid upload request id" }, { status: 400 });
    let backupHash = contentHash;
    const skip = () => NextResponse.json({ duplicate: false, skipped: true, skipReason: "CLOUD_DELETED" });
    if (!Number.isSafeInteger(sizeNumber) || !["PHOTO", "VIDEO"].includes(mediaType)) return NextResponse.json({ error: "Invalid upload parameters" }, { status: 400 });

    if (!(mediaType === "PHOTO" && mediaRole === "liveVideo") && (typeof contentHash !== "string" || !/^[a-f0-9]{64}-\d+$/.test(contentHash))) {
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
    if (requestedPhotoId && !/^[a-zA-Z0-9-]{1,128}$/.test(requestedPhotoId)) return NextResponse.json({ error: "Invalid photo id" }, { status: 400 });
    if (isLiveVideo && requestedPhotoId) {
      const parent = await ddb.send(new GetItemCommand({ TableName: tableName, Key: { email: { S: normalizedUser }, sk: { S: `PHOTO#${requestedPhotoId}` } }, ConsistentRead: true }));
      if (!parent.Item || ["DELETING", "DELETED"].includes(parent.Item.status?.S || "")) return automatic ? skip() : NextResponse.json({ error: "Parent photo is not available" }, { status: 409 });
      if (parent.Item.liveUploadConfirmed?.BOOL) return NextResponse.json({ duplicate: true, photoId: requestedPhotoId });
      backupHash = parent.Item.contentHash?.S;
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
    if (!Number.isSafeInteger(sizeNumber) || sizeNumber <= 0 || sizeNumber > MAX_BYTES) {
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
        const target = await ddb.send(new GetItemCommand({ TableName: tableName, Key: { email: { S: normalizedUser }, sk: { S: `${mediaType}#${existing.Item.mediaId?.S}` } }, ConsistentRead: true }));
        if (target.Item && !["DELETING", "DELETED"].includes(target.Item.status?.S || "")) return NextResponse.json({ duplicate: true, photoId: existing.Item.mediaId?.S });
        if (automatic && ["DELETING", "DELETED"].includes(target.Item?.status?.S || "")) return skip();
      }
    }
    if (automatic && (!backupHash || !/^[a-f0-9]{64}-\d+$/.test(backupHash))) return NextResponse.json({ error: "Invalid backup hash" }, { status: 400 });
    if (automatic && await backupSuppressed(normalizedUser, mediaType, backupHash)) return skip();

    const safeName = sanitizeName(fileName || `upload.${ext || "mp4"}`);
    const id = isPhoto
      ? (requestedPhotoId?.trim() || crypto.randomUUID())
      : (body.requestId || crypto.randomUUID());
    const requestId = body.requestId || crypto.randomUUID();
    const keyPrefix = isPhoto ? "photo" : "video";
    const keyName = isPhoto && isLiveVideo
      ? (body.requestId ? `${id}_live-${requestId}.${ext || "mov"}` : `${id}_live.${ext || "mov"}`)
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
    const reserveSk = isPhoto ? `RESERVE#PHOTO#${mediaId}` : `RESERVE#${keyName}`;
    const previous = await ddb.send(new GetItemCommand({ TableName: tableName, Key: { email: { S: normalizedUser }, sk: { S: reserveSk } }, ConsistentRead: true }));
    if (previous.Item) {
      const r = previous.Item;
      const keyMatches = r.key?.S === key || (isLiveVideo && !r.requestId?.S && r.key?.S === `${keyPrefix}/${normalizedUser}/${id}_live.${ext || "mov"}`);
      const matches = keyMatches && Number(r.size?.N) === sizeNumber && (!r.backupHash?.S || r.backupHash.S === backupHash) && (!r.ownerSub?.S || r.ownerSub.S === user.sub) && (r.uploadSource?.S || "manual") === (automatic ? "automatic" : "manual");
      if (matches) return NextResponse.json({ duplicate: false, resumed: true, key: r.key?.S, bucket: originalBucket, uploadId: r.uploadId?.S, photoId: isPhoto ? mediaId : undefined });
      return NextResponse.json({ error: "Another transfer is updating this item. Try again shortly.", code: "UPLOAD_IN_PROGRESS" }, { status: 409 });
    }
    if (!isLiveVideo) {
      const existing = await ddb.send(new GetItemCommand({ TableName: tableName, Key: { email: { S: normalizedUser }, sk: { S: `${mediaType}#${isPhoto ? mediaId : keyName}` } }, ConsistentRead: true }));
      if (existing.Item && (existing.Item.uploadConfirmed?.BOOL || ["DELETING", "DELETED"].includes(existing.Item.status?.S || ""))) return NextResponse.json({ error: "Upload identity is no longer available. Choose this original again." }, { status: 409 });
    }

    await ddb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: {
          email: { S: normalizedUser },
          sk: { S: "PROFILE" },
        },
        UpdateExpression:
          "SET quotaBytes = if_not_exists(quotaBytes, :quota), usedBytes = if_not_exists(usedBytes, :zero), reservedBytes = if_not_exists(reservedBytes, :zero), createdAt = if_not_exists(createdAt, :now), updatedAt = :now",
        ConditionExpression: "attribute_exists(sk) AND (attribute_not_exists(accountStatus) OR accountStatus = :active) AND (attribute_not_exists(userSub) OR userSub = :subject)",
        ExpressionAttributeValues: {
          ":quota": { N: String(DEFAULT_QUOTA_BYTES) },
          ":zero": { N: "0" },
          ":now": { S: now },
          ":active": { S: "ACTIVE" }, ":subject": { S: user.sub },
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
    const quotaBytes = resolveProfileBillingState(profile, new Date(now)).quotaBytes;

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
        Metadata: { "owner-sub": user.sub, "upload-source": automatic ? "automatic" : "manual", "upload-request-id": requestId, ...(backupHash ? { "backup-hash": backupHash } : {}) },
      }),
    );

    if (!result.UploadId) {
      return NextResponse.json(
        { error: "Failed to initialize multipart upload" },
        { status: 500 },
      );
    }

    const expiresAt = Math.floor(Date.now() / 1000) + RESERVE_TTL_SECONDS;
    let reserved = false;
    let attempt = 0;
    while (!reserved && attempt < 3) {
      attempt += 1;
      try {
        await ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              ...(automatic ? [suppressionCheck(normalizedUser, mediaType, backupHash!)] : []),
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
                    "usedBytes = :used AND reservedBytes = :reserved AND (attribute_not_exists(accountStatus) OR accountStatus = :active) AND (attribute_not_exists(userSub) OR userSub = :owner)",
                  ExpressionAttributeValues: {
                    ":size": { N: String(sizeNumber) },
                    ":now": { S: now },
                    ":used": { N: String(usedBytes) },
                    ":reserved": { N: String(reservedBytes) },
                    ":active": { S: "ACTIVE" },
                    ":owner": { S: user.sub },
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
                    uploadId: { S: result.UploadId },
                    createdAt: { S: now },
                    expiresAt: { N: String(expiresAt) },
                    mediaType: { S: isPhoto ? "PHOTO" : "VIDEO" },
                    uploadSource: { S: automatic ? "automatic" : "manual" },
                    ownerSub: { S: user.sub }, requestId: { S: requestId },
                    ...(backupHash ? { backupHash: { S: backupHash } } : {}),
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
        if (automatic && error?.name === "TransactionCanceledException" && await backupSuppressed(normalizedUser, mediaType, backupHash)) {
          await s3.send(new AbortMultipartUploadCommand({ Bucket: originalBucket, Key: key, UploadId: result.UploadId }));
          return skip();
        }
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
        const updatedQuota = resolveProfileBillingState(
          refreshed as Record<string, unknown>,
          new Date(now),
        ).quotaBytes;
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
