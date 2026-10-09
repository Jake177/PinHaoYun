import { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { S3Client, AbortMultipartUploadCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
const region = process.env.COGNITO_REGION || "ap-southeast-2";
const ddb = new DynamoDBClient({ region });
const s3 = new S3Client({ region });
export const suppressionKey = (email: string, type: string, hash: string) => ({ email: { S: email }, sk: { S: `BACKUP_DELETED#${type}#${hash}` } });
export const suppressionCheck = (email: string, type: string, hash: string): TransactWriteItem => ({ ConditionCheck: {
  TableName: process.env.VIDEOS_TABLE!, Key: suppressionKey(email, type, hash), ConditionExpression: "attribute_not_exists(sk)",
} });
export async function backupSuppressed(email: string, type: string, hash?: string) {
  if (!hash) return false;
  const item = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE!, Key: suppressionKey(email, type, hash), ConsistentRead: true }));
  return !!item.Item;
}
// Read the server reservation, never trust a source/hash supplied at completion.
// Returns true after best-effort object cleanup and transactional quota release.
export async function rejectDeletedBackup(email: string, sub: string, key: string) {
  const type = key.startsWith("photo/") ? "PHOTO" : "VIDEO";
  const filename = key.split("/").pop()!;
  const id = type === "PHOTO" ? filename.split("_")[0] : filename;
  const reservationKey = { email: { S: email }, sk: { S: type === "PHOTO" ? `RESERVE#PHOTO#${id}` : `RESERVE#${id}` } };
  const result = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE!, Key: reservationKey, ConsistentRead: true }));
  const reserve = result.Item;
  if (!reserve) {
    const media = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE!, Key: { email: { S: email }, sk: { S: `${type}#${id}` } }, ConsistentRead: true }));
    return ["DELETING", "DELETED"].includes(media.Item?.status?.S || "");
  }
  if (reserve.key?.S !== key || reserve.uploadSource?.S !== "automatic" || !await backupSuppressed(email, type, reserve.backupHash?.S)) return false;
  await discardUnconfirmedUpload(email, sub, key, reserve.uploadId.S!);
  return true;
}

// Invalidate the lease before removing its object; processors fence writes
// against that lease or the already-confirmed resource.
export async function discardUnconfirmedUpload(email: string, sub: string, key: string, uploadId: string, duplicateOf?: string) {
  const type = key.startsWith("photo/") ? "PHOTO" : "VIDEO";
  const filename = key.split("/").pop()!;
  const id = type === "PHOTO" ? filename.split("_")[0] : filename;
  const reservationKey = { email: { S: email }, sk: { S: type === "PHOTO" ? `RESERVE#PHOTO#${id}` : `RESERVE#${id}` } };
  const result = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE!, Key: reservationKey, ConsistentRead: true }));
  const reserve = result.Item;
  if (!reserve || reserve.key?.S !== key || reserve.uploadId?.S !== uploadId || (reserve.ownerSub?.S && reserve.ownerSub.S !== sub)) return false;
  const mediaKey = { email: { S: email }, sk: { S: `${type}#${id}` } };
  const media = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE!, Key: mediaKey, ConsistentRead: true }));
  const live = reserve.mediaRole?.S === "liveVideo";
  const marker = live ? "liveUploadConfirmed" : "uploadConfirmed";
  const size = Number(reserve.size?.N || 0);
  let removed = false;
  for (let attempt = 0; attempt < 3; attempt++) { try {
    await ddb.send(new TransactWriteItemsCommand({ TransactItems: [
      { Delete: { TableName: process.env.VIDEOS_TABLE!, Key: reservationKey, ConditionExpression: "#key = :key AND uploadId = :upload", ExpressionAttributeNames: { "#key": "key" }, ExpressionAttributeValues: { ":key": { S: key }, ":upload": { S: uploadId } } } },
      { Update: { TableName: process.env.VIDEOS_TABLE!, Key: { email: { S: email }, sk: { S: "PROFILE" } }, UpdateExpression: "ADD reservedBytes :negative", ConditionExpression: "attribute_exists(sk) AND reservedBytes >= :size AND (attribute_not_exists(accountStatus) OR accountStatus = :active) AND (attribute_not_exists(userSub) OR userSub = :sub)", ExpressionAttributeValues: { ":negative": { N: String(-size) }, ":size": { N: String(size) }, ":active": { S: "ACTIVE" }, ":sub": { S: sub } } } },
      ...(live ? [{ Update: { TableName: process.env.VIDEOS_TABLE!, Key: mediaKey, UpdateExpression: "REMOVE liveVideoKey, liveVideoBucket, liveVideoSize", ConditionExpression: "attribute_exists(sk) AND (attribute_not_exists(#marker) OR #marker = :no) AND (attribute_not_exists(liveVideoKey) OR liveVideoKey = :key)", ExpressionAttributeNames: { "#marker": marker }, ExpressionAttributeValues: { ":no": { BOOL: false }, ":key": { S: key } } } }] : [{ Put: { TableName: process.env.VIDEOS_TABLE!, Item: { ...mediaKey, status: { S: "DELETED" }, uploadConfirmed: { BOOL: false }, ...(duplicateOf ? { duplicateOf: { S: duplicateOf } } : {}) }, ConditionExpression: "attribute_not_exists(#marker) OR #marker = :no", ExpressionAttributeNames: { "#marker": marker }, ExpressionAttributeValues: { ":no": { BOOL: false } } } }]),
    ] }));
    removed = true; break;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
    const current = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE!, Key: reservationKey, ConsistentRead: true }));
    if (!current.Item || current.Item.key?.S !== key || current.Item.uploadId?.S !== uploadId) break;
    if (attempt === 2) throw error;
  } }
  if (!removed) return false;
  try { await s3.send(new AbortMultipartUploadCommand({ Bucket: process.env.S3_ORIGINAL_BUCKET!, Key: key, UploadId: reserve.uploadId.S! })); }
  catch (error) { if (!(error instanceof Error) || error.name !== "NoSuchUpload") throw error; }
  await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_ORIGINAL_BUCKET!, Key: key }));
  if (!live && media.Item?.thumbnailKey?.S && media.Item.thumbnailBucket?.S === process.env.S3_THUMBNAIL_BUCKET) await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_THUMBNAIL_BUCKET, Key: media.Item.thumbnailKey.S }));
  return true;
}

export async function finalizeConcurrentDuplicate(email: string, sub: string, key: string, contentHash?: string) {
  const type = key.startsWith("photo/") ? "PHOTO" : "VIDEO";
  const filename = key.split("/").pop()!;
  const id = type === "PHOTO" ? filename.split("_")[0] : filename;
  const reservation = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE!, Key: { email: { S: email }, sk: { S: type === "PHOTO" ? `RESERVE#PHOTO#${id}` : `RESERVE#${id}` } }, ConsistentRead: true }));
  const reserve = reservation.Item;
  const hash = reserve?.backupHash?.S || contentHash;
  if (!reserve || reserve.key?.S !== key || reserve.mediaRole?.S === "liveVideo" || !hash) return null;
  const existing = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE!, Key: { email: { S: email }, sk: { S: `${type === "PHOTO" ? "HASH#PHOTO#" : "HASH#"}${hash}` } }, ConsistentRead: true }));
  const targetId = existing.Item?.mediaId?.S;
  if (!targetId || targetId === id) return null;
  const target = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE!, Key: { email: { S: email }, sk: { S: `${type}#${targetId}` } }, ConsistentRead: true }));
  if (!target.Item || target.Item.uploadConfirmed?.BOOL === false || ["DELETING", "DELETED"].includes(target.Item.status?.S || "")) return null;
  return await discardUnconfirmedUpload(email, sub, key, reserve.uploadId.S!, targetId) ? targetId : null;
}
