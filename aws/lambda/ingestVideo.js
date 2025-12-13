"use strict";
// SQS consumer: persist video metadata to DynamoDB after upload.
// Expected SQS message body:
// {
//   "bucket": "pinhaoyun-original",
//   "key": "video/<userId>/<uuid>_filename.mov",
//   "userId": "user@example.com",
//   "originalName": "filename.mov",
//   "contentType": "video/quicktime",
//   "size": 123456,
//   "uploadedAt": "2024-01-01T00:00:00.000Z"
// }

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.VIDEOS_TABLE;

exports.handler = async (event) => {
  if (!TABLE_NAME) throw new Error("Missing env VIDEOS_TABLE");
  const records = event.Records || [];

  for (const record of records) {
    const body = JSON.parse(record.body || "{}");
    const {
      bucket,
      key,
      userId,
      originalName = "",
      contentType = "",
      size = 0,
      uploadedAt,
    } = body;

    if (!bucket || !key || !userId) {
      console.warn("Skipping record with missing fields", record.body);
      continue;
    }

    const videoId = key.split("/").pop();
    const now = new Date().toISOString();
    const createdAt = uploadedAt || now;

    await ddb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          email: { S: userId.toLowerCase() },
          videos: {
            L: [
              {
                M: {
                  videoId: { S: videoId || "" },
                  originalBucket: { S: bucket },
                  originalKey: { S: key },
                  originalName: { S: originalName },
                  contentType: { S: contentType },
                  size: { N: String(size || 0) },
                  status: { S: "READY" },
                  createdAt: { S: createdAt },
                  updatedAt: { S: now },
                },
              },
            ],
          },
          createdAt: { S: createdAt },
          updatedAt: { S: now },
        },
      }),
    );
  }

  return { ok: true };
};
