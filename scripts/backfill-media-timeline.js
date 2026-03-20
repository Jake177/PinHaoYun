"use strict";

const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { buildMediaTimelineFields } = require("../aws/lambda/timeline");

const loadLocalEnv = () => {
  const candidates = [".env.local", ".env"];
  for (const fileName of candidates) {
    const filePath = path.resolve(process.cwd(), fileName);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
};

loadLocalEnv();

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const tableName = process.env.VIDEOS_TABLE;

if (!tableName) {
  throw new Error("Missing env VIDEOS_TABLE");
}

const ddb = new DynamoDBClient({ region });

const parseArgs = (argv) => {
  const args = {};
  argv.forEach((entry) => {
    if (!entry.startsWith("--")) return;
    const [key, rawValue] = entry.slice(2).split("=");
    args[key] = rawValue === undefined ? "true" : rawValue;
  });
  return args;
};

const args = parseArgs(process.argv.slice(2));
const dryRun = args["dry-run"] === "true";
const emailFilter = args.email ? String(args.email).toLowerCase() : "";

const deriveMediaIdentity = (item) => {
  const sk = String(item.sk || "");
  if (!sk.startsWith("VIDEO#") && !sk.startsWith("PHOTO#")) return null;
  const mediaType = item.type === "PHOTO" || sk.startsWith("PHOTO#") ? "PHOTO" : "VIDEO";
  const mediaId =
    item.videoId ||
    item.photoId ||
    sk.split("#").slice(1).join("#");
  if (!mediaId) return null;
  return { mediaType, mediaId: String(mediaId) };
};

const scanMediaItems = async () => {
  const items = [];
  let lastEvaluatedKey;

  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression:
          "#email, sk, videoId, photoId, #type, captureTime, fileLastModified, createdAt, mediaAt, mediaAtSource, timelinePk, timelineSk",
        ExpressionAttributeNames: {
          "#email": "email",
          "#type": "type",
        },
        FilterExpression: emailFilter
          ? "((begins_with(sk, :videoPrefix)) OR begins_with(sk, :photoPrefix)) AND #email = :email"
          : "(begins_with(sk, :videoPrefix)) OR begins_with(sk, :photoPrefix)",
        ExpressionAttributeValues: {
          ":videoPrefix": { S: "VIDEO#" },
          ":photoPrefix": { S: "PHOTO#" },
          ...(emailFilter ? { ":email": { S: emailFilter } } : {}),
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    items.push(...((response.Items || []).map((entry) => unmarshall(entry))));
    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
};

const main = async () => {
  const items = await scanMediaItems();
  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    const identity = deriveMediaIdentity(item);
    const email = String(item.email || "").toLowerCase();
    if (!identity || !email) {
      skipped += 1;
      continue;
    }

    const timeline = buildMediaTimelineFields({
      email,
      mediaType: identity.mediaType,
      mediaId: identity.mediaId,
      captureTime: item.captureTime,
      fileLastModified: item.fileLastModified,
      createdAt: item.createdAt,
    });

    const unchanged =
      item.mediaAt === timeline.mediaAt &&
      item.mediaAtSource === timeline.mediaAtSource &&
      item.timelinePk === timeline.timelinePk &&
      item.timelineSk === timeline.timelineSk;

    if (unchanged) {
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log("[dry-run] would update", {
        email,
        sk: item.sk,
        mediaAt: timeline.mediaAt,
        mediaAtSource: timeline.mediaAtSource,
        timelinePk: timeline.timelinePk,
        timelineSk: timeline.timelineSk,
      });
      updated += 1;
      continue;
    }

    await ddb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: {
          email: { S: email },
          sk: { S: String(item.sk) },
        },
        UpdateExpression:
          "SET mediaAt = :mediaAt, mediaAtSource = :mediaAtSource, timelinePk = :timelinePk, timelineSk = :timelineSk",
        ExpressionAttributeValues: {
          ":mediaAt": { S: timeline.mediaAt },
          ":mediaAtSource": { S: timeline.mediaAtSource },
          ":timelinePk": { S: timeline.timelinePk },
          ":timelineSk": { S: timeline.timelineSk },
        },
      }),
    );
    updated += 1;
  }

  console.log("Backfill complete", {
    scanned: items.length,
    updated,
    skipped,
    dryRun,
    emailFilter: emailFilter || null,
  });
};

main().catch((error) => {
  console.error("Backfill failed", error);
  process.exitCode = 1;
});
