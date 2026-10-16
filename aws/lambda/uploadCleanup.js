"use strict";
const { GetItemCommand, UpdateItemCommand, TransactWriteItemsCommand } = require("@aws-sdk/client-dynamodb");
const { AbortMultipartUploadCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { randomUUID } = require("node:crypto");

// Cancellation, suppression, deduplication and scheduled cleanup share this
// protocol: fence writes, retain references/quota, delete S3 data, then release.
exports.discardUpload = async ({ ddb, s3, table, email, sub, reservation: r, duplicateOf, releaseQuota = true }) => {
  if (r.ownerSub && sub && r.ownerSub !== sub) return false;
  const live = r.mediaRole === "liveVideo";
  const type = r.sk.startsWith("RESERVE#PHOTO#") ? "PHOTO" : "VIDEO";
  const id = r.sk.slice(type === "PHOTO" ? "RESERVE#PHOTO#".length : "RESERVE#".length);
  const Key = { email: { S: email }, sk: { S: `${type}#${id}` } };
  const reservationKey = { email: { S: email }, sk: { S: r.sk } };
  const marker = live ? "liveUploadConfirmed" : "uploadConfirmed";
  const owner = randomUUID(), now = Date.now();
  const profileCondition = "attribute_exists(sk) AND (attribute_not_exists(accountStatus) OR accountStatus = :active) AND " + (sub ? "(attribute_not_exists(userSub) OR userSub = :sub)" : "attribute_not_exists(userSub)");
  const profileValues = { ":active": { S: "ACTIVE" }, ...(sub ? { ":sub": { S: sub } } : {}) };
  const mediaValues = { ":no": { BOOL: false }, ...(live ? { ":key": { S: r.key }, ":bucket": { S: process.env.S3_ORIGINAL_BUCKET } } : { ":deleted": { S: "DELETED" }, ...(duplicateOf ? { ":duplicate": { S: duplicateOf } } : {}) }) };
  try {
    // Only one cleaner may touch this upload. A crashed invocation can be taken
    // over after 15.5 minutes; a handled failure releases its lock immediately.
    await ddb.send(new TransactWriteItemsCommand({ TransactItems: [
      { Update: { TableName: table, Key: reservationKey, UpdateExpression: "SET cleanupPending = :yes, cleanupOwner = :owner, cleanupLeaseUntil = :until REMOVE expiresAt", ConditionExpression: "#key = :key AND uploadId = :upload AND (attribute_not_exists(cleanupOwner) OR cleanupLeaseUntil < :now)", ExpressionAttributeNames: { "#key": "key" }, ExpressionAttributeValues: { ":yes": { BOOL: true }, ":key": { S: r.key }, ":upload": { S: r.uploadId }, ":owner": { S: owner }, ":until": { N: String(now + 930000) }, ":now": { N: String(now) } } } },
      { Update: { TableName: table, Key, UpdateExpression: live ? "SET rejectedUploadKey = :key, liveVideoKey = :key, liveVideoBucket = :bucket" : `SET #state = :deleted, #marker = :no${duplicateOf ? ", duplicateOf = :duplicate" : ""}`, ConditionExpression: "(attribute_not_exists(#marker) OR #marker = :no)" + (live ? " AND (attribute_not_exists(liveVideoKey) OR liveVideoKey = :key)" : ""), ExpressionAttributeNames: { "#marker": marker, ...(!live ? { "#state": "status" } : {}) }, ExpressionAttributeValues: mediaValues } },
      { ConditionCheck: { TableName: table, Key: { email: { S: email }, sk: { S: "PROFILE" } }, ConditionExpression: profileCondition, ExpressionAttributeValues: profileValues } },
    ] }));
    // Read after fencing: keep the last processor's references across any retry.
    const media = await ddb.send(new GetItemCommand({ TableName: table, Key, ConsistentRead: true }));
    const item = media.Item ? unmarshall(media.Item) : {};
    try { await s3.send(new AbortMultipartUploadCommand({ Bucket: process.env.S3_ORIGINAL_BUCKET, Key: r.key, UploadId: r.uploadId })); }
    catch (error) { if (error.name !== "NoSuchUpload") throw error; }
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_ORIGINAL_BUCKET, Key: r.key }));
    if (!live && process.env.S3_THUMBNAIL_BUCKET) {
      const keys = new Set([`${type === "PHOTO" ? "photo" : "video"}/${type === "PHOTO" ? email : encodeURIComponent(email)}/${id}.jpg`]);
      if (item.thumbnailKey && item.thumbnailBucket === process.env.S3_THUMBNAIL_BUCKET) keys.add(item.thumbnailKey);
      for (const key of keys) await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_THUMBNAIL_BUCKET, Key: key }));
    }
    const duplicate = item.duplicateOf || duplicateOf;
    await ddb.send(new TransactWriteItemsCommand({ TransactItems: [
      { Delete: { TableName: table, Key: reservationKey, ConditionExpression: "#key = :key AND uploadId = :upload AND cleanupOwner = :owner", ExpressionAttributeNames: { "#key": "key" }, ExpressionAttributeValues: { ":key": { S: r.key }, ":upload": { S: r.uploadId }, ":owner": { S: owner } } } },
      ...(live ? [{ Update: { TableName: table, Key, UpdateExpression: "REMOVE liveVideoKey, liveVideoBucket, liveVideoSize", ConditionExpression: "rejectedUploadKey = :key AND (attribute_not_exists(#marker) OR #marker = :no)", ExpressionAttributeNames: { "#marker": marker }, ExpressionAttributeValues: { ":key": { S: r.key }, ":no": { BOOL: false } } } }] : [{ Put: { TableName: table, Item: { ...Key, status: { S: "DELETED" }, uploadConfirmed: { BOOL: false }, ...(duplicate ? { duplicateOf: { S: duplicate } } : {}) }, ConditionExpression: "#state = :deleted AND #marker = :no", ExpressionAttributeNames: { "#state": "status", "#marker": marker }, ExpressionAttributeValues: { ":deleted": { S: "DELETED" }, ":no": { BOOL: false } } } }]),
      ...(releaseQuota ? [{ Update: { TableName: table, Key: { email: { S: email }, sk: { S: "PROFILE" } }, UpdateExpression: "ADD reservedBytes :negative", ConditionExpression: `${profileCondition} AND reservedBytes >= :size`, ExpressionAttributeValues: { ...profileValues, ":size": { N: String(r.size) }, ":negative": { N: String(-r.size) } } } }] : []),
    ] }));
    return true;
  } finally {
    try { await ddb.send(new UpdateItemCommand({ TableName: table, Key: reservationKey, UpdateExpression: "REMOVE cleanupOwner, cleanupLeaseUntil", ConditionExpression: "cleanupOwner = :owner", ExpressionAttributeValues: { ":owner": { S: owner } } })); }
    catch (error) { if (error.name !== "ConditionalCheckFailedException") console.error("Upload cleanup lock release deferred", { sk: r.sk }); }
  }
};
