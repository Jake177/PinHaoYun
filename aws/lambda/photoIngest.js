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
const { existsSync, readdirSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const execFileAsync = promisify(execFile);

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

const TABLE_NAME = process.env.VIDEOS_TABLE;
const ORIGINAL_BUCKET = process.env.S3_ORIGINAL_BUCKET;
const THUMBNAIL_BUCKET = process.env.S3_THUMBNAIL_BUCKET;
const LOCATION_ENRICH_QUEUE_URL = process.env.LOCATION_ENRICH_QUEUE_URL;
const IDENTIFY_PATH = process.env.IMAGEMAGICK_IDENTIFY_PATH || "/opt/bin/identify";
const CONVERT_PATH = process.env.IMAGEMAGICK_CONVERT_PATH || "/opt/bin/convert";

const buildImagemagickEnv = () => {
  const env = { ...process.env };
  const optRoot = "/opt";

  // Point ImageMagick at the layer's config + modules when running on Lambda.
  // Without this, HEIC/HEIF delegates can fail to load (missing delegates.xml / coder modules).
  env.MAGICK_HOME = env.MAGICK_HOME || optRoot;

  const configureCandidates = [
    `${optRoot}/etc/ImageMagick-6`,
    `${optRoot}/etc/ImageMagick-7`,
    `${optRoot}/etc`,
  ].filter((p) => existsSync(p));
  if (configureCandidates.length) {
    env.MAGICK_CONFIGURE_PATH = configureCandidates.join(":");
  }

  const libCandidates = [`${optRoot}/lib`, `${optRoot}/lib64`].filter((p) =>
    existsSync(p),
  );
  if (libCandidates.length) {
    const existing = (env.LD_LIBRARY_PATH || "")
      .split(":")
      .map((p) => p.trim())
      .filter(Boolean);
    env.LD_LIBRARY_PATH = Array.from(
      new Set([...libCandidates, ...existing]),
    ).join(":");
  }

  const coderPaths = [];
  const lib64Root = `${optRoot}/lib64`;
  if (existsSync(lib64Root)) {
    try {
      for (const entry of readdirSync(lib64Root)) {
        if (!entry.startsWith("ImageMagick-")) continue;
        const coders = path.join(lib64Root, entry, "modules-Q16", "coders");
        if (existsSync(coders)) coderPaths.push(coders);
      }
    } catch {
      // ignore
    }
  }
  if (coderPaths.length) {
    env.MAGICK_CODER_MODULE_PATH = coderPaths.join(":");
  }

  // Ensure ImageMagick uses Lambda's tmp.
  env.MAGICK_TMPDIR = env.MAGICK_TMPDIR || os.tmpdir();

  return env;
};

const IMAGEMAGICK_ENV = buildImagemagickEnv();

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

const guessContentType = (name) => {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  return undefined;
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
    .split(/[\s,]+/)
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

const EXIF_TYPE_SIZES = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

const readU16 = (buf, offset, littleEndian) =>
  littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
const readU32 = (buf, offset, littleEndian) =>
  littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
const readI32 = (buf, offset, littleEndian) =>
  littleEndian ? buf.readInt32LE(offset) : buf.readInt32BE(offset);

const orientationFromString = (value) => {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const map = {
    TopLeft: 1,
    TopRight: 2,
    BottomRight: 3,
    BottomLeft: 4,
    LeftTop: 5,
    RightTop: 6,
    RightBottom: 7,
    LeftBottom: 8,
  };
  return map[cleaned] || undefined;
};

const parseGpsFromRationals = (values, ref) => {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const [deg, min = 0, sec = 0] = values;
  if (!Number.isFinite(deg)) return undefined;
  let result = deg + (Number(min) || 0) / 60 + (Number(sec) || 0) / 3600;
  const refClean = cleanString(ref);
  if (refClean && ["S", "W"].includes(refClean.toUpperCase())) result *= -1;
  return result;
};

const stripExifHeader = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) return buffer;
  const prefix = buffer.subarray(0, 6).toString("ascii");
  return prefix === "Exif\0\0" ? buffer.subarray(6) : buffer;
};

const parseTiffIfd = (buf, offset, littleEndian) => {
  if (!offset || offset < 0 || offset + 2 > buf.length) {
    return { entries: new Map(), nextOffset: 0 };
  }
  const count = readU16(buf, offset, littleEndian);
  let cursor = offset + 2;
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (cursor + 12 > buf.length) break;
    const tag = readU16(buf, cursor, littleEndian);
    const type = readU16(buf, cursor + 2, littleEndian);
    const valueCount = readU32(buf, cursor + 4, littleEndian);
    const valueOrOffset = readU32(buf, cursor + 8, littleEndian);
    entries.set(tag, {
      tag,
      type,
      count: valueCount,
      valueOrOffset,
      valueFieldOffset: cursor + 8,
    });
    cursor += 12;
  }
  const nextOffset = cursor + 4 <= buf.length ? readU32(buf, cursor, littleEndian) : 0;
  return { entries, nextOffset };
};

const readIfdAscii = (buf, entry, littleEndian) => {
  if (!entry || entry.type !== 2 || !entry.count) return undefined;
  const size = entry.count; // bytes (includes null terminator)
  const inline = size <= 4;
  const offset = inline ? entry.valueFieldOffset : entry.valueOrOffset;
  if (offset <= 0 || offset + size > buf.length) return undefined;
  const slice = buf.subarray(offset, offset + size);
  const nul = slice.indexOf(0);
  const text = slice.subarray(0, nul >= 0 ? nul : slice.length).toString("utf8");
  return cleanString(text);
};

const readIfdShort = (buf, entry, littleEndian) => {
  if (!entry || entry.type !== 3 || !entry.count) return undefined;
  const offset = entry.count * 2 <= 4 ? entry.valueFieldOffset : entry.valueOrOffset;
  if (offset <= 0 || offset + 2 > buf.length) return undefined;
  return readU16(buf, offset, littleEndian);
};

const readIfdLong = (buf, entry, littleEndian) => {
  if (!entry || (entry.type !== 4 && entry.type !== 9) || !entry.count) return undefined;
  const offset = entry.count * 4 <= 4 ? entry.valueFieldOffset : entry.valueOrOffset;
  if (offset <= 0 || offset + 4 > buf.length) return undefined;
  return entry.type === 9 ? readI32(buf, offset, littleEndian) : readU32(buf, offset, littleEndian);
};

const readIfdRationals = (buf, entry, littleEndian) => {
  if (!entry || (entry.type !== 5 && entry.type !== 10) || !entry.count) return undefined;
  const size = entry.count * 8;
  const offset = entry.valueOrOffset;
  if (offset <= 0 || offset + size > buf.length) return undefined;
  const out = [];
  for (let i = 0; i < entry.count; i++) {
    const base = offset + i * 8;
    const num = entry.type === 10 ? readI32(buf, base, littleEndian) : readU32(buf, base, littleEndian);
    const den = entry.type === 10 ? readI32(buf, base + 4, littleEndian) : readU32(buf, base + 4, littleEndian);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
      out.push(Number(num));
    } else {
      out.push(num / den);
    }
  }
  return out;
};

const readIfdByte = (buf, entry) => {
  if (!entry || entry.type !== 1 || !entry.count) return undefined;
  const offset = entry.valueFieldOffset;
  if (offset <= 0 || offset + 1 > buf.length) return undefined;
  return buf.readUInt8(offset);
};

const parseExifProfile = (buffer) => {
  const buf = stripExifHeader(buffer);
  if (!Buffer.isBuffer(buf) || buf.length < 8) return {};
  const order = buf.subarray(0, 2).toString("ascii");
  const littleEndian = order === "II";
  if (!littleEndian && order !== "MM") return {};

  const ifd0Offset = readU32(buf, 4, littleEndian);
  const ifd0 = parseTiffIfd(buf, ifd0Offset, littleEndian);

  const getAscii = (entries, tag) => readIfdAscii(buf, entries.get(tag), littleEndian);
  const getShort = (entries, tag) => readIfdShort(buf, entries.get(tag), littleEndian);
  const getLong = (entries, tag) => readIfdLong(buf, entries.get(tag), littleEndian);
  const getRationals = (entries, tag) => readIfdRationals(buf, entries.get(tag), littleEndian);
  const getByte = (entries, tag) => readIfdByte(buf, entries.get(tag));

  const make = getAscii(ifd0.entries, 0x010f);
  const model = getAscii(ifd0.entries, 0x0110);
  const software = getAscii(ifd0.entries, 0x0131);
  const orientation = getShort(ifd0.entries, 0x0112);
  const dateTime = getAscii(ifd0.entries, 0x0132);

  const exifOffset = getLong(ifd0.entries, 0x8769);
  const exifIfd = exifOffset ? parseTiffIfd(buf, exifOffset, littleEndian) : null;
  const dateTimeOriginal = exifIfd ? getAscii(exifIfd.entries, 0x9003) : undefined;
  const dateTimeDigitized = exifIfd ? getAscii(exifIfd.entries, 0x9004) : undefined;
  const offsetTime = exifIfd ? getAscii(exifIfd.entries, 0x9010) : undefined;
  const offsetTimeOriginal = exifIfd ? getAscii(exifIfd.entries, 0x9011) : undefined;
  const offsetTimeDigitized = exifIfd ? getAscii(exifIfd.entries, 0x9012) : undefined;

  const gpsOffset = getLong(ifd0.entries, 0x8825);
  const gpsIfd = gpsOffset ? parseTiffIfd(buf, gpsOffset, littleEndian) : null;
  const gpsLatRef = gpsIfd ? getAscii(gpsIfd.entries, 0x0001) : undefined;
  const gpsLatVals = gpsIfd ? getRationals(gpsIfd.entries, 0x0002) : undefined;
  const gpsLonRef = gpsIfd ? getAscii(gpsIfd.entries, 0x0003) : undefined;
  const gpsLonVals = gpsIfd ? getRationals(gpsIfd.entries, 0x0004) : undefined;
  const gpsAltRef = gpsIfd ? getByte(gpsIfd.entries, 0x0005) : undefined;
  const gpsAltVals = gpsIfd ? getRationals(gpsIfd.entries, 0x0006) : undefined;

  let altitude = Array.isArray(gpsAltVals) ? gpsAltVals[0] : undefined;
  if (typeof altitude === "number" && gpsAltRef === 1) altitude *= -1;

  return {
    make,
    model,
    software,
    orientation,
    dateTime,
    dateTimeOriginal,
    dateTimeDigitized,
    offsetTime,
    offsetTimeOriginal,
    offsetTimeDigitized,
    gpsLatRef,
    gpsLatVals,
    gpsLonRef,
    gpsLonVals,
    altitude,
  };
};

const downloadToTmp = async (bucket, key) => {
  const { Body, ContentType } = await s3.send(
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
  return { tmpPath, contentType: ContentType };
};

const extractMetadata = async (filePath) => {
  // Prefer pulling EXIF tags directly via identify. If that fails for a format,
  // fall back to parsing the binary EXIF profile (via `convert exif:-`).
  const identifyFormat = [
    "%w",
    "%h",
    "%[EXIF:Orientation]",
    "%[EXIF:DateTimeOriginal]",
    "%[EXIF:DateTimeDigitized]",
    "%[EXIF:DateTime]",
    "%[EXIF:OffsetTimeOriginal]",
    "%[EXIF:OffsetTimeDigitized]",
    "%[EXIF:OffsetTime]",
    "%[EXIF:Make]",
    "%[EXIF:Model]",
    "%[EXIF:Software]",
    "%[EXIF:GPSLatitude]",
    "%[EXIF:GPSLatitudeRef]",
    "%[EXIF:GPSLongitude]",
    "%[EXIF:GPSLongitudeRef]",
    "%[EXIF:GPSAltitude]",
    "%[orientation]",
    "%[xmp:CreateDate]",
    "%[photoshop:DateCreated]",
    "%[xmp:CreatorTool]",
  ].join("\n");
  const { stdout: identifyOut } = await execFileAsync(
    IDENTIFY_PATH,
    ["-format", identifyFormat, filePath],
    { env: IMAGEMAGICK_ENV },
  );
  const identifyParts = String(identifyOut).split(/\r?\n/);
  const [
    widthRaw,
    heightRaw,
    exifOrientationRaw,
    exifDateTimeOriginal,
    exifDateTimeDigitized,
    exifDateTime,
    exifOffsetTimeOriginal,
    exifOffsetTimeDigitized,
    exifOffsetTime,
    exifMake,
    exifModel,
    exifSoftware,
    exifGpsLat,
    exifGpsLatRef,
    exifGpsLon,
    exifGpsLonRef,
    exifGpsAlt,
    orientationStr,
    xmpCreateDate,
    psDateCreated,
    xmpCreatorTool,
  ] = identifyParts;

  let exif = {};
  try {
    const { stdout: exifOut } = await execFileAsync(
      CONVERT_PATH,
      [filePath, "exif:-"],
      { env: IMAGEMAGICK_ENV, encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
    );
    const exifBuf = Buffer.isBuffer(exifOut) ? exifOut : Buffer.from(exifOut || "");
    exif = parseExifProfile(exifBuf);
  } catch (error) {
    console.warn("Failed to extract EXIF profile", error);
  }

  const captureTimeCandidate = (() => {
    const raw = firstNonEmpty(
      exifDateTimeOriginal,
      exifDateTimeDigitized,
      exifDateTime,
      exif.dateTimeOriginal,
      exif.dateTimeDigitized,
      exif.dateTime,
      psDateCreated,
      xmpCreateDate,
    );
    if (!raw) return undefined;
    const tz =
      cleanString(exifOffsetTimeOriginal) ||
      cleanString(exifOffsetTimeDigitized) ||
      cleanString(exifOffsetTime) ||
      cleanString(exif.offsetTimeOriginal) ||
      cleanString(exif.offsetTimeDigitized) ||
      cleanString(exif.offsetTime);
    if (tz && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) return `${raw}${tz}`;
    return raw;
  })();

  const captureLatCandidate =
    parseGpsDms(exifGpsLat, exifGpsLatRef) ??
    parseGpsFromRationals(exif.gpsLatVals, exif.gpsLatRef);
  const captureLonCandidate =
    parseGpsDms(exifGpsLon, exifGpsLonRef) ??
    parseGpsFromRationals(exif.gpsLonVals, exif.gpsLonRef);
  const captureAltCandidate =
    parseRational(exifGpsAlt) ??
    (typeof exif.altitude === "number" ? exif.altitude : undefined);

  const orientationCandidate =
    (() => {
      const parsed = parseRational(exifOrientationRaw);
      if (typeof parsed === "number" && Number.isFinite(parsed)) return Math.round(parsed);
      return undefined;
    })() ||
    (typeof exif.orientation === "number" ? exif.orientation : undefined) ||
    orientationFromString(orientationStr);

  const result = {
    width: Number(widthRaw) || undefined,
    height: Number(heightRaw) || undefined,
    captureTime: parseExifDate(captureTimeCandidate),
    deviceMake: firstNonEmpty(exifMake, exif.make),
    deviceModel: firstNonEmpty(exifModel, exif.model),
    deviceSoftware: firstNonEmpty(exifSoftware, exif.software, xmpCreatorTool),
    captureLat: captureLatCandidate,
    captureLon: captureLonCandidate,
    captureAlt: captureAltCandidate,
    orientation: orientationCandidate,
  };
  console.log("photo metadata sample", {
    width: result.width,
    height: result.height,
    captureTime: result.captureTime,
    deviceMake: result.deviceMake,
    deviceModel: result.deviceModel,
    deviceSoftware: result.deviceSoftware,
    captureLat: result.captureLat,
    captureLon: result.captureLon,
    orientation: result.orientation,
  });
  return result;
};

const makeThumbnail = async ({ filePath, userId, photoId }) => {
  if (!THUMBNAIL_BUCKET) return null;
  const thumbName = `${photoId}.jpg`;
  // Keep the thumbnail prefix consistent with the original upload key:
  // `photo/<email>/...` (no encoding). This also avoids bucket policy surprises.
  const targetKey = `photo/${userId}/${thumbName}`;
  const tmpThumb = path.join(
    os.tmpdir(),
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${thumbName}`,
  );
  try {
    await execFileAsync(
      CONVERT_PATH,
      [
        filePath,
        "-auto-orient",
        "-thumbnail",
        "640x640>",
        "-strip",
        tmpThumb,
      ],
      { env: IMAGEMAGICK_ENV },
    );
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

      // This lambda is meant to process originals only. If it is accidentally wired to the
      // thumbnail bucket it can create incorrect `photoId` values (no `_` in filename) and
      // overwrite thumbnails. Guard against that.
      if (THUMBNAIL_BUCKET && bucket === THUMBNAIL_BUCKET) {
        continue;
      }

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

      const { tmpPath, contentType } = await downloadToTmp(bucket, decodedKey);
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
        const resolvedContentType = (() => {
          const cleaned = cleanString(contentType);
          if (cleaned && cleaned !== "application/octet-stream") return cleaned;
          return guessContentType(decodedKey);
        })();
        addField("contentType", resolvedContentType);
        // Always upsert non-user-editable metadata (so we can backfill via reprocessing).
        addField("captureTime", metadata.captureTime);
        addFieldIfMissing("captureLat", metadata.captureLat);
        addFieldIfMissing("captureLon", metadata.captureLon);
        addFieldIfMissing("originalCaptureLat", metadata.captureLat);
        addFieldIfMissing("originalCaptureLon", metadata.captureLon);
        addField("captureAlt", metadata.captureAlt);
        addField("width", metadata.width);
        addField("height", metadata.height);
        addField("orientation", metadata.orientation);
        addField("deviceMake", metadata.deviceMake);
        addField("deviceModel", metadata.deviceModel);
        addField("deviceSoftware", metadata.deviceSoftware);

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
