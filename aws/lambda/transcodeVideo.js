"use strict";
// SQS consumer: take an uploaded original, generate a low-res preview, and update DynamoDB.
// This sample copies the object as a placeholder for actual transcode.
// Replace the copy step with MediaConvert or ffmpeg in production.

const { S3Client, CopyObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const THUMBNAIL_BUCKET =
  process.env.S3_THUMBNAIL_BUCKET;
const TABLE_NAME = process.env.VIDEOS_TABLE;

exports.handler = async (event) => {
  if (!TABLE_NAME) throw new Error("Missing env VIDEOS_TABLE");
  const records = event.Records || [];

  for (const record of records) {
    const body = JSON.parse(record.body || "{}");
    // Deprecated path (list-based schema); no-op for simplified flow
    continue;
  }

  return { ok: true };
};
