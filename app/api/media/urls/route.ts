import { NextResponse } from "next/server";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { getSessionUser } from "@/app/lib/sessionUser";
const region = process.env.COGNITO_REGION || "ap-southeast-2";
const ddb = new DynamoDBClient({ region });
const s3 = new S3Client({ region });
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, type } = await request.json();
  if (typeof id !== "string" || !id || id.length > 512 || !["PHOTO", "VIDEO"].includes(type)) return NextResponse.json({ error: "Invalid media" }, { status: 400 });
  const result = await ddb.send(new GetItemCommand({ TableName: process.env.VIDEOS_TABLE, Key: { email: { S: user.email }, sk: { S: `${type}#${id}` } }, ConsistentRead: true }));
  if (!result.Item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const item = unmarshall(result.Item);
  if (["DELETING", "DELETED"].includes(item.status)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const expiresIn = Math.min(Number(process.env.PRESIGN_TTL_SECONDS || 900), 900);
  const sign = async (key: unknown, bucket: unknown, fallback: string | undefined) => {
    if (typeof key !== "string" || !key) return null;
    const allowed = [process.env.S3_ORIGINAL_BUCKET, process.env.S3_THUMBNAIL_BUCKET].filter(Boolean);
    const resolved = typeof bucket === "string" ? bucket : fallback;
    if (!resolved || !allowed.includes(resolved)) throw new Error("Invalid media bucket");
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: resolved, Key: key }), { expiresIn });
  };
  return NextResponse.json({
    originalUrl: await sign(item.originalKey, item.originalBucket, process.env.S3_ORIGINAL_BUCKET),
    originalPhotoUrl: await sign(item.originalPhotoKey, item.originalPhotoBucket, process.env.S3_ORIGINAL_BUCKET),
    liveVideoUrl: await sign(item.liveVideoKey, item.liveVideoBucket, process.env.S3_ORIGINAL_BUCKET),
    thumbnailUrl: await sign(item.thumbnailKey, item.thumbnailBucket, process.env.S3_THUMBNAIL_BUCKET),
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
