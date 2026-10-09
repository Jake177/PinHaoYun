"use strict";
const { DynamoDBClient, GetItemCommand, QueryCommand, DeleteItemCommand, ScanCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { S3Client, ListObjectsV2Command, ListObjectVersionsCommand, DeleteObjectsCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand } = require("@aws-sdk/client-s3");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { CognitoIdentityProviderClient, AdminDisableUserCommand, AdminUserGlobalSignOutCommand, AdminDeleteUserCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const crypto = require("node:crypto");
const ddb = new DynamoDBClient({}); const s3 = new S3Client({});
const sqs = new SQSClient({}); const cognito = new CognitoIdentityProviderClient({});
const table = process.env.VIDEOS_TABLE; const jobs = process.env.ACCOUNT_DELETIONS_TABLE;
async function ignoreMissing(command) { try { await cognito.send(command); } catch (e) { if (e.name !== "UserNotFoundException") throw e; } }
async function deleteObjects(Bucket, Objects) {
  for (let i = 0; i < Objects.length; i += 1000) {
    const response = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: Objects.slice(i, i + 1000), Quiet: true } }));
    if (response.Errors?.length) throw new Error("Object deletion incomplete");
  }
}
async function purgePrefix(Bucket, Prefix) {
  // Restart each page at the beginning while deleting it: no stale continuation keys.
  while (true) {
    const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket, Prefix, MaxUploads: 1000 }));
    for (const u of uploads.Uploads || []) { try { await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: u.Key, UploadId: u.UploadId })); } catch (e) { if (e.name !== "NoSuchUpload") throw e; } }
    if (!uploads.IsTruncated) break;
  }
  while (true) {
    const versions = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix, MaxKeys: 1000 }));
    const objects = [...(versions.Versions || []), ...(versions.DeleteMarkers || [])].map(v => ({ Key: v.Key, VersionId: v.VersionId }));
    if (!objects.length) break;
    await deleteObjects(Bucket, objects);
  }
  while (true) {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, MaxKeys: 1000 }));
    if (!page.Contents?.length) break;
    await deleteObjects(Bucket, page.Contents.map(o => ({ Key: o.Key })));
  }
}
async function purgeUser(job) {
  const buckets = [process.env.S3_ORIGINAL_BUCKET, process.env.S3_THUMBNAIL_BUCKET, process.env.S3_PROFILE_BUCKET].filter(Boolean);
  for (const bucket of new Set(buckets)) {
    for (const identity of new Set([job.email, encodeURIComponent(job.email)])) {
      for (const prefix of [`photo/${identity}/`, `video/${identity}/`, `profile-signature/${identity}/`]) await purgePrefix(bucket, prefix);
    }
  }
  // Historical records can use paths outside today's conventions. Read their exact
  // object references, restricted to this deployment's private buckets.
  while (true) {
    const page = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: "email = :email", ExpressionAttributeValues: { ":email": { S: job.email } }, ConsistentRead: true }));
    const records = (page.Items || []).map(unmarshall).filter(i => i.sk !== "PROFILE" && i.sk !== "CONSENT");
    for (const item of records) {
      for (const stem of ["original", "originalPhoto", "thumbnail", "liveVideo", "signature"]) {
        const bucket = item[`${stem}Bucket`]; const key = item[`${stem}Key`];
        if (key && buckets.includes(bucket)) await deleteObjects(bucket, [{ Key: key }]);
      }
      await ddb.send(new DeleteItemCommand({ TableName: table, Key: { email: { S: job.email }, sk: { S: item.sk } } }));
    }
    if (!page.LastEvaluatedKey) break;
    // PROFILE and CONSENT are the only retained partition records; deleted pages
    // disappear, so repeating the query eventually reaches the final page.
  }
}
async function processJob(requestId) {
  const response = await ddb.send(new GetItemCommand({ TableName: jobs, Key: { requestId: { S: requestId } }, ConsistentRead: true }));
  if (!response.Item) return;
  const job = unmarshall(response.Item);
  if (job.state === "COMPLETE" || job.nextAttemptAt > Date.now()) return;
  const owner = crypto.randomUUID();
  try {
    await ddb.send(new UpdateItemCommand({ TableName: jobs, Key: { requestId: { S: requestId } }, UpdateExpression: "SET leaseOwner = :owner, leaseUntil = :until", ConditionExpression: "#state <> :done AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":owner": { S: owner }, ":until": { N: String(Date.now() + 930000) }, ":now": { N: String(Date.now()) }, ":done": { S: "COMPLETE" } } }));
  } catch (error) { if (error.name === "ConditionalCheckFailedException") return; throw error; }
  try {
  const profile = await ddb.send(new GetItemCommand({ TableName: table, Key: { email: { S: job.email }, sk: { S: "PROFILE" } }, ConsistentRead: true }));
  if (profile.Item && (profile.Item.deletionRequestId?.S !== requestId || profile.Item.userSub?.S !== job.userSub)) throw new Error("Deletion generation mismatch");
  const identity = { UserPoolId: process.env.COGNITO_USER_POOL_ID, Username: job.username };
  await ignoreMissing(new AdminDisableUserCommand(identity));
  await ignoreMissing(new AdminUserGlobalSignOutCommand(identity));
  if (profile.Item?.stripeSubscriptionId?.S) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("Existing subscription requires billing cancellation configuration");
    const Stripe = require("stripe");
    await new Stripe(process.env.STRIPE_SECRET_KEY).subscriptions.cancel(profile.Item.stripeSubscriptionId.S);
  }
  await purgeUser(job);
  if (!job.quiesced) {
    const seconds = Math.max(process.env.APP_ENV === "production" ? 1800 : 300, Number(process.env.DELETION_QUIESCENCE_SECONDS || 1800));
    await ddb.send(new UpdateItemCommand({ TableName: jobs, Key: { requestId: { S: requestId } }, UpdateExpression: "SET #state = :state, quiesced = :yes, nextAttemptAt = :next", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":state": { S: "CLEANING" }, ":yes": { BOOL: true }, ":next": { N: String(Date.now() + seconds * 1000) } } }));
    await sqs.send(new SendMessageCommand({ QueueUrl: process.env.ACCOUNT_DELETE_QUEUE_URL, MessageBody: JSON.stringify({ requestId }), DelaySeconds: Math.min(seconds, 900) }));
    return;
  }
  await ignoreMissing(new AdminDeleteUserCommand(identity));
  for (const sk of ["CONSENT", "PROFILE"]) await ddb.send(new DeleteItemCommand({ TableName: table, Key: { email: { S: job.email }, sk: { S: sk } } }));
  await ddb.send(new UpdateItemCommand({ TableName: jobs, Key: { requestId: { S: requestId } }, UpdateExpression: "SET #state = :done, completedAt = :now, expiresAt = :ttl REMOVE email, userSub, username, nextAttemptAt, quiesced", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":done": { S: "COMPLETE" }, ":now": { S: new Date().toISOString() }, ":ttl": { N: String(Math.floor(Date.now() / 1000) + 30 * 86400) } } }));
  } finally {
    try { await ddb.send(new UpdateItemCommand({ TableName: jobs, Key: { requestId: { S: requestId } }, UpdateExpression: "REMOVE leaseOwner, leaseUntil", ConditionExpression: "leaseOwner = :owner", ExpressionAttributeValues: { ":owner": { S: owner } } })); }
    catch (error) { if (error.name !== "ConditionalCheckFailedException") console.error("Deletion lease cleanup deferred", { requestId }); }
  }
}
exports.handler = async event => {
  if (!event.Records) {
    let cursor;
    do {
      const page = await ddb.send(new ScanCommand({ TableName: jobs, ExclusiveStartKey: cursor, FilterExpression: "#state <> :done", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":done": { S: "COMPLETE" } } }));
      for (const item of page.Items || []) {
        const job = unmarshall(item);
        if (Date.now() - Date.parse(job.requestedAt) > 86400000) console.error("Account deletion overdue", { requestId: job.requestId });
        if (!job.nextAttemptAt || job.nextAttemptAt <= Date.now()) await sqs.send(new SendMessageCommand({ QueueUrl: process.env.ACCOUNT_DELETE_QUEUE_URL, MessageBody: JSON.stringify({ requestId: job.requestId }) }));
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return;
  }
  const batchItemFailures = [];
  for (const record of event.Records) {
    try { await processJob(JSON.parse(record.body).requestId); }
    catch { console.error("Account deletion retry required"); batchItemFailures.push({ itemIdentifier: record.messageId }); }
  }
  return { batchItemFailures };
};
