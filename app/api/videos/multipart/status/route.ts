import { NextResponse } from "next/server";
import { S3Client, ListPartsCommand, HeadObjectCommand, type ListPartsCommandOutput } from "@aws-sdk/client-s3";
import { getSessionUser } from "@/app/lib/sessionUser";
const s3 = new S3Client({ region: process.env.COGNITO_REGION || "ap-southeast-2" });
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { key, uploadId } = await request.json();
  if (typeof key !== "string" || typeof uploadId !== "string" || (!key.startsWith(`photo/${user.email}/`) && !key.startsWith(`video/${user.email}/`))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const parts = []; let marker: string | undefined;
  try {
    do {
      const page: ListPartsCommandOutput = await s3.send(new ListPartsCommand({ Bucket: process.env.S3_ORIGINAL_BUCKET, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
      for (const part of page.Parts || []) parts.push({ partNumber: part.PartNumber, etag: part.ETag });
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return NextResponse.json({ parts, completed: false });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "NoSuchUpload") throw error;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_ORIGINAL_BUCKET, Key: key }));
      if (head.Metadata?.["owner-sub"] === user.sub) return NextResponse.json({ parts: [], completed: true });
    } catch { /* Missing object: the client must restart the upload. */ }
    return NextResponse.json({ error: "Upload no longer exists" }, { status: 410 });
  }
}
