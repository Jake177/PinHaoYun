import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const region = "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;
const originalBucket = process.env.S3_ORIGINAL_BUCKET;
const thumbnailBucket = process.env.S3_THUMBNAIL_BUCKET;

if (!tableName) {
  console.warn("[videos/list] Missing env VIDEOS_TABLE");
}

const ddb = new DynamoDBClient({ region });
const s3 = new S3Client({ region });

const expiresInSeconds = Number(process.env.PRESIGN_TTL_SECONDS || 900);

type VideoItem = {
  id: string;
  originalKey: string;
  thumbnailKey?: string;
  status?: string;
  size?: number;
  createdAt?: string;
};

async function signUrl(
  bucket: string | undefined,
  key: string | undefined,
): Promise<string | null> {
  if (!bucket || !key) return null;
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  } catch (err) {
    console.warn("[videos/list] Failed to presign", err);
    return null;
  }
}

export async function GET() {
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
    const email =
      (payload.email as string) ||
      (payload["cognito:username"] as string) ||
      (payload.sub as string);
    if (!email) {
      return NextResponse.json({ error: "Missing user id" }, { status: 401 });
    }

    const normalizedEmail = email.toLowerCase();

    const res = await ddb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { email: { S: normalizedEmail } },
      }),
    );

    const data = res.Item ? (unmarshall(res.Item) as Record<string, any>) : null;
    const items =
      (data?.videos as Array<Record<string, any>> | undefined)?.map((vid) => ({
        id: vid.videoId || vid.create_time || "",
        originalKey: vid.originalKey,
        originalBucket: vid.originalBucket,
        thumbnailKey: vid.thumbnailKey,
        thumbnailBucket: vid.thumbnailBucket,
        status: vid.status,
        size: vid.size,
        createdAt: vid.createdAt,
        originalName: vid.originalName,
      })) ?? [];

    const withUrls = await Promise.all(
      items.map(async (item) => {
        const originalUrl = await signUrl(
          item.originalBucket || originalBucket,
          item.originalKey,
        );
        const thumbnailUrl = await signUrl(
          item.thumbnailBucket || thumbnailBucket,
          item.thumbnailKey,
        );
        return {
          ...item,
          originalUrl,
          thumbnailUrl,
        };
      }),
    );

    return NextResponse.json({ videos: withUrls });
  } catch (error: any) {
    console.error("[videos/list] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch videos" },
      { status: 500 },
    );
  }
}
