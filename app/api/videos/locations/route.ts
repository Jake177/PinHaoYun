import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { decodeIdToken } from "@/app/lib/jwt";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;
const thumbnailBucket = process.env.S3_THUMBNAIL_BUCKET;

const ddb = new DynamoDBClient({ region });
const s3 = new S3Client({ region });

const expiresInSeconds = Number(process.env.PRESIGN_TTL_SECONDS || 900);

async function signUrl(
  bucket: string | undefined,
  key: string | undefined
): Promise<string | null> {
  if (!bucket || !key) return null;
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: expiresInSeconds }
    );
  } catch {
    return null;
  }
}

export type VideoLocation = {
  id: string;
  lat: number;
  lon: number;
  thumbnailUrl: string | null;
  originalName?: string;
  captureTime?: string;
};

// GET: Fetch all videos with location data for map display
export async function GET() {
  try {
    if (!tableName) {
      return NextResponse.json(
        { error: "Missing table configuration" },
        { status: 500 }
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

    // Query all videos for this user
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "email = :email AND begins_with(sk, :skPrefix)",
        ExpressionAttributeValues: {
          ":email": { S: normalizedEmail },
          ":skPrefix": { S: "VIDEO#" },
        },
      })
    );

    const records =
      res.Items?.map((item) => unmarshall(item) as Record<string, any>) || [];

    // Filter videos that have location data
    const videosWithLocation = records
      .filter(
        (r) =>
          typeof r.sk === "string" &&
          r.sk.startsWith("VIDEO#") &&
          r.status !== "DELETING" &&
          r.status !== "DELETED" &&
          typeof r.captureLat === "number" &&
          typeof r.captureLon === "number" &&
          r.captureLat !== 0 &&
          r.captureLon !== 0
      )
      .map((vid) => ({
        id: vid.videoId || vid.sk || "",
        lat: vid.captureLat,
        lon: vid.captureLon,
        thumbnailKey: vid.thumbnailKey,
        thumbnailBucket: vid.thumbnailBucket,
        originalName: vid.originalName,
        captureTime: vid.captureTime || vid.createdAt,
      }));

    // Generate presigned URLs for thumbnails
    const locations: VideoLocation[] = await Promise.all(
      videosWithLocation.map(async (vid) => ({
        id: vid.id,
        lat: vid.lat,
        lon: vid.lon,
        thumbnailUrl: await signUrl(
          vid.thumbnailBucket || thumbnailBucket,
          vid.thumbnailKey
        ),
        originalName: vid.originalName,
        captureTime: vid.captureTime,
      }))
    );

    // Convert to GeoJSON format for Mapbox
    const geojson = {
      type: "FeatureCollection" as const,
      features: locations.map((loc) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [loc.lon, loc.lat], // GeoJSON uses [lng, lat] order
        },
        properties: {
          id: loc.id,
          thumbnailUrl: loc.thumbnailUrl,
          originalName: loc.originalName,
          captureTime: loc.captureTime,
        },
      })),
    };

    return NextResponse.json({
      locations,
      geojson,
      totalCount: locations.length,
    });
  } catch (error: any) {
    console.error("[videos/locations] error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch locations" },
      { status: 500 }
    );
  }
}
