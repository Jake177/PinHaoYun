"use strict";

const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const TABLE_NAME = process.env.VIDEOS_TABLE;
const ORIGINAL_BUCKET = process.env.S3_ORIGINAL_BUCKET;
const THUMBNAIL_BUCKET = process.env.S3_THUMBNAIL_BUCKET;
// Comma-separated prefixes, e.g., "video/,photo/" or just "video/"
const PREFIXES = (process.env.CLEANUP_PREFIX || "video/,photo/").split(",").map((p) => p.trim()).filter(Boolean);
const MAX_KEYS = Number(process.env.CLEANUP_MAX_KEYS || "1000");
const PAGE_SIZE = Math.min(Math.max(Number(process.env.CLEANUP_PAGE_SIZE || "250"), 1), 1000);

const decodeKey = (value) => {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, " "));
  } catch {
    return String(value);
  }
};

const detectMediaType = (key) => {
  const lower = key.toLowerCase();
  if (lower.startsWith("photo/") || lower.includes("/photo/")) return "PHOTO";
  return "VIDEO";
};

const toThumbKey = (mediaType, userId, mediaId) => {
  const prefix = mediaType === "PHOTO" ? "photo" : "video";
  return `${prefix}/${encodeURIComponent(userId)}/${mediaId}.jpg`;
};

// Extract mediaId from filename (handle photo naming: uuid_timestamp.ext or uuid_live.mov)
const extractMediaId = (fileName, mediaType) => {
  if (mediaType === "PHOTO") {
    // Photo files are named: uuid_timestamp.ext or uuid_live.mov
    // Extract the uuid part before the first underscore
    const underscoreIdx = fileName.indexOf("_");
    if (underscoreIdx > 0) {
      return fileName.substring(0, underscoreIdx);
    }
  }
  // Video files use the full filename as the id
  return fileName;
};

const hasMediaRecord = async (email, mediaId, mediaType) => {
  const sk = `${mediaType}#${mediaId}`;
  const res = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        email: { S: email },
        sk: { S: sk },
      },
      ProjectionExpression: "sk",
    }),
  );
  return !!res.Item;
};

const deleteObject = async (bucket, key) => {
  if (!bucket || !key) return;
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
};

const cleanupPrefix = async (prefix, stats) => {
  let continuationToken;

  while (true) {
    if (stats.scanned >= MAX_KEYS) {
      stats.truncated = true;
      return;
    }

    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: ORIGINAL_BUCKET,
        Prefix: prefix,
        MaxKeys: PAGE_SIZE,
        ContinuationToken: continuationToken,
      }),
    );

    const objects = res.Contents || [];
    for (const obj of objects) {
      if (!obj.Key) continue;
      if (stats.scanned >= MAX_KEYS) {
        stats.truncated = true;
        return;
      }

      stats.scanned += 1;
      const decodedKey = decodeKey(obj.Key);
      const parts = decodedKey.split("/");
      if (parts.length < 3) {
        stats.skipped += 1;
        continue;
      }

      const mediaType = detectMediaType(decodedKey);
      const userId = parts[1].toLowerCase();
      const fileName = parts[parts.length - 1];
      const mediaId = extractMediaId(fileName, mediaType);

      if (!userId || !mediaId) {
        stats.skipped += 1;
        continue;
      }

      const exists = await hasMediaRecord(userId, mediaId, mediaType);
      if (exists) {
        continue;
      }

      // Delete original file
      await deleteObject(ORIGINAL_BUCKET, decodedKey);

      // Delete thumbnail (only for main image/video files, not live video companions)
      const isLiveVideo = fileName.includes("_live.") || (mediaType === "PHOTO" && fileName.toLowerCase().endsWith(".mov"));
      if (THUMBNAIL_BUCKET && !isLiveVideo) {
        const thumbKey = toThumbKey(mediaType, userId, mediaId);
        await deleteObject(THUMBNAIL_BUCKET, thumbKey);
      }

      stats.deleted += 1;
      if (mediaType === "PHOTO") {
        stats.deletedPhotos = (stats.deletedPhotos || 0) + 1;
      } else {
        stats.deletedVideos = (stats.deletedVideos || 0) + 1;
      }
    }

    if (!res.IsTruncated || !res.NextContinuationToken) break;
    continuationToken = res.NextContinuationToken;
  }
};

exports.handler = async () => {
  if (!TABLE_NAME) throw new Error("Missing env VIDEOS_TABLE");
  if (!ORIGINAL_BUCKET) throw new Error("Missing env S3_ORIGINAL_BUCKET");

  const stats = {
    scanned: 0,
    deleted: 0,
    deletedVideos: 0,
    deletedPhotos: 0,
    skipped: 0,
    truncated: false,
    prefixes: PREFIXES,
  };

  for (const prefix of PREFIXES) {
    if (stats.truncated) break;
    await cleanupPrefix(prefix, stats);
  }

  return { ok: true, ...stats };
};
