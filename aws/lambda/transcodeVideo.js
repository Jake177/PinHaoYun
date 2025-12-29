"use strict";
// S3-triggered Lambda: extract video metadata with ffprobe and update DynamoDB.
// Requires ffprobe in a Lambda layer (default path: /opt/bin/ffprobe).

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { createWriteStream } = require("node:fs");
const { unlink } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pipeline } = require("node:stream/promises");
const path = require("node:path");
const os = require("node:os");

const execFileAsync = promisify(execFile);

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const TABLE_NAME = process.env.VIDEOS_TABLE;
const FFPROBE_PATH = process.env.FFPROBE_PATH || "/opt/bin/ffprobe";

const parseFraction = (value) => {
  if (!value || value === "0/0") return undefined;
  const [num, den] = String(value).split("/").map(Number);
  if (!den) return undefined;
  return num / den;
};

const findTag = (tags, keys) => {
  if (!tags) return undefined;
  for (const key of keys) {
    if (tags[key]) return tags[key];
  }
  return undefined;
};

const parseIso6709 = (value) => {
  if (!value) return undefined;
  const match = String(value).match(
    /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/,
  );
  if (!match) return undefined;
  return {
    lat: Number(match[1]),
    lon: Number(match[2]),
    alt: match[3] ? Number(match[3]) : undefined,
  };
};

const downloadToTmp = async (bucket, key) => {
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!Body) {
    throw new Error("Missing S3 body");
  }
  const filename = path.basename(key);
  const tmpPath = path.join(
    os.tmpdir(),
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`,
  );
  await pipeline(Body, createWriteStream(tmpPath));
  return tmpPath;
};

const runFfprobe = async (filePath) => {
  const { stdout } = await execFileAsync(FFPROBE_PATH, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  return JSON.parse(stdout);
};

const toAttrNumber = (value) => ({ N: String(value) });
const toAttrString = (value) => ({ S: String(value) });

const updateVideoMetadata = async ({
  email,
  videoId,
  originalBucket,
  originalKey,
  metadata,
}) => {
  const now = new Date().toISOString();
  const values = {
    ":now": { S: now },
  };
  const names = {
    "#updatedAt": "updatedAt",
  };
  const setParts = ["#updatedAt = :now"];

  const addField = (field, attrValue) => {
    const nameKey = `#f_${field}`;
    const valueKey = `:${field}`;
    names[nameKey] = field;
    values[valueKey] = attrValue;
    setParts.push(`${nameKey} = ${valueKey}`);
  };

  if (originalBucket) addField("originalBucket", toAttrString(originalBucket));
  if (originalKey) addField("originalKey", toAttrString(originalKey));
  addField("status", toAttrString("READY"));

  if (metadata.captureTime) {
    addField("captureTime", toAttrString(metadata.captureTime));
  }
  if (metadata.captureLocation) {
    addField("captureLocation", toAttrString(metadata.captureLocation));
  }
  if (metadata.captureLat !== undefined) {
    addField("captureLat", toAttrNumber(metadata.captureLat));
  }
  if (metadata.captureLon !== undefined) {
    addField("captureLon", toAttrNumber(metadata.captureLon));
  }
  if (metadata.captureAlt !== undefined) {
    addField("captureAlt", toAttrNumber(metadata.captureAlt));
  }
  if (metadata.durationSec !== undefined) {
    addField("durationSec", toAttrNumber(metadata.durationSec));
  }
  if (metadata.width !== undefined) {
    addField("width", toAttrNumber(metadata.width));
  }
  if (metadata.height !== undefined) {
    addField("height", toAttrNumber(metadata.height));
  }
  if (metadata.fps !== undefined) {
    addField("fps", toAttrNumber(metadata.fps));
  }
  if (metadata.bitrate !== undefined) {
    addField("bitrate", toAttrNumber(metadata.bitrate));
  }
  if (metadata.codec) {
    addField("codec", toAttrString(metadata.codec));
  }
  if (metadata.rotation !== undefined) {
    addField("rotation", toAttrNumber(metadata.rotation));
  }

  await ddb.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { email: { S: email }, sk: { S: `VIDEO#${videoId}` } },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
};

const extractMetadata = (probe) => {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const format = probe.format || {};
  const videoStream = streams.find((s) => s.codec_type === "video") || {};
  const tags = {
    ...(format.tags || {}),
    ...(videoStream.tags || {}),
  };

  const captureTime = findTag(tags, ["creation_time", "com.apple.quicktime.creationdate"]);
  const captureLocation = findTag(tags, [
    "com.apple.quicktime.location.ISO6709",
    "location",
    "location-eng",
  ]);
  const isoLocation = parseIso6709(captureLocation);

  return {
    captureTime,
    captureLocation,
    captureLat: isoLocation?.lat,
    captureLon: isoLocation?.lon,
    captureAlt: isoLocation?.alt,
    durationSec: format.duration ? Number(format.duration) : undefined,
    bitrate: format.bit_rate ? Number(format.bit_rate) : undefined,
    width: videoStream.width ? Number(videoStream.width) : undefined,
    height: videoStream.height ? Number(videoStream.height) : undefined,
    fps:
      parseFraction(videoStream.avg_frame_rate) ??
      parseFraction(videoStream.r_frame_rate),
    codec: videoStream.codec_name,
    rotation: tags.rotate ? Number(tags.rotate) : undefined,
  };
};

const decodeKey = (value) => {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, " "));
  } catch {
    return String(value);
  }
};

exports.handler = async (event) => {
  if (!TABLE_NAME) throw new Error("Missing env VIDEOS_TABLE");
  const records = event.Records || [];

  for (const record of records) {
    try {
      const s3Record = record.s3;
      const bucket = s3Record?.bucket?.name;
      const key = s3Record?.object?.key;
      if (!bucket || !key) {
        console.warn("Skipping record with missing S3 info");
        continue;
      }

      const decodedKey = decodeKey(key);
      const parts = decodedKey.split("/");
      if (parts.length < 3) {
        console.warn("Unexpected key format", decodedKey);
        continue;
      }

      const userId = parts[1].toLowerCase();
      const videoId = parts[parts.length - 1];
      if (!userId || !videoId) {
        console.warn("Missing userId or videoId", decodedKey);
        continue;
      }

      const tmpPath = await downloadToTmp(bucket, decodedKey);
      try {
        const probe = await runFfprobe(tmpPath);
        const metadata = extractMetadata(probe);
        await updateVideoMetadata({
          email: userId,
          videoId,
          originalBucket: bucket,
          originalKey: decodedKey,
          metadata,
        });
      } finally {
        await unlink(tmpPath).catch(() => {});
      }
    } catch (error) {
      console.error("Failed to process record", error);
    }
  }

  return { ok: true };
};
