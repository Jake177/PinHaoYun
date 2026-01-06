import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { S3Client, CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";
import { decodeIdToken } from "@/app/lib/jwt";

const originalBucket = process.env.S3_ORIGINAL_BUCKET;
const region = process.env.COGNITO_REGION || "ap-southeast-2";

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
      parts?: Array<{ partNumber: number; etag: string }>;
    };
    const { key, uploadId, parts } = body || {};

    if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
      return NextResponse.json(
        { error: "Missing completion parameters" },
        { status: 400 },
      );
    }

    if (!key.startsWith(`video/${normalizedUser}/`)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const sortedParts = parts
      .map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.etag,
      }))
      .filter((part) => part.PartNumber && part.ETag)
      .sort((a, b) => (a.PartNumber as number) - (b.PartNumber as number));

    if (sortedParts.length === 0) {
      return NextResponse.json(
        { error: "Missing upload parts" },
        { status: 400 },
      );
    }

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: originalBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sortedParts,
        },
      }),
    );

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[multipart/complete] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to complete upload" },
      { status: 500 },
    );
  }
}
