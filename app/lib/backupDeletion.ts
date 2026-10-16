import { DynamoDBClient, GetItemCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { discardUpload } from "../../aws/lambda/uploadCleanup";
import { unmarshall } from "@aws-sdk/util-dynamodb";
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
// Returns true when suppression applies; failed cleanup remains durable and retryable.
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

// Retain a durable, write-fenced reservation until abort and object cleanup succeed.
export async function discardUnconfirmedUpload(email: string, sub: string, key: string, uploadId: string, duplicateOf?: string) {
  const type = key.startsWith("photo/") ? "PHOTO" : "VIDEO";
  const filename = key.split("/").pop()!;
  const id = type === "PHOTO" ? filename.split("_")[0] : filename;
  const reservationKey = { email: { S: email }, sk: { S: type === "PHOTO" ? `RESERVE#PHOTO#${id}` : `RESERVE#${id}` } };
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE!, Key: reservationKey, ConsistentRead: true }));
    const reserve = result.Item;
    if (!reserve || reserve.key?.S !== key || reserve.uploadId?.S !== uploadId || (reserve.ownerSub?.S && reserve.ownerSub.S !== sub)) return false;
    if (Number(reserve.cleanupLeaseUntil?.N) > Date.now()) return false;
    try {
      return await discardUpload({ ddb, s3, table: process.env.VIDEOS_TABLE!, email, sub, reservation: { ...unmarshall(reserve), sk: reservationKey.sk.S }, duplicateOf });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException" || attempt === 2) throw error;
    }
  }
  return false;
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
