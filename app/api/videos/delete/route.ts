import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const awsAccountId = process.env.ACCOUNT_ID || "883086653724";
const deleteQueueName = process.env.DELETE_QUEUE_NAME || "pinhaoyun_delete_video_sqs";

const ddb = new DynamoDBClient({ region });
const sqs = new SQSClient({ region });

// 构建 SQS URL，避免直接存储完整 URL 的环境变量问题
function buildSqsUrl(queueName: string): string {
  return `https://sqs.${region}.amazonaws.com/${awsAccountId}/${queueName}`;
}

export async function POST(request: Request) {
  try {
    const tableName = process.env.VIDEOS_TABLE;
    const queueUrl = process.env.VIDEOS_DELETE_QUEUE_URL || buildSqsUrl(deleteQueueName);
    
    if (!tableName || !queueUrl) {
      const missing: string[] = [];
      if (!tableName) missing.push("VIDEOS_TABLE");
      if (!queueUrl) missing.push("VIDEOS_DELETE_QUEUE_URL");
      console.error("[videos/delete] Missing env", { missing });
      return NextResponse.json(
        { error: `Missing delete queue configuration: ${missing.join(", ")}` },
        { status: 500 },
      );
    }

    const cookieStore = await cookies();
    const token = cookieStore.get("id_token")?.value;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = decodeIdToken(token) as Record<string, unknown>;
    const email =
      (payload.email as string) ||
      (payload["cognito:username"] as string) ||
      (payload.sub as string);
    if (!email) {
      return NextResponse.json({ error: "Missing user id" }, { status: 401 });
    }

    const body = (await request.json()) as { videoId?: string };
    const videoId = body.videoId?.trim();
    if (!videoId) {
      return NextResponse.json({ error: "Missing video id" }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase();
    const sk = `VIDEO#${videoId}`;

    const result = await ddb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          email: { S: normalizedEmail },
          sk: { S: sk },
        },
      }),
    );

    if (!result.Item) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    const item = unmarshall(result.Item) as Record<string, any>;
    if (item.status === "DELETING") {
      return NextResponse.json({ ok: true });
    }

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ email: normalizedEmail, videoId }),
      }),
    );

    const now = new Date().toISOString();
    await ddb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: {
          email: { S: normalizedEmail },
          sk: { S: sk },
        },
        UpdateExpression:
          "SET #status = :status, #updatedAt = :now, #deletedAt = if_not_exists(#deletedAt, :now)",
        ExpressionAttributeNames: {
          "#status": "status",
          "#updatedAt": "updatedAt",
          "#deletedAt": "deletedAt",
        },
        ExpressionAttributeValues: {
          ":status": { S: "DELETING" },
          ":now": { S: now },
        },
      }),
    );

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[videos/delete] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to delete video" },
      { status: 500 },
    );
  }
}
