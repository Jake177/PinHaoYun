"use strict";

const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const planData = require("../shared/plans.json");

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
const legacyPlan = planData.plans.LEGACY_5TB;

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

const scanProfiles = async () => {
  const items = [];
  let lastEvaluatedKey;

  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression:
          "#email, sk, planCode, planStatus, quotaBytes, isLegacy, createdAt, updatedAt",
        ExpressionAttributeNames: {
          "#email": "email",
        },
        FilterExpression: emailFilter
          ? "sk = :profile AND #email = :email"
          : "sk = :profile",
        ExpressionAttributeValues: {
          ":profile": { S: "PROFILE" },
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

const shouldMigrate = (item) => {
  if (!item || typeof item !== "object") return false;
  if (typeof item.planCode === "string" && item.planCode.trim()) {
    return false;
  }
  return true;
};

const main = async () => {
  const items = await scanProfiles();
  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    const email = String(item.email || "").toLowerCase();
    if (!email || !shouldMigrate(item)) {
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log("[dry-run] would migrate profile", {
        email,
        currentQuotaBytes: item.quotaBytes || null,
      });
      updated += 1;
      continue;
    }

    const now = new Date().toISOString();

    await ddb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: {
          email: { S: email },
          sk: { S: "PROFILE" },
        },
        UpdateExpression:
          "SET planCode = :planCode, planStatus = :planStatus, quotaBytes = :quotaBytes, isLegacy = :isLegacy, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":planCode": { S: "LEGACY_5TB" },
          ":planStatus": { S: "active" },
          ":quotaBytes": { N: String(legacyPlan.quotaBytes) },
          ":isLegacy": { BOOL: true },
          ":updatedAt": { S: now },
        },
      }),
    );
    updated += 1;
  }

  console.log("Legacy membership backfill complete", {
    scanned: items.length,
    updated,
    skipped,
    dryRun,
    emailFilter: emailFilter || null,
  });
};

main().catch((error) => {
  console.error("Legacy membership backfill failed", error);
  process.exitCode = 1;
});
