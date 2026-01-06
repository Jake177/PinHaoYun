import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { decodeIdToken } from "@/app/lib/jwt";

const originalBucket = process.env.S3_ORIGINAL_BUCKET;
const region = process.env.COGNITO_REGION || "ap-southeast-2";
const expiresInSeconds = Number(process.env.PRESIGN_TTL_SECONDS || 900);

const s3 = new S3Client({ region });

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
    const normalizedUser = userId.toLowerCase();

    const body = (await request.json()) as {
      key?: string;
      uploadId?: string;
      partNumber?: number;
    };
    const { key, uploadId, partNumber } = body || {};

    if (!key || !uploadId || !partNumber || partNumber < 1) {
      return NextResponse.json(
        { error: "Missing upload parameters" },
        { status: 400 },
      );
    }

    if (!key.startsWith(`video/${normalizedUser}/`)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const command = new UploadPartCommand({
      Bucket: originalBucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: expiresInSeconds,
    });

    return NextResponse.json({ uploadUrl });
  } catch (error: any) {
    console.error("[multipart/part] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to create upload part URL" },
      { status: 500 },
    );
  }
}
