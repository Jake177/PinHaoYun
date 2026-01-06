import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { S3Client, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";

const originalBucket = process.env.S3_ORIGINAL_BUCKET;
const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;

const s3 = new S3Client({ region });
const ddb = new DynamoDBClient({ region });

export async function POST(request: Request) {
  try {
    if (!originalBucket) {
      return NextResponse.json(
        { error: "Missing S3 bucket configuration" },
        { status: 500 },
      );
    }
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
    };
    const { key, uploadId } = body || {};

    if (!key || !uploadId) {
      return NextResponse.json(
        { error: "Missing abort parameters" },
        { status: 400 },
      );
    }

    if (!key.startsWith(`video/${normalizedUser}/`)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: originalBucket,
        Key: key,
        UploadId: uploadId,
      }),
    );

    const videoId = key.split("/").pop() || "";
    if (videoId) {
      const reserveSk = `RESERVE#${videoId}`;
      const reserveRes = await ddb.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            email: { S: normalizedUser },
            sk: { S: reserveSk },
          },
        }),
      );

      if (reserveRes.Item) {
        const reserve = unmarshall(reserveRes.Item) as { size?: number };
        const sizeNumber = Number(reserve.size || 0);
        if (sizeNumber > 0) {
          const now = new Date().toISOString();
          try {
            await ddb.send(
              new TransactWriteItemsCommand({
                TransactItems: [
                  {
                    Delete: {
                      TableName: tableName,
                      Key: {
                        email: { S: normalizedUser },
                        sk: { S: reserveSk },
                      },
                    },
                  },
                  {
                    Update: {
                      TableName: tableName,
                      Key: {
                        email: { S: normalizedUser },
                        sk: { S: "PROFILE" },
                      },
                      UpdateExpression:
                        "SET reservedBytes = reservedBytes - :size, updatedAt = :now",
                      ConditionExpression: "reservedBytes >= :size",
                      ExpressionAttributeValues: {
                        ":size": { N: String(sizeNumber) },
                        ":now": { S: now },
                      },
                    },
                  },
                ],
              }),
            );
          } catch (err) {
            console.warn("[multipart/abort] Failed to release reservation", err);
          }
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[multipart/abort] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to abort upload" },
      { status: 500 },
    );
  }
}
