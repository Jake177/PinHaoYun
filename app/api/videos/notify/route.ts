import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";

const region = process.env.AWS_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;

const ddb = new DynamoDBClient({ region });
const DEFAULT_QUOTA_BYTES = 256 * 1024 * 1024 * 1024; // 256GB

export async function POST(request: Request) {
  try {
    if (!tableName) {
      return NextResponse.json(
        { error: "Missing table configuration" },
        { status: 500 },
      );
    }
    const cookieStore = await cookies();
    const token = cookieStore.get("id_token")?.value;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const payload = decodeIdToken(token) as Record<string, unknown>;
    const userId =
      (payload.email as string) ||
      (payload["cognito:username"] as string) ||
      (payload.sub as string);
    if (!userId) {
      return NextResponse.json({ error: "Missing user id" }, { status: 401 });
    }
    const normalizedUser = userId.toLowerCase();

    const body = (await request.json()) as {
      bucket: string;
      key: string;
      originalName?: string;
      contentType?: string;
      size?: number;
      uploadedAt?: string;
      contentHash?: string;
    };
    const now = new Date().toISOString();
    const createdAt = body.uploadedAt || now;
    const videoId = body.key?.split("/").pop() || "";
    const sk = `VIDEO#${videoId}`;
    const sizeNumber = Number(body.size || 0);
    const contentHash = body.contentHash;

    if (!contentHash) {
      return NextResponse.json(
        { error: "Missing content hash" },
        { status: 400 },
      );
    }

    // 写哈希锁 + 视频记录 + Profile 统计（原子事务）
    await ddb.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                email: { S: normalizedUser },
                sk: { S: `HASH#${contentHash}` },
                videoId: { S: videoId },
                createdAt: { S: now },
              },
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                email: { S: normalizedUser },
                sk: { S: sk },
                videoId: { S: videoId },
                originalBucket: { S: body.bucket },
                originalKey: { S: body.key },
                originalName: { S: body.originalName || "" },
                contentType: { S: body.contentType || "" },
                size: { N: String(sizeNumber) },
                status: { S: "READY" },
                contentHash: { S: contentHash },
                createdAt: { S: createdAt },
                updatedAt: { S: now },
              },
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: {
                email: { S: normalizedUser },
                sk: { S: "PROFILE" },
              },
              UpdateExpression:
                "SET quotaBytes = if_not_exists(quotaBytes, :quota), createdAt = if_not_exists(createdAt, :now), updatedAt = :now ADD usedBytes :size, videosCount :one",
              ExpressionAttributeValues: {
                ":quota": { N: String(DEFAULT_QUOTA_BYTES) },
                ":now": { S: now },
                ":size": { N: String(sizeNumber) },
                ":one": { N: "1" },
              },
            },
          },
        ],
      }),
    );

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error?.name === "TransactionCanceledException") {
      return NextResponse.json(
        { error: "Duplicate content", duplicate: true },
        { status: 409 },
      );
    }
    console.error("[videos/notify] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to enqueue" },
      { status: 500 },
    );
  }
}
