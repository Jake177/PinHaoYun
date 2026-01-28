import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const ALLOWED_EXT = ["mov", "mp4", "hevc", "m4v"];

const originalBucket =
  process.env.S3_ORIGINAL_BUCKET;
const region =
  process.env.COGNITO_REGION ||
  "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;

if (!originalBucket) {
  console.warn("[presign] Missing env S3_ORIGINAL_BUCKET");
}

const s3 = new S3Client({ region });
const ddb = new DynamoDBClient({ region });

const sanitizeName = (name: string) =>
  name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);

const fileExt = (name: string) => {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
};

export async function POST(request: Request) {
  try {
    if (!originalBucket) {
      return NextResponse.json(
        { error: "Missing S3 bucket configuration" },
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
      fileName?: string;
      contentType?: string;
      size?: number;
      contentHash?: string;
    };
    const {
      fileName = "",
      contentType = "application/octet-stream",
      size = 0,
      contentHash,
    } =
      body || {};

    const ext = fileExt(fileName);
    if (!ALLOWED_EXT.includes(ext)) {
      return NextResponse.json(
        { error: "Unsupported file type" },
        { status: 400 },
      );
    }
    if (size <= 0 || size > MAX_BYTES) {
      return NextResponse.json(
        { error: "File too large (max 2GB)" },
        { status: 400 },
      );
    }

    // Fast duplicate check: if a matching hash already exists, return `duplicate` immediately.
    if (tableName && contentHash) {
      const existing = await ddb.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            email: { S: userId.toLowerCase() },
            sk: { S: `HASH#${contentHash}` },
          },
        }),
      );
      if (existing.Item) {
        return NextResponse.json({ duplicate: true });
      }
    }

    const safeName = sanitizeName(fileName || `upload.${ext || "mp4"}`);
    const id = crypto.randomUUID();
    const key = `video/${userId.toLowerCase()}/${id}_${safeName}`;

    const command = new PutObjectCommand({
      Bucket: originalBucket,
      Key: key,
      ContentType: contentType,
      ContentLength: size,
      StorageClass: "INTELLIGENT_TIERING",
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

    return NextResponse.json({
      uploadUrl,
      key,
      bucket: originalBucket,
      duplicate: false,
    });
  } catch (error: any) {
    console.error("[presign] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to create presigned URL" },
      { status: 500 },
    );
  }
}
