import { NextResponse } from "next/server";
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { getSessionUser } from "@/app/lib/sessionUser";
const region = process.env.COGNITO_REGION || "ap-southeast-2";
const ddb = new DynamoDBClient({ region }); const sqs = new SQSClient({ region });
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const queue = process.env.VIDEOS_DELETE_QUEUE_URL;
  if (!queue) return NextResponse.json({ error: "Deletion is not configured" }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  const items: { id: string; type: "PHOTO" | "VIDEO" }[] = [];
  const add = (id: unknown, type: unknown) => { if (typeof id === "string" && id.trim() && id.length <= 512) items.push({ id: id.trim(), type: type === "PHOTO" ? "PHOTO" : "VIDEO" }); };
  for (const item of Array.isArray(body.items) ? body.items : []) add(item.mediaId || item.id || item.videoId || item.photoId, item.mediaType || item.type || (item.photoId ? "PHOTO" : "VIDEO"));
  for (const id of Array.isArray(body.videoIds) ? body.videoIds : []) add(id, "VIDEO");
  for (const id of Array.isArray(body.photoIds) ? body.photoIds : []) add(id, "PHOTO");
  if (body.videoId) add(body.videoId, "VIDEO"); if (body.photoId) add(body.photoId, "PHOTO"); if (body.mediaId) add(body.mediaId, body.mediaType);
  const unique = [...new Map(items.map(item => [`${item.type}:${item.id}`, item])).values()];
  if (!unique.length || unique.length > 1000) return NextResponse.json({ error: "Invalid media selection" }, { status: 400 });
  let count = 0;
  for (const item of unique) {
    const Key = { email: { S: user.email }, sk: { S: `${item.type}#${item.id}` } };
    const result = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE, Key, ConsistentRead: true }));
    if (!result.Item) { if (unique.length === 1) return NextResponse.json({ error: "Not found" }, { status: 404 }); continue; }
    if (result.Item.status?.S === "DELETED") { count++; continue; }
    // Persist the marker before publishing. The reservation sweeper republishes
    // DELETING records if SQS is temporarily unavailable.
    await ddb.send(new UpdateItemCommand({ TableName: process.env.VIDEOS_TABLE, Key, UpdateExpression: "SET #state = :deleting, deletedAt = if_not_exists(deletedAt, :now)", ConditionExpression: "attribute_exists(sk) AND (attribute_not_exists(#state) OR #state <> :deleted)", ExpressionAttributeNames: { "#state": "status" }, ExpressionAttributeValues: { ":deleting": { S: "DELETING" }, ":deleted": { S: "DELETED" }, ":now": { S: new Date().toISOString() } } }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queue, MessageBody: JSON.stringify({ email: user.email, mediaId: item.id, mediaType: item.type, userSub: user.sub }) }));
    count++;
  }
  return NextResponse.json({ ok: true, count });
}
