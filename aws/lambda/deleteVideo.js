"use strict";

const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const TABLE_NAME = process.env.VIDEOS_TABLE;
const DEFAULT_ORIGINAL_BUCKET = process.env.S3_ORIGINAL_BUCKET;
const DEFAULT_THUMBNAIL_BUCKET = process.env.S3_THUMBNAIL_BUCKET;

const safeNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

exports.handler = async (event) => {
  if (!TABLE_NAME) throw new Error("Missing env VIDEOS_TABLE");
  const records = event.Records || [];

  for (const record of records) {
    try {
      const body = record.body ? JSON.parse(record.body) : {};
      const email = body.email ? String(body.email).toLowerCase() : "";
      const videoId = body.videoId ? String(body.videoId) : "";

      if (!email || !videoId) {
        console.warn("Skipping delete request with missing info", body);
        continue;
      }

      const sk = `VIDEO#${videoId}`;
      const res = await ddb.send(
        new GetItemCommand({
          TableName: TABLE_NAME,
          Key: {
            email: { S: email },
            sk: { S: sk },
          },
        }),
      );

      if (!res.Item) {
        console.warn("Video record not found, skipping", { email, videoId });
        continue;
      }

      const item = unmarshall(res.Item);
      const originalBucket = item.originalBucket || DEFAULT_ORIGINAL_BUCKET;
      const originalKey = item.originalKey;
      const thumbnailBucket = item.thumbnailBucket || DEFAULT_THUMBNAIL_BUCKET;
      const thumbnailKey = item.thumbnailKey;
      const contentHash = item.contentHash;
      const size = safeNumber(item.size);

      if (originalBucket && originalKey) {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: originalBucket,
            Key: originalKey,
          }),
        );
      }

      if (thumbnailBucket && thumbnailKey) {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: thumbnailBucket,
            Key: thumbnailKey,
          }),
        );
      }

      const now = new Date().toISOString();
      const transactItems = [
        {
          Delete: {
            TableName: TABLE_NAME,
            Key: { email: { S: email }, sk: { S: sk } },
            ConditionExpression: "attribute_exists(sk)",
          },
        },
        {
          Update: {
            TableName: TABLE_NAME,
            Key: { email: { S: email }, sk: { S: "PROFILE" } },
            UpdateExpression:
              "SET updatedAt = :now ADD usedBytes :negSize, videosCount :negOne",
            ExpressionAttributeValues: {
              ":now": { S: now },
              ":negSize": { N: String(-size) },
              ":negOne": { N: "-1" },
            },
          },
        },
      ];

      if (contentHash) {
        transactItems.splice(1, 0, {
          Delete: {
            TableName: TABLE_NAME,
            Key: { email: { S: email }, sk: { S: `HASH#${contentHash}` } },
          },
        });
      }

      try {
        await ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: transactItems,
          }),
        );
      } catch (err) {
        if (err?.name === "TransactionCanceledException") {
          console.warn("Delete transaction canceled", err);
        } else {
          throw err;
        }
      }
    } catch (error) {
      console.error("Failed to process delete record", error);
    }
  }

  return { ok: true };
};
