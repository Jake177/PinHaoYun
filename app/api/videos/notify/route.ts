import { NextResponse } from "next/server";
import { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { getSessionUser } from "@/app/lib/sessionUser";
import { normaliseContentType } from "@/app/lib/contentType";
import { buildMediaTimelineFields } from "@/app/lib/mediaTimeline";
const region = process.env.COGNITO_REGION || "ap-southeast-2";
const ddb = new DynamoDBClient({ region }); const s3 = new S3Client({ region });
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json();
    const mediaType = body.mediaType === "PHOTO" ? "PHOTO" : "VIDEO";
    const live = mediaType === "PHOTO" && body.mediaRole === "liveVideo";
    const key = body.key;
    if (typeof key !== "string" || !key.startsWith(`${mediaType === "PHOTO" ? "photo" : "video"}/${user.email}/`) || body.bucket !== process.env.S3_ORIGINAL_BUCKET) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const fileName = key.split("/").pop()!;
    const mediaId = mediaType === "PHOTO" ? fileName.split("_")[0] : fileName;
    if (body.photoId && body.photoId !== mediaId) return NextResponse.json({ error: "Invalid photo identity" }, { status: 400 });
    if (!live && (typeof body.contentHash !== "string" || !/^[a-f0-9]{64}-\d+$/.test(body.contentHash))) return NextResponse.json({ error: "Invalid content hash" }, { status: 400 });
    const table = process.env.VIDEOS_TABLE!;
    const dbKey = { email: { S: user.email }, sk: { S: `${mediaType}#${mediaId}` } };
    const marker = live ? "liveUploadConfirmed" : "uploadConfirmed";
    const existing = await ddb.send(new GetItemCommand({ TableName: table, Key: dbKey, ConsistentRead: true }));
    if (existing.Item?.[marker]?.BOOL && existing.Item?.[live ? "liveVideoKey" : "originalKey"]?.S === key) return NextResponse.json({ ok: true });
    const reserveSk = mediaType === "PHOTO" ? `RESERVE#PHOTO#${mediaId}` : `RESERVE#${mediaId}`;
    const reservationKey = { email: { S: user.email }, sk: { S: reserveSk } };
    const result = await ddb.send(new GetItemCommand({ TableName: table, Key: reservationKey, ConsistentRead: true }));
    if (!result.Item) return NextResponse.json({ error: "Upload reservation not found" }, { status: 409 });
    const reserve = unmarshall(result.Item);
    if (reserve.key !== key || !Number.isSafeInteger(reserve.size) || reserve.size <= 0) return NextResponse.json({ error: "Reservation mismatch" }, { status: 409 });
    const head = await s3.send(new HeadObjectCommand({ Bucket: body.bucket, Key: key }));
    if (head.ContentLength !== reserve.size || head.Metadata?.["owner-sub"] !== user.sub) return NextResponse.json({ error: "Uploaded object mismatch" }, { status: 409 });
    const now = new Date().toISOString();
    const timeline = buildMediaTimelineFields({ email: user.email, mediaType, mediaId, fileLastModified: body.fileLastModified, createdAt: now, fallbackNow: now });
    const fields: Record<string, AttributeValue> = {
      type: { S: mediaType }, ownerSub: { S: user.sub }, [marker]: { BOOL: true }, updatedAt: { S: now },
      ...(live ? { liveVideoBucket: { S: body.bucket }, liveVideoKey: { S: key }, liveVideoSize: { N: String(reserve.size) } } : {
        originalBucket: { S: body.bucket }, originalKey: { S: key }, originalName: { S: String(body.originalName || fileName).slice(0,512) },
        contentType: { S: normaliseContentType(body.contentType, body.originalName || key) || "application/octet-stream" },
        size: { N: String(reserve.size) }, contentHash: { S: body.contentHash }, status: { S: "READY" },
        ...(mediaType === "PHOTO" ? { photoId: { S: mediaId }, originalPhotoKey: { S: key }, originalPhotoBucket: { S: body.bucket } } : { videoId: { S: mediaId } }),
      }),
    };
    const names: Record<string,string> = { "#marker": marker, "#erasure": "status" };
    const values: Record<string,AttributeValue> = { ":now": { S: now }, ":mediaAt": { S: timeline.mediaAt }, ":source": { S: timeline.mediaAtSource }, ":pk": { S: timeline.timelinePk }, ":ts": { S: timeline.timelineSk }, ":erasing": { S: "DELETING" }, ":erased": { S: "DELETED" } };
    const sets = Object.entries(fields).map(([name,value],i) => { names[`#f${i}`]=name; values[`:v${i}`]=value; return `#f${i} = :v${i}`; });
    sets.push("createdAt = if_not_exists(createdAt, :now)", "mediaAt = if_not_exists(mediaAt, :mediaAt)", "mediaAtSource = if_not_exists(mediaAtSource, :source)", "timelinePk = if_not_exists(timelinePk, :pk)", "timelineSk = if_not_exists(timelineSk, :ts)");
    const counterNames = { "#bytes": mediaType === "PHOTO" ? "photoBytes" : "videoBytes", ...(!live ? { "#count": mediaType === "PHOTO" ? "photoCount" : "videosCount" } : {}) };
    const counterValues: Record<string,AttributeValue> = { ":size": { N: String(reserve.size) }, ":negative": { N: String(-reserve.size) }, ":active": { S: "ACTIVE" }, ...(!live ? { ":one": { N: "1" } } : {}) };
    await ddb.send(new TransactWriteItemsCommand({ TransactItems: [
      { Delete: { TableName: table, Key: reservationKey, ConditionExpression: "#key = :key", ExpressionAttributeNames: { "#key": "key" }, ExpressionAttributeValues: { ":key": { S: key } } } },
      { Update: { TableName: table, Key: dbKey, UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: "attribute_not_exists(#marker) AND (attribute_not_exists(#erasure) OR (#erasure <> :erasing AND #erasure <> :erased))", ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
      { Update: { TableName: table, Key: { email: { S: user.email }, sk: { S: "PROFILE" } }, UpdateExpression: `ADD usedBytes :size, #bytes :size, reservedBytes :negative${live ? "" : ", #count :one"}`, ConditionExpression: "attribute_exists(sk) AND reservedBytes >= :size AND (attribute_not_exists(accountStatus) OR accountStatus = :active)", ExpressionAttributeNames: counterNames, ExpressionAttributeValues: counterValues } },
      ...(!live ? [{ Put: { TableName: table, Item: { email: { S: user.email }, sk: { S: `${mediaType === "PHOTO" ? "HASH#PHOTO#" : "HASH#"}${body.contentHash}` }, mediaId: { S: mediaId }, type: { S: mediaType } }, ConditionExpression: "attribute_not_exists(sk) OR mediaId = :id", ExpressionAttributeValues: { ":id": { S: mediaId } } } }] : []),
    ] }));
    return NextResponse.json({ ok: true });
  } catch (error) {
    const conflict = error instanceof Error && error.name === "TransactionCanceledException";
    return NextResponse.json({ error: conflict ? "Upload finalization conflict. Retry safely." : "Upload finalization failed" }, { status: conflict ? 409 : 500 });
  }
}
