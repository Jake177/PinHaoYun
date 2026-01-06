"use strict";

const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const TABLE_NAME = process.env.VIDEOS_TABLE;
const MAPBOX_TOKEN =
  process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

const ddb = new DynamoDBClient({ region });

const isValidCoord = (value, min, max) =>
  Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;

const extractContext = (feature, prefix) =>
  feature?.context?.find((item) => String(item.id || "").startsWith(prefix))?.text;

const reverseGeocode = async (lat, lon) => {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?access_token=${MAPBOX_TOKEN}&limit=1&language=zh-Hans&types=address,place,locality,neighborhood`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Mapbox reverse geocode failed: ${resp.status}`);
  }
  const data = await resp.json();
  const feature = data?.features?.[0];
  if (!feature) return null;
  const city =
    extractContext(feature, "place") || extractContext(feature, "locality");
  const regionName = extractContext(feature, "region");
  const country = extractContext(feature, "country");
  return {
    address: feature.place_name || feature.text || "",
    city,
    region: regionName,
    country,
  };
};

exports.handler = async (event) => {
  if (!TABLE_NAME) throw new Error("Missing env VIDEOS_TABLE");
  if (!MAPBOX_TOKEN) throw new Error("Missing env MAPBOX_TOKEN");

  const records = event.Records || [];

  for (const record of records) {
    try {
      const body = record.body ? JSON.parse(record.body) : {};
      const email = body.email ? String(body.email).toLowerCase() : "";
      const videoId = body.videoId ? String(body.videoId) : "";
      const lat = Number(body.lat);
      const lon = Number(body.lon);

      if (!email || !videoId) {
        console.warn("Skipping location enrichment with missing info", body);
        continue;
      }
      if (!isValidCoord(lat, -90, 90) || !isValidCoord(lon, -180, 180)) {
        console.warn("Skipping location enrichment with invalid coords", body);
        continue;
      }

      const geo = await reverseGeocode(lat, lon);
      if (!geo || !geo.address) {
        console.warn("No address found for coords", { lat, lon, email, videoId });
        continue;
      }

      const now = new Date().toISOString();
      const names = {
        "#address": "captureAddress",
        "#city": "captureCity",
        "#region": "captureRegion",
        "#country": "captureCountry",
        "#locationSource": "locationSource",
        "#locationUpdatedAt": "locationUpdatedAt",
        "#updatedAt": "updatedAt",
        "#lat": "captureLat",
        "#lon": "captureLon",
        "#originalLat": "originalCaptureLat",
        "#originalLon": "originalCaptureLon",
      };
      const values = {
        ":address": { S: geo.address },
        ":city": { S: geo.city || "" },
        ":region": { S: geo.region || "" },
        ":country": { S: geo.country || "" },
        ":source": { S: "auto" },
        ":now": { S: now },
        ":lat": { N: String(lat) },
        ":lon": { N: String(lon) },
        ":manual": { S: "manual" },
      };

      try {
        await ddb.send(
          new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: {
              email: { S: email },
              sk: { S: `VIDEO#${videoId}` },
            },
            UpdateExpression:
              "SET #address = :address, #city = :city, #region = :region, #country = :country, " +
              "#locationSource = :source, #locationUpdatedAt = :now, #updatedAt = :now, " +
              "#lat = if_not_exists(#lat, :lat), #lon = if_not_exists(#lon, :lon), " +
              "#originalLat = if_not_exists(#originalLat, :lat), #originalLon = if_not_exists(#originalLon, :lon)",
            ConditionExpression:
              "attribute_not_exists(#locationSource) OR #locationSource <> :manual",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          console.warn("Location already set manually, skipping", { email, videoId });
          continue;
        }
        throw err;
      }
    } catch (error) {
      console.error("Failed to enrich location", error);
    }
  }

  return { ok: true };
};
