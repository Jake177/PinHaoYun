"use strict";
const { DynamoDBClient, ScanCommand, QueryCommand, UpdateItemCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
const { S3Client, AbortMultipartUploadCommand } = require("@aws-sdk/client-s3");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const sqs = new SQSClient({});
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const ddb = new DynamoDBClient({}); const s3 = new S3Client({});
exports.handler = async () => {
  const table = process.env.VIDEOS_TABLE; let cursor;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: cursor, FilterExpression: "sk = :profile", ExpressionAttributeValues: { ":profile": { S: "PROFILE" } } }));
    for (const raw of page.Items || []) {
      const profile = unmarshall(raw);
      if (profile.accountStatus && profile.accountStatus !== "ACTIVE") continue;
      const deleting = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: "email = :email", FilterExpression: "#state = :deleting", ExpressionAttributeNames: { "#state": "status" }, ExpressionAttributeValues: { ":email": { S: profile.email }, ":deleting": { S: "DELETING" } }, ConsistentRead: true }));
      for (const rawMedia of deleting.Items || []) {
        const media = unmarshall(rawMedia), [mediaType, ...parts] = media.sk.split("#");
        if (["PHOTO", "VIDEO"].includes(mediaType)) await sqs.send(new SendMessageCommand({ QueueUrl: process.env.VIDEOS_DELETE_QUEUE_URL, MessageBody: JSON.stringify({ email: profile.email, mediaId: parts.join("#"), mediaType, userSub: profile.userSub }) }));
      }
      const fresh = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: "email = :email AND begins_with(sk, :reserve)", ExpressionAttributeValues: { ":email": { S: profile.email }, ":reserve": { S: "RESERVE#" } }, ConsistentRead: true }));
      if (fresh.LastEvaluatedKey) continue; // ponytail: skip oversized reservation sets; paginate if an account holds >1MB of reservations.
      let total = 0;
      for (const item of fresh.Items || []) {
        const r = unmarshall(item);
        if (r.expiresAt > Date.now() / 1000) { total += Number(r.size || 0); continue; }
        if (r.uploadId && r.key) {
          try { await s3.send(new AbortMultipartUploadCommand({ Bucket: process.env.S3_ORIGINAL_BUCKET, Key: r.key, UploadId: r.uploadId })); }
          catch (e) { if (e.name !== "NoSuchUpload") throw e; }
        }
        await ddb.send(new DeleteItemCommand({ TableName: table, Key: { email: { S: profile.email }, sk: { S: r.sk } } }));
      }
      try {
        await ddb.send(new UpdateItemCommand({ TableName: table, Key: { email: { S: profile.email }, sk: { S: "PROFILE" } }, UpdateExpression: "SET reservedBytes = :total", ConditionExpression: "reservedBytes = :before AND (attribute_not_exists(accountStatus) OR accountStatus = :active)", ExpressionAttributeValues: { ":total": { N: String(total) }, ":before": { N: String(profile.reservedBytes || 0) }, ":active": { S: "ACTIVE" } } }));
      } catch (e) { if (e.name !== "ConditionalCheckFailedException") throw e; }
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
};
