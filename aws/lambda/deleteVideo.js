"use strict";
const { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand } = require("@aws-sdk/client-dynamodb");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const ddb = new DynamoDBClient({}); const s3 = new S3Client({});
const table = process.env.VIDEOS_TABLE;
const number = v => Number.isFinite(Number(v)) ? Number(v) : 0;
async function remove(body, sentAt) {
  const email = String(body.email || "").toLowerCase();
  const type = body.mediaType === "PHOTO" || body.photoId ? "PHOTO" : "VIDEO";
  const id = body.mediaId || body.photoId || body.videoId;
  if (!email || !id) return;
  const Key = { email: { S: email }, sk: { S: `${type}#${id}` } };
  for (let attempt = 0; attempt < 5; attempt++) {
    const [record, account] = await Promise.all([
      ddb.send(new GetItemCommand({ TableName: table, Key, ConsistentRead: true })),
      ddb.send(new GetItemCommand({ TableName: table, Key: { email: { S: email }, sk: { S: "PROFILE" } }, ConsistentRead: true })),
    ]);
    if (!record.Item || record.Item.status?.S === "DELETED" || !account.Item) return;
    const item = unmarshall(record.Item), profile = unmarshall(account.Item);
    if (profile.accountStatus && profile.accountStatus !== "ACTIVE") return;
    if (body.userSub && profile.userSub && body.userSub !== profile.userSub) return;
    if (sentAt && sentAt < Date.parse(profile.createdAt || "1970-01-01")) return;
    const reserveKey = { email: { S: email }, sk: { S: type === "PHOTO" ? `RESERVE#PHOTO#${id}` : `RESERVE#${id}` } };
    const reservation = await ddb.send(new GetItemCommand({ TableName: table, Key: reserveKey, ConsistentRead: true }));
    const pending = reservation.Item ? unmarshall(reservation.Item) : null;
    const staticCharged = item.uploadConfirmed === true || (item.uploadConfirmed === undefined && (!pending || pending.mediaRole === "liveVideo"));
    const liveCharged = item.liveUploadConfirmed === true || (item.liveUploadConfirmed === undefined && item.liveVideoKey && (!pending || pending.mediaRole !== "liveVideo"));
    const bytes = (staticCharged ? number(item.size) : 0) + (liveCharged ? number(item.liveVideoSize) : 0);
    const allowed = [process.env.S3_ORIGINAL_BUCKET, process.env.S3_THUMBNAIL_BUCKET, process.env.S3_PROFILE_BUCKET].filter(Boolean);
    for (const [key,bucket] of [[item.originalKey,item.originalBucket || process.env.S3_ORIGINAL_BUCKET],[item.originalPhotoKey,item.originalPhotoBucket || process.env.S3_ORIGINAL_BUCKET],[item.thumbnailKey,item.thumbnailBucket || process.env.S3_THUMBNAIL_BUCKET],[item.liveVideoKey,item.liveVideoBucket || process.env.S3_ORIGINAL_BUCKET]]) {
      if (key && allowed.includes(bucket)) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
    const countField = type === "PHOTO" ? "photoCount" : "videosCount";
    const bytesField = type === "PHOTO" ? "photoBytes" : "videoBytes";
    const updates = [
      // A minimal tombstone stops delayed ingesters from resurrecting this ID.
      // It is removed with all other partition data during account erasure.
      { Put: { TableName: table, Item: { ...Key, status: { S: "DELETED" }, ...(item.contentHash ? { contentHash: { S: item.contentHash } } : {}) }, ConditionExpression: "attribute_exists(sk) AND (attribute_not_exists(#state) OR #state <> :deleted)", ExpressionAttributeNames: { "#state": "status" }, ExpressionAttributeValues: { ":deleted": { S: "DELETED" } } } },
      { Update: { TableName: table, Key: { email: { S: email }, sk: { S: "PROFILE" } }, UpdateExpression: "SET usedBytes = :used, #bytes = :bytes, #count = :count, reservedBytes = :reserved", ConditionExpression: "usedBytes = :before AND (reservedBytes = :reserveBefore OR attribute_not_exists(reservedBytes)) AND (attribute_not_exists(accountStatus) OR accountStatus = :active)", ExpressionAttributeNames: { "#bytes": bytesField, "#count": countField }, ExpressionAttributeValues: { ":used": { N: String(Math.max(0,number(profile.usedBytes)-bytes)) }, ":bytes": { N: String(Math.max(0,number(profile[bytesField])-bytes)) }, ":count": { N: String(Math.max(0,number(profile[countField])-(staticCharged?1:0))) }, ":reserved": { N: String(Math.max(0,number(profile.reservedBytes)-number(pending?.size))) }, ":before": { N: String(number(profile.usedBytes)) }, ":reserveBefore": { N: String(number(profile.reservedBytes)) }, ":active": { S: "ACTIVE" } } } },
    ];
    if (pending) updates.push({ Delete: { TableName: table, Key: reserveKey, ConditionExpression: "attribute_exists(sk)" } });
    if (item.contentHash) updates.push({ Delete: { TableName: table, Key: { email: { S: email }, sk: { S: `${type === "PHOTO" ? "HASH#PHOTO#" : "HASH#"}${item.contentHash}` } } } });
    try { await ddb.send(new TransactWriteItemsCommand({ TransactItems: updates })); return; }
    catch (error) { if (error.name !== "TransactionCanceledException") throw error; }
  }
  throw new Error("Deletion accounting conflict; retry required");
}
exports.handler = async event => {
  for (const record of event.Records || []) await remove(JSON.parse(record.body || "{}"), Number(record.attributes?.SentTimestamp) || 0);
  return { ok: true };
};
