import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
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
    const contentHash = body.contentHash;

    if (!contentHash) {
      return NextResponse.json(
        { error: "Missing content hash" },
        { status: 400 },
      );
    }

    const reserveSk = `RESERVE#${videoId}`;
    const reserveRes = await ddb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          email: { S: normalizedUser },
          sk: { S: reserveSk },
        },
      }),
    );

    if (!reserveRes.Item) {
      return NextResponse.json(
        { error: "Upload reservation not found" },
        { status: 409 },
      );
    }

    const reserve = unmarshall(reserveRes.Item) as Record<string, any>;
    const reservedSize = Number(reserve.size || 0);
    if (!reservedSize || reservedSize <= 0) {
      return NextResponse.json(
        { error: "Invalid reservation size" },
        { status: 409 },
      );
    }
    if (reserve.key && reserve.key !== body.key) {
      return NextResponse.json(
        { error: "Reservation mismatch" },
        { status: 409 },
      );
    }

    try {
      // 写哈希锁 + 视频记录 + Profile 统计（原子事务）
      await ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Delete: {
                TableName: tableName,
                Key: {
                  email: { S: normalizedUser },
                  sk: { S: reserveSk },
                },
              },
            },
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
                  size: { N: String(reservedSize) },
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
                  "SET quotaBytes = if_not_exists(quotaBytes, :quota), createdAt = if_not_exists(createdAt, :now), updatedAt = :now ADD usedBytes :size, reservedBytes :negSize, videosCount :one",
                ConditionExpression: "reservedBytes >= :size",
                ExpressionAttributeValues: {
                  ":quota": { N: String(DEFAULT_QUOTA_BYTES) },
                  ":now": { S: now },
                  ":size": { N: String(reservedSize) },
                  ":negSize": { N: String(-reservedSize) },
                  ":one": { N: "1" },
                },
              },
            },
          ],
        }),
      );
    } catch (error: any) {
      try {
        await ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: tableName,
                  Key: {
                    email: { S: normalizedUser },
                    sk: { S: reserveSk },
                  },
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
                    "SET reservedBytes = reservedBytes - :size, updatedAt = :now",
                  ConditionExpression: "reservedBytes >= :size",
                  ExpressionAttributeValues: {
                    ":size": { N: String(reservedSize) },
                    ":now": { S: now },
                  },
                },
              },
            ],
          }),
        );
      } catch (releaseErr) {
        console.warn("[videos/notify] Failed to release reservation", releaseErr);
      }
      if (error?.name === "TransactionCanceledException") {
        return NextResponse.json(
          { error: "Duplicate content", duplicate: true },
          { status: 409 },
        );
      }
      throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[videos/notify] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to enqueue" },
      { status: 500 },
    );
  }
}
