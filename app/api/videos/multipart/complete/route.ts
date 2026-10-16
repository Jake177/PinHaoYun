import { NextResponse } from "next/server";
import { S3Client, CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getSessionUser } from "@/app/lib/sessionUser";
import { rejectDeletedBackup } from "@/app/lib/backupDeletion";

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

    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const payload = user.claims;
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

    if (
      !key.startsWith(`video/${normalizedUser}/`) &&
      !key.startsWith(`photo/${normalizedUser}/`)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const sortedParts = parts
      .map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.etag,
      }))
      .filter((part) => part.PartNumber && part.ETag)
      .sort((a, b) => (a.PartNumber as number) - (b.PartNumber as number));

    if (await rejectDeletedBackup(normalizedUser, user.sub, key)) return NextResponse.json({ error: "Cloud copy was deleted", code: "CLOUD_DELETED" }, { status: 410 });

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
