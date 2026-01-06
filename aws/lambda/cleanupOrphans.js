"use strict";

const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const TABLE_NAME = process.env.VIDEOS_TABLE;
const ORIGINAL_BUCKET = process.env.S3_ORIGINAL_BUCKET;
const THUMBNAIL_BUCKET = process.env.S3_THUMBNAIL_BUCKET;
const PREFIX = process.env.CLEANUP_PREFIX || "video/";
const MAX_KEYS = Number(process.env.CLEANUP_MAX_KEYS || "1000");
const PAGE_SIZE = Math.min(Math.max(Number(process.env.CLEANUP_PAGE_SIZE || "250"), 1), 1000);

const decodeKey = (value) => {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, " "));
  } catch {
    return String(value);
  }
};

const toThumbKey = (userId, videoId) =>
  `video/${encodeURIComponent(userId)}/${videoId}.jpg`;

const hasVideoRecord = async (email, videoId) => {
  const res = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        email: { S: email },
        sk: { S: `VIDEO#${videoId}` },
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

exports.handler = async () => {
  if (!TABLE_NAME) throw new Error("Missing env VIDEOS_TABLE");
  if (!ORIGINAL_BUCKET) throw new Error("Missing env S3_ORIGINAL_BUCKET");

  let continuationToken;
  let scanned = 0;
  let deleted = 0;
  let skipped = 0;

  while (true) {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: ORIGINAL_BUCKET,
        Prefix: PREFIX,
        MaxKeys: PAGE_SIZE,
        ContinuationToken: continuationToken,
      }),
    );

    const objects = res.Contents || [];
    for (const obj of objects) {
      if (!obj.Key) continue;
      if (scanned >= MAX_KEYS) {
        return { ok: true, scanned, deleted, skipped, truncated: true };
      }

      scanned += 1;
      const decodedKey = decodeKey(obj.Key);
      const parts = decodedKey.split("/");
      if (parts.length < 3) {
        skipped += 1;
        continue;
      }

      const userId = parts[1].toLowerCase();
      const videoId = parts[parts.length - 1];
      if (!userId || !videoId) {
        skipped += 1;
        continue;
      }

      const exists = await hasVideoRecord(userId, videoId);
      if (exists) {
        continue;
      }

      await deleteObject(ORIGINAL_BUCKET, decodedKey);
      if (THUMBNAIL_BUCKET) {
        const thumbKey = toThumbKey(userId, videoId);
        await deleteObject(THUMBNAIL_BUCKET, thumbKey);
      }
      deleted += 1;
    }

    if (!res.IsTruncated || !res.NextContinuationToken) break;
    continuationToken = res.NextContinuationToken;
  }

  return { ok: true, scanned, deleted, skipped };
};
