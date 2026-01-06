import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodeIdToken } from "@/app/lib/jwt";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;

const ddb = new DynamoDBClient({ region });

const isValidCoord = (value: number, min: number, max: number) =>
  Number.isFinite(value) && value >= min && value <= max;

export async function POST(request: Request) {
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

    const body = (await request.json()) as {
      videoId?: string;
      lat?: number;
      lon?: number;
      address?: string;
      city?: string;
      region?: string;
      country?: string;
    };

    const videoId = body.videoId?.trim();
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    const address = body.address?.trim() || "";

    if (!videoId) {
      return NextResponse.json({ error: "Missing video id" }, { status: 400 });
    }
    if (!isValidCoord(lat, -90, 90) || !isValidCoord(lon, -180, 180)) {
      return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
    }
    if (!address) {
      return NextResponse.json({ error: "Missing address" }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase();
    const sk = `VIDEO#${videoId}`;

    const existing = await ddb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          email: { S: normalizedEmail },
          sk: { S: sk },
        },
      }),
    );

    if (!existing.Item) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    const item = unmarshall(existing.Item) as Record<string, any>;
    const originalLat =
      typeof item.originalCaptureLat === "number"
        ? item.originalCaptureLat
        : typeof item.captureLat === "number"
        ? item.captureLat
        : undefined;
    const originalLon =
      typeof item.originalCaptureLon === "number"
        ? item.originalCaptureLon
        : typeof item.captureLon === "number"
        ? item.captureLon
        : undefined;

    const now = new Date().toISOString();
    const names: Record<string, string> = {
      "#lat": "captureLat",
      "#lon": "captureLon",
      "#updatedAt": "updatedAt",
      "#locationUpdatedAt": "locationUpdatedAt",
      "#locationSource": "locationSource",
      "#address": "captureAddress",
      "#city": "captureCity",
      "#region": "captureRegion",
      "#country": "captureCountry",
    };
    const values: Record<string, any> = {
      ":lat": { N: String(lat) },
      ":lon": { N: String(lon) },
      ":now": { S: now },
      ":source": { S: "manual" },
      ":address": { S: address },
      ":city": { S: body.city?.trim() || "" },
      ":region": { S: body.region?.trim() || "" },
      ":country": { S: body.country?.trim() || "" },
    };

    const sets = [
      "#lat = :lat",
      "#lon = :lon",
      "#updatedAt = :now",
      "#locationUpdatedAt = :now",
      "#locationSource = :source",
      "#address = :address",
      "#city = :city",
      "#region = :region",
      "#country = :country",
    ];

    if (originalLat !== undefined) {
      names["#originalLat"] = "originalCaptureLat";
      sets.push("#originalLat = if_not_exists(#originalLat, :origLat)");
      values[":origLat"] = { N: String(originalLat) };
    }
    if (originalLon !== undefined) {
      names["#originalLon"] = "originalCaptureLon";
      sets.push("#originalLon = if_not_exists(#originalLon, :origLon)");
      values[":origLon"] = { N: String(originalLon) };
    }

    await ddb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: {
          email: { S: normalizedEmail },
          sk: { S: sk },
        },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[videos/location] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to update location" },
      { status: 500 },
    );
  }
}
