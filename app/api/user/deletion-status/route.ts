import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
const ddb = new DynamoDBClient({ region: process.env.COGNITO_REGION || "ap-southeast-2" });
export async function POST(request: Request) {
  const { requestId, receipt } = await request.json().catch(() => ({}));
  if (typeof requestId !== "string" || typeof receipt !== "string" || receipt.length !== 43 || requestId.length > 64) return NextResponse.json({ error: "Invalid receipt" }, { status: 400 });
  const result = await ddb.send(new GetItemCommand({ TableName: process.env.ACCOUNT_DELETIONS_TABLE, Key: { requestId: { S: requestId } }, ConsistentRead: true }));
  const expected = result.Item?.receiptHash?.S;
  const actual = crypto.createHash("sha256").update(receipt).digest("hex");
  if (!expected || expected.length !== actual.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) return NextResponse.json({ error: "Receipt not found" }, { status: 404 });
  return NextResponse.json({ state: result.Item?.state?.S, requestedAt: result.Item?.requestedAt?.S, deleteBy: result.Item?.deleteBy?.S, completedAt: result.Item?.completedAt?.S || null }, { headers: { "Cache-Control": "no-store" } });
}
