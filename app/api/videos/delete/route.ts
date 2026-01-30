import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageBatchCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const awsAccountId = process.env.ACCOUNT_ID;
const deleteQueueName = process.env.DELETE_QUEUE_NAME || "pinhaoyun_delete_video_sqs";

const ddb = new DynamoDBClient({ region });
const sqs = new SQSClient({ region });

// Build SQS URL to avoid relying on a full URL env var.
function buildSqsUrl(queueName: string): string {
  return `https://sqs.${region}.amazonaws.com/${awsAccountId}/${queueName}`;
}

type DeleteItem = {
  id: string;
  type: "VIDEO" | "PHOTO";
};

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

    const body = (await request.json().catch(() => ({}))) as {
      videoId?: string;
      videoIds?: string[];
      photoId?: string;
      photoIds?: string[];
      mediaId?: string;
      mediaType?: "VIDEO" | "PHOTO";
      items?: Array<{
        id?: string;
        type?: "VIDEO" | "PHOTO";
        mediaId?: string;
        mediaType?: "VIDEO" | "PHOTO";
        videoId?: string;
        photoId?: string;
      }>;
    };

    const collected: DeleteItem[] = [];
    const pushItem = (id: string | undefined, type: string | undefined) => {
      const trimmed = String(id || "").trim();
      if (!trimmed) return;
      const normalisedType = type === "PHOTO" ? "PHOTO" : "VIDEO";
      collected.push({ id: trimmed, type: normalisedType });
    };

    if (Array.isArray(body.items)) {
      body.items.forEach((item) => {
        const id = item.mediaId || item.id || item.videoId || item.photoId;
        const type =
          item.mediaType ||
          item.type ||
          (item.photoId ? "PHOTO" : item.videoId ? "VIDEO" : undefined);
        pushItem(id, type);
      });
    }

    if (Array.isArray(body.videoIds)) {
      body.videoIds.forEach((id) => pushItem(id, "VIDEO"));
    }
    if (Array.isArray(body.photoIds)) {
      body.photoIds.forEach((id) => pushItem(id, "PHOTO"));
    }
    if (body.videoId) pushItem(body.videoId, "VIDEO");
    if (body.photoId) pushItem(body.photoId, "PHOTO");
    if (body.mediaId) pushItem(body.mediaId, body.mediaType);

    const uniqueItems = Array.from(
      new Map(collected.map((item) => [`${item.type}:${item.id}`, item])).values(),
    );
    if (uniqueItems.length === 0) {
      return NextResponse.json({ error: "Missing media id" }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase();
    const now = new Date().toISOString();

    if (uniqueItems.length === 1) {
      const { id: mediaId, type: mediaType } = uniqueItems[0];
      const sk = `${mediaType}#${mediaId}`;
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
        return NextResponse.json(
          { error: mediaType === "PHOTO" ? "Photo not found" : "Video not found" },
          { status: 404 },
        );
      }

      const item = unmarshall(result.Item) as Record<string, any>;
      if (item.status === "DELETING") {
        return NextResponse.json({ ok: true });
      }

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            email: normalizedEmail,
            mediaId,
            mediaType,
            ...(mediaType === "PHOTO" ? { photoId: mediaId } : { videoId: mediaId }),
          }),
        }),
      );

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
    }

    for (let i = 0; i < uniqueItems.length; i += 10) {
      const chunk = uniqueItems.slice(i, i + 10);
      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((item, index) => ({
            Id: `${i + index}`,
            MessageBody: JSON.stringify({
              email: normalizedEmail,
              mediaId: item.id,
              mediaType: item.type,
              ...(item.type === "PHOTO" ? { photoId: item.id } : { videoId: item.id }),
            }),
          })),
        }),
      );
    }

    for (const item of uniqueItems) {
      const sk = `${item.type}#${item.id}`;
      try {
        await ddb.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: {
              email: { S: normalizedEmail },
              sk: { S: sk },
            },
            ConditionExpression: "attribute_exists(sk)",
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
      } catch (err: any) {
        if (err?.name !== "ConditionalCheckFailedException") {
          throw err;
        }
      }
    }

    return NextResponse.json({ ok: true, count: uniqueItems.length });
  } catch (error: any) {
    console.error("[videos/delete] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to delete video" },
      { status: 500 },
    );
  }
}
