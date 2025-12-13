import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";

const queueUrl =
  process.env.SQS_VIDEO_INGEST_QUEUE_URL;
const region =
  process.env.AWS_REGION ||
  "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;

if (!queueUrl) {
  console.warn("[videos/notify] Missing env SQS_VIDEO_INGEST_QUEUE_URL");
}

const sqs = new SQSClient({ region });
const ddb = new DynamoDBClient({ region });

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

    const body = (await request.json()) as {
      bucket: string;
      key: string;
      originalName?: string;
      contentType?: string;
      size?: number;
      uploadedAt?: string;
    };
    const now = new Date().toISOString();
    const createdAt = body.uploadedAt || now;
    const videoId = body.key?.split("/").pop() || "";

    // 1) 直接落库到单条记录（无 SK），将视频作为列表追加
    await ddb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { email: { S: userId.toLowerCase() } },
        UpdateExpression:
          "SET videos = list_append(if_not_exists(videos, :empty), :vid), updatedAt = :now, createdAt = if_not_exists(createdAt, :now)",
        ExpressionAttributeValues: {
          ":empty": { L: [] },
          ":vid": {
            L: [
              {
                M: {
                  videoId: { S: videoId },
                  originalBucket: { S: body.bucket },
                  originalKey: { S: body.key },
                  originalName: { S: body.originalName || "" },
                  contentType: { S: body.contentType || "" },
                  size: { N: String(body.size || 0) },
                  status: { S: "READY" }, // 简化：直接可用
                  createdAt: { S: createdAt },
                  updatedAt: { S: now },
                },
              },
            ],
          },
          ":now": { S: now },
        },
      }),
    );

    // 2) 可选：仍然入队，供后续转码使用
    if (queueUrl) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            bucket: body.bucket,
            key: body.key,
            userId: userId.toLowerCase(),
            originalName: body.originalName,
            contentType: body.contentType,
            size: body.size,
            uploadedAt: createdAt,
          }),
        }),
      );
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
