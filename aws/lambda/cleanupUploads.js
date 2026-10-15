"use strict";
const { DynamoDBClient, ScanCommand, QueryCommand, GetItemCommand, UpdateItemCommand, TransactWriteItemsCommand } = require("@aws-sdk/client-dynamodb");
const { S3Client, AbortMultipartUploadCommand, HeadObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const sqs = new SQSClient({});
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const ddb = new DynamoDBClient({}); const s3 = new S3Client({});
async function keepCompleted(table, profile, r) {
  if (r.cleanupPending) return false;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_ORIGINAL_BUCKET, Key: r.key }));
    const owner = r.ownerSub || profile.userSub;
    if (head.ContentLength !== Number(r.size) || (owner && head.Metadata?.["owner-sub"] !== owner)) return false;
    await ddb.send(new UpdateItemCommand({ TableName: table, Key: { email: { S: profile.email }, sk: { S: r.sk } }, UpdateExpression: "SET expiresAt = :expires", ConditionExpression: "#key = :key AND uploadId = :upload AND attribute_not_exists(cleanupPending)", ExpressionAttributeNames: { "#key": "key" }, ExpressionAttributeValues: { ":expires": { N: String(Math.floor(Date.now() / 1000) + 86400) }, ":key": { S: r.key }, ":upload": { S: r.uploadId } } }));
    return true;
  } catch (error) {
    if (["NotFound", "NoSuchKey", "ConditionalCheckFailedException"].includes(error.name) || error.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}
async function discardExpired(table, profile, r) {
  const live = r.mediaRole === "liveVideo";
  const type = r.sk.startsWith("RESERVE#PHOTO#") ? "PHOTO" : "VIDEO";
  const id = r.sk.slice(type === "PHOTO" ? "RESERVE#PHOTO#".length : "RESERVE#".length);
  const Key = { email: { S: profile.email }, sk: { S: `${type}#${id}` } };
  const reservationKey = { email: { S: profile.email }, sk: { S: r.sk } };
  const marker = live ? "liveUploadConfirmed" : "uploadConfirmed";
  const mediaValues = { ":no": { BOOL: false }, ...(live ? { ":key": { S: r.key }, ":bucket": { S: process.env.S3_ORIGINAL_BUCKET } } : { ":deleted": { S: "DELETED" } }) };
  // Fence finalizers and processors first, but retain the reservation, its quota
  // and object references until S3 cleanup succeeds. Removing TTL makes retries durable.
  await ddb.send(new TransactWriteItemsCommand({ TransactItems: [
    { Update: { TableName: table, Key: reservationKey, UpdateExpression: "SET cleanupPending = :yes REMOVE expiresAt", ConditionExpression: "#key = :key AND uploadId = :upload", ExpressionAttributeNames: { "#key": "key" }, ExpressionAttributeValues: { ":yes": { BOOL: true }, ":key": { S: r.key }, ":upload": { S: r.uploadId } } } },
    { Update: { TableName: table, Key, UpdateExpression: live ? "SET rejectedUploadKey = :key, liveVideoKey = :key, liveVideoBucket = :bucket" : "SET #state = :deleted, #marker = :no", ConditionExpression: "(attribute_not_exists(#marker) OR #marker = :no)" + (live ? " AND (attribute_not_exists(liveVideoKey) OR liveVideoKey = :key)" : ""), ExpressionAttributeNames: { "#marker": marker, ...(!live ? { "#state": "status" } : {}) }, ExpressionAttributeValues: mediaValues } },
    { ConditionCheck: { TableName: table, Key: { email: { S: profile.email }, sk: { S: "PROFILE" } }, ConditionExpression: "attribute_exists(sk) AND (attribute_not_exists(accountStatus) OR accountStatus = :active) AND " + (profile.userSub ? "userSub = :sub" : "attribute_not_exists(userSub)"), ExpressionAttributeValues: { ":active": { S: "ACTIVE" }, ...(profile.userSub ? { ":sub": { S: profile.userSub } } : {}) } } },
  ] }));
  // Read after fencing so the last successful processor's thumbnail is included.
  const media = await ddb.send(new GetItemCommand({ TableName: table, Key, ConsistentRead: true }));
  const item = media.Item ? unmarshall(media.Item) : {};
  await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_ORIGINAL_BUCKET, Key: r.key }));
  if (!live && item.thumbnailKey && item.thumbnailBucket === process.env.S3_THUMBNAIL_BUCKET) await s3.send(new DeleteObjectCommand({ Bucket: item.thumbnailBucket, Key: item.thumbnailKey }));
  await ddb.send(new TransactWriteItemsCommand({ TransactItems: [
    { Delete: { TableName: table, Key: reservationKey, ConditionExpression: "#key = :key AND uploadId = :upload AND cleanupPending = :yes", ExpressionAttributeNames: { "#key": "key" }, ExpressionAttributeValues: { ":key": { S: r.key }, ":upload": { S: r.uploadId }, ":yes": { BOOL: true } } } },
    ...(live ? [{ Update: { TableName: table, Key, UpdateExpression: "REMOVE liveVideoKey, liveVideoBucket, liveVideoSize", ConditionExpression: "rejectedUploadKey = :key AND (attribute_not_exists(#marker) OR #marker = :no)", ExpressionAttributeNames: { "#marker": marker }, ExpressionAttributeValues: { ":key": { S: r.key }, ":no": { BOOL: false } } } }] : [{ Put: { TableName: table, Item: { ...Key, status: { S: "DELETED" }, uploadConfirmed: { BOOL: false } }, ConditionExpression: "#state = :deleted AND #marker = :no", ExpressionAttributeNames: { "#state": "status", "#marker": marker }, ExpressionAttributeValues: { ":deleted": { S: "DELETED" }, ":no": { BOOL: false } } } }]),
  ] }));
}
exports.handler = async () => {
  const table = process.env.VIDEOS_TABLE; let cursor;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: cursor, FilterExpression: "sk = :profile", ExpressionAttributeValues: { ":profile": { S: "PROFILE" } } }));
    for (const raw of page.Items || []) {
      const profile = unmarshall(raw);
      if (profile.accountStatus && profile.accountStatus !== "ACTIVE") continue;
      let deletionCursor;
      do {
        const deleting = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: "email = :email", FilterExpression: "#state = :deleting", ExpressionAttributeNames: { "#state": "status" }, ExpressionAttributeValues: { ":email": { S: profile.email }, ":deleting": { S: "DELETING" } }, ConsistentRead: true, ExclusiveStartKey: deletionCursor }));
        for (const rawMedia of deleting.Items || []) {
          const media = unmarshall(rawMedia), [mediaType, ...parts] = media.sk.split("#");
          if (["PHOTO", "VIDEO"].includes(mediaType)) await sqs.send(new SendMessageCommand({ QueueUrl: process.env.VIDEOS_DELETE_QUEUE_URL, MessageBody: JSON.stringify({ email: profile.email, mediaId: parts.join("#"), mediaType, userSub: profile.userSub }) }));
        }
        deletionCursor = deleting.LastEvaluatedKey;
      } while (deletionCursor);
      let total = 0, stable = true;
      let reservationCursor;
      do {
        const fresh = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: "email = :email AND begins_with(sk, :reserve)", ExpressionAttributeValues: { ":email": { S: profile.email }, ":reserve": { S: "RESERVE#" } }, ConsistentRead: true, ExclusiveStartKey: reservationCursor }));
        for (const item of fresh.Items || []) {
          const r = unmarshall(item);
          if (!r.cleanupPending && r.expiresAt > Date.now() / 1000) { total += Number(r.size || 0); continue; }
          // Completed originals must survive suspension before API finalization.
          // Their quota remains reserved until completion or explicit cancellation.
          if (r.key && await keepCompleted(table, profile, r)) { total += Number(r.size || 0); continue; }
          if (r.uploadId && r.key) {
            try { await s3.send(new AbortMultipartUploadCommand({ Bucket: process.env.S3_ORIGINAL_BUCKET, Key: r.key, UploadId: r.uploadId })); }
            catch (e) {
              if (e.name !== "NoSuchUpload") throw e;
              if (await keepCompleted(table, profile, r)) { total += Number(r.size || 0); continue; }
            }
          }
          try { await discardExpired(table, profile, r); }
          catch (error) { if (error.name !== "TransactionCanceledException") throw error; stable = false; }
        }
        reservationCursor = fresh.LastEvaluatedKey;
      } while (reservationCursor);
      if (!stable) continue;
      try {
        await ddb.send(new UpdateItemCommand({ TableName: table, Key: { email: { S: profile.email }, sk: { S: "PROFILE" } }, UpdateExpression: "SET reservedBytes = :total", ConditionExpression: "attribute_exists(sk) AND reservedBytes = :before AND usedBytes = :used AND (attribute_not_exists(accountStatus) OR accountStatus = :active) AND " + (profile.userSub ? "userSub = :sub" : "attribute_not_exists(userSub)"), ExpressionAttributeValues: { ":total": { N: String(total) }, ":before": { N: String(profile.reservedBytes || 0) }, ":used": { N: String(profile.usedBytes || 0) }, ":active": { S: "ACTIVE" }, ...(profile.userSub ? { ":sub": { S: profile.userSub } } : {}) } }));
      } catch (e) { if (e.name !== "ConditionalCheckFailedException") throw e; }
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
};
