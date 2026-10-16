import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { CognitoIdentityProviderClient, AdminDisableUserCommand, AdminUserGlobalSignOutCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getSessionUser } from "@/app/lib/sessionUser";
const region = process.env.COGNITO_REGION || "ap-southeast-2";
const ddb = new DynamoDBClient({ region });
const sqs = new SQSClient({ region });
const cognito = new CognitoIdentityProviderClient({ region });
export async function POST(request: Request) {
  const user = await getSessionUser({ allowDeleting: true, allowUnconsented: true });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (body.confirm !== true) return NextResponse.json({ error: "Deletion confirmation required" }, { status: 400 });
  const suppliedId = body.requestId;
  const suppliedReceipt = body.receipt;
  if (suppliedId !== undefined && (typeof suppliedId !== "string" || !/^[0-9a-f-]{36}$/i.test(suppliedId) || typeof suppliedReceipt !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(suppliedReceipt))) return NextResponse.json({ error: "Invalid deletion receipt" }, { status: 400 });
  if (user.profile.accountStatus === "DELETING" && suppliedId === user.profile.deletionRequestId && typeof suppliedReceipt === "string") {
    const prior = await ddb.send(new GetItemCommand({ TableName: process.env.ACCOUNT_DELETIONS_TABLE, Key: { requestId: { S: suppliedId } }, ConsistentRead: true }));
    const hash = crypto.createHash("sha256").update(suppliedReceipt).digest("hex");
    if (prior.Item?.receiptHash?.S === hash) return NextResponse.json({ requestId: suppliedId, receipt: suppliedReceipt, requestedAt: prior.Item.requestedAt.S, deleteBy: prior.Item.deleteBy.S, state: prior.Item.state.S }, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
  const authTime = Number(user.claims.auth_time);
  if (!Number.isFinite(authTime) || Date.now() / 1000 - authTime > 300) return NextResponse.json({ error: "Please sign in again before deleting your account", code: "REAUTHENTICATION_REQUIRED" }, { status: 403 });
  if (user.profile.accountStatus === "DELETING") return NextResponse.json({ error: "Deletion already requested. Use your saved receipt.", code: "ALREADY_DELETING", deleteBy: user.profile.deleteBy }, { status: 409 });
  const queue = process.env.ACCOUNT_DELETE_QUEUE_URL;
  const jobs = process.env.ACCOUNT_DELETIONS_TABLE;
  if (!queue || !jobs) return NextResponse.json({ error: "Account deletion is not configured" }, { status: 503 });
  const requestId = suppliedId || crypto.randomUUID();
  const receipt = suppliedReceipt || crypto.randomBytes(32).toString("base64url");
  const requestedAt = new Date().toISOString();
  const deleteBy = new Date(Date.now() + 30 * 86400000).toISOString();
  await ddb.send(new TransactWriteItemsCommand({ TransactItems: [
    { Update: { TableName: process.env.VIDEOS_TABLE!, Key: { email: { S: user.email }, sk: { S: "PROFILE" } },
      UpdateExpression: "SET accountStatus = :deleting, deleteBy = :deadline, deletionRequestId = :id, userSub = :sub",
      ConditionExpression: "attribute_exists(sk) AND (attribute_not_exists(accountStatus) OR accountStatus = :active)",
      ExpressionAttributeValues: { ":deleting": { S: "DELETING" }, ":active": { S: "ACTIVE" }, ":deadline": { S: deleteBy }, ":id": { S: requestId }, ":sub": { S: user.sub } } } },
    { Put: { TableName: jobs, Item: { requestId: { S: requestId }, receiptHash: { S: crypto.createHash("sha256").update(receipt).digest("hex") }, email: { S: user.email }, userSub: { S: user.sub }, username: { S: String(user.claims["cognito:username"] || user.sub) }, state: { S: "PENDING" }, requestedAt: { S: requestedAt }, deleteBy: { S: deleteBy } }, ConditionExpression: "attribute_not_exists(requestId)" } }
  ] }));
  // The durable job exists before any revocation. A scheduled sweeper also enqueues
  // unfinished jobs, so an outage between this transaction and SQS cannot lose it.
  try {
    await cognito.send(new AdminDisableUserCommand({ UserPoolId: process.env.COGNITO_USER_POOL_ID, Username: String(user.claims["cognito:username"] || user.sub) }));
    await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: process.env.COGNITO_USER_POOL_ID, Username: String(user.claims["cognito:username"] || user.sub) }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queue, MessageBody: JSON.stringify({ requestId }) }));
  } catch { console.error("Account deletion dispatch requires retry", { requestId }); }
  return NextResponse.json({ requestId, receipt, requestedAt, deleteBy, state: "PENDING" }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
