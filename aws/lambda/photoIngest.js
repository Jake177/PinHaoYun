"use strict";
// S3-triggered Lambda: extract photo metadata and create thumbnails with ImageMagick.

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { createWriteStream, createReadStream } = require("node:fs");
const { unlink } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pipeline } = require("node:stream/promises");
const path = require("node:path");
const os = require("node:os");

const execFileAsync = promisify(execFile);

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

const TABLE_NAME = process.env.VIDEOS_TABLE;
const THUMBNAIL_BUCKET = process.env.S3_THUMBNAIL_BUCKET;
const LOCATION_ENRICH_QUEUE_URL = process.env.LOCATION_ENRICH_QUEUE_URL;
const IDENTIFY_PATH = process.env.IMAGEMAGICK_IDENTIFY_PATH || "/opt/bin/identify";
const CONVERT_PATH = process.env.IMAGEMAGICK_CONVERT_PATH || "/opt/bin/convert";

const decodeKey = (value) => {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, " "));
  } catch {
    return String(value);
  }
};

const parseRational = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (!raw.includes("/")) {
    const num = Number(raw);
    return Number.isNaN(num) ? undefined : num;
  }
  const [numStr, denStr] = raw.split("/");
  const num = Number(numStr);
  const den = Number(denStr);
  if (!Number.isFinite(num)) return undefined;
  if (!Number.isFinite(den) || den === 0) return num;
  return num / den;
};

const cleanString = (value) => {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "unknown") return undefined;
  return trimmed;
};

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }
  return undefined;
};

const parseExifDate = (value) => {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const match = cleaned.match(
    /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([+-]\d{2}):?(\d{2})|Z)?$/,
  );
  if (!match) return cleaned;
  const [, year, month, day, hour, minute, second, ms, tzH, tzM] = match;
  const millis = ms ? `.${ms.padEnd(3, "0").slice(0, 3)}` : "";
  const base = `${year}-${month}-${day}T${hour}:${minute}:${second}${millis}`;
  if (cleaned.endsWith("Z")) return `${base}Z`;
  if (tzH && tzM) return `${base}${tzH}:${tzM}`;
  return base;
};

const parseGpsDms = (value, ref) => {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const parts = cleaned
    .split(",")
    .map((part) => parseRational(part.trim()))
    .filter((num) => typeof num === "number" && !Number.isNaN(num));
  if (!parts.length) return undefined;
  const [deg, min = 0, sec = 0] = parts;
  let result = deg + min / 60 + sec / 3600;
  const refClean = cleanString(ref);
  if (refClean && ["S", "W"].includes(refClean.toUpperCase())) {
    result *= -1;
  }
  return result;
};

const downloadToTmp = async (bucket, key) => {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
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

const extractMetadata = async (filePath) => {
  const format = [
    "%w",
    "%h",
    "%[EXIF:DateTimeOriginal]",
    "%[EXIF:CreateDate]",
    "%[EXIF:DateTimeDigitized]",
    "%[EXIF:DateTime]",
    "%[EXIF:Make]",
    "%[EXIF:Model]",
    "%[EXIF:Software]",
    "%[EXIF:GPSLatitude]",
    "%[EXIF:GPSLatitudeRef]",
    "%[EXIF:GPSLongitude]",
    "%[EXIF:GPSLongitudeRef]",
    "%[EXIF:GPSAltitude]",
    "%[EXIF:Orientation]",
  ].join("\\n");
  const { stdout } = await execFileAsync(IDENTIFY_PATH, ["-format", format, filePath]);
  const parts = stdout.split(/\\r?\\n/);
  const [
    width,
    height,
    dateOriginal,
    dateCreate,
    dateDigitized,
    dateTime,
    make,
    model,
    software,
    gpsLat,
    gpsLatRef,
    gpsLon,
    gpsLonRef,
    gpsAlt,
    orientation,
  ] = parts;
  const captureTimeRaw = firstNonEmpty(dateOriginal, dateCreate, dateDigitized, dateTime);
  return {
    width: Number(width) || undefined,
    height: Number(height) || undefined,
    captureTime: parseExifDate(captureTimeRaw),
    deviceMake: cleanString(make),
    deviceModel: cleanString(model),
    deviceSoftware: cleanString(software),
    captureLat: parseGpsDms(gpsLat, gpsLatRef),
    captureLon: parseGpsDms(gpsLon, gpsLonRef),
    captureAlt: gpsAlt ? parseRational(gpsAlt) : undefined,
    orientation: orientation ? Number(orientation) : undefined,
  };
};

const makeThumbnail = async ({ filePath, userId, photoId }) => {
  if (!THUMBNAIL_BUCKET) return null;
  const thumbName = `${photoId}.jpg`;
  const targetKey = `photo/${encodeURIComponent(userId)}/${thumbName}`;
  const tmpThumb = path.join(
    os.tmpdir(),
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${thumbName}`,
  );
  try {
    await execFileAsync(CONVERT_PATH, [
      filePath,
      "-auto-orient",
      "-thumbnail",
      "640x640>",
      "-strip",
      tmpThumb,
    ]);
    const body = createReadStream(tmpThumb);
    await s3.send(
      new PutObjectCommand({
        Bucket: THUMBNAIL_BUCKET,
        Key: targetKey,
        Body: body,
        ContentType: "image/jpeg",
      }),
    );
    return { bucket: THUMBNAIL_BUCKET, key: targetKey };
  } finally {
    await unlink(tmpThumb).catch(() => {});
  }
};

const enqueueLocationEnrichment = async ({ email, photoId, lat, lon }) => {
  if (!LOCATION_ENRICH_QUEUE_URL) return;
  if (lat === undefined || lon === undefined) return;
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: LOCATION_ENRICH_QUEUE_URL,
        MessageBody: JSON.stringify({
          email,
          videoId: photoId,
          mediaType: "PHOTO",
          lat,
          lon,
        }),
      }),
    );
  } catch (error) {
    console.warn("Failed to enqueue location enrichment", error);
  }
};

const toAttrNumber = (value) => ({ N: String(value) });
const toAttrString = (value) => ({ S: String(value) });

exports.handler = async (event) => {
  if (!TABLE_NAME) throw new Error("Missing env VIDEOS_TABLE");
  const records = event.Records || [];

  for (const record of records) {
    try {
      const s3Record = record.s3;
      const bucket = s3Record?.bucket?.name;
      const key = s3Record?.object?.key;
      if (!bucket || !key) continue;

      const decodedKey = decodeKey(key);
      if (!decodedKey.includes("/photo/") && !decodedKey.startsWith("photo/")) {
        continue;
      }

      const parts = decodedKey.split("/");
      if (parts.length < 3) continue;
      const userId = parts[1].toLowerCase();
      const fileName = parts[parts.length - 1];
      const photoId = fileName.split("_")[0];
      if (!userId || !photoId) continue;

      const isLiveVideo = fileName.includes("_live.") || fileName.toLowerCase().endsWith(".mov");
      const now = new Date().toISOString();

      if (isLiveVideo) {
        const liveVideoSize = Number(s3Record?.object?.size);
        const updateParts = [
          "liveVideoBucket = :bucket",
          "liveVideoKey = :key",
          "updatedAt = :now",
          "#type = if_not_exists(#type, :type)",
          "createdAt = if_not_exists(createdAt, :now)",
        ];
        const values = {
          ":bucket": { S: bucket },
          ":key": { S: decodedKey },
          ":now": { S: now },
          ":type": { S: "PHOTO" },
        };
        const names = { "#type": "type" };
        if (Number.isFinite(liveVideoSize) && liveVideoSize > 0) {
          updateParts.splice(2, 0, "liveVideoSize = :liveSize");
          values[":liveSize"] = { N: String(liveVideoSize) };
        }
        await ddb.send(
          new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { email: { S: userId }, sk: { S: `PHOTO#${photoId}` } },
            UpdateExpression: `SET ${updateParts.join(", ")}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        continue;
      }

      const tmpPath = await downloadToTmp(bucket, decodedKey);
      try {
        let metadata = {};
        try {
          metadata = await extractMetadata(tmpPath);
        } catch (error) {
          console.warn("Failed to extract photo metadata", error);
        }
        let thumbResult = null;
        try {
          thumbResult = await makeThumbnail({
            filePath: tmpPath,
            userId,
            photoId,
          });
        } catch (error) {
          console.warn("Failed to create photo thumbnail", error);
        }

        const names = {
          "#updatedAt": "updatedAt",
          "#type": "type",
        };
        const values = {
          ":now": { S: now },
        };
        const setParts = ["#updatedAt = :now", "#type = :type"];
        values[":type"] = { S: "PHOTO" };

        const addField = (field, value) => {
          if (value === undefined || value === null || value === "") return;
          const nameKey = `#f_${field}`;
          const valueKey = `:${field}`;
          names[nameKey] = field;
          values[valueKey] = typeof value === "number" ? toAttrNumber(value) : toAttrString(value);
          setParts.push(`${nameKey} = ${valueKey}`);
        };
        const addFieldIfMissing = (field, value) => {
          if (value === undefined || value === null || value === "") return;
          const nameKey = `#f_${field}`;
          const valueKey = `:${field}`;
          names[nameKey] = field;
          values[valueKey] = typeof value === "number" ? toAttrNumber(value) : toAttrString(value);
          setParts.push(`${nameKey} = if_not_exists(${nameKey}, ${valueKey})`);
        };

        if (thumbResult?.bucket) addField("thumbnailBucket", thumbResult.bucket);
        if (thumbResult?.key) addField("thumbnailKey", thumbResult.key);

        addField("status", "READY");
        addFieldIfMissing("captureTime", metadata.captureTime);
        addFieldIfMissing("captureLat", metadata.captureLat);
        addFieldIfMissing("captureLon", metadata.captureLon);
        addFieldIfMissing("captureAlt", metadata.captureAlt);
        addFieldIfMissing("width", metadata.width);
        addFieldIfMissing("height", metadata.height);
        addFieldIfMissing("orientation", metadata.orientation);
        addFieldIfMissing("deviceMake", metadata.deviceMake);
        addFieldIfMissing("deviceModel", metadata.deviceModel);
        addFieldIfMissing("deviceSoftware", metadata.deviceSoftware);

        await ddb.send(
          new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { email: { S: userId }, sk: { S: `PHOTO#${photoId}` } },
            UpdateExpression: `SET ${setParts.join(", ")}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );

        await enqueueLocationEnrichment({
          email: userId,
          photoId,
          lat: metadata.captureLat,
          lon: metadata.captureLon,
        });
      } finally {
        await unlink(tmpPath).catch(() => {});
      }
    } catch (error) {
      console.error("Failed to process photo record", error);
    }
  }

  return { ok: true };
};
