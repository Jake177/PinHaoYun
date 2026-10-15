import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const load = createRequire(import.meta.url);
const db = load("@aws-sdk/client-dynamodb");
const storage = load("@aws-sdk/client-s3");
const queue = load("@aws-sdk/client-sqs");
const { marshall, unmarshall } = load("@aws-sdk/util-dynamodb");
const email = "cleanup@example.invalid", subject = "owner";
const originalBucket = "development-original", thumbnailBucket = "development-thumbnail";
let profile: any, reservations: Map<string, any>, media: any, objects: Map<string, any>;
let finalized: boolean, failThumbnail: boolean, pages: any[][];
let operations: string[], reservationQueries: any[], transactions: any[];

function worker() {
  const path = "../../aws/lambda/cleanupUploads.js";
  delete load.cache[load.resolve(path)];
  return load(path).handler;
}
function reserve(id: string, role = "image", size = 12) {
  const photo = role !== "video";
  const r = { sk: photo ? `RESERVE#PHOTO#${id}` : `RESERVE#${id}`, key: `${photo ? "photo" : "video"}/${email}/${photo ? `${id}_${role === "liveVideo" ? "live.mov" : "image.heic"}` : id}`, mediaRole: role, size, ownerSub: subject, uploadId: id, expiresAt: 1 };
  reservations.set(r.sk, r);
  return r;
}
beforeEach(() => {
  vi.stubEnv("VIDEOS_TABLE", "development-media");
  vi.stubEnv("S3_ORIGINAL_BUCKET", originalBucket);
  vi.stubEnv("S3_THUMBNAIL_BUCKET", thumbnailBucket);
  profile = { email, sk: "PROFILE", userSub: subject, usedBytes: 100, reservedBytes: 12, photoBytes: 100, photoCount: 1 };
  reservations = new Map(); objects = new Map(); media = {}; finalized = false; failThumbnail = false; pages = [];
  operations = []; reservationQueries = []; transactions = [];
  vi.spyOn(queue.SQSClient.prototype, "send").mockResolvedValue({});
  vi.spyOn(db.DynamoDBClient.prototype, "send").mockImplementation(async (command: any) => {
    const { input } = command;
    if (command instanceof db.ScanCommand) return { Items: [marshall(profile)] };
    if (command instanceof db.QueryCommand) {
      if (input.FilterExpression) return {};
      reservationQueries.push(input);
      const index = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.sk.S) : 0;
      const current = pages.length ? pages[index] : [...reservations.values()];
      return { Items: current.map((r: any) => marshall(r)), ...(index + 1 < pages.length ? { LastEvaluatedKey: { email: { S: email }, sk: { S: String(index + 1) } } } : {}) };
    }
    if (command instanceof db.GetItemCommand) return { Item: marshall(media) };
    if (command instanceof db.TransactWriteItemsCommand) {
      transactions.push(input.TransactItems);
      if (input.TransactItems[0].Update) {
        if (finalized) throw Object.assign(new Error("finalized concurrently"), { name: "TransactionCanceledException" });
        operations.push("fence");
        const r = reservations.get(input.TransactItems[0].Update.Key.sk.S);
        r.cleanupPending = true; delete r.expiresAt;
        media = r.mediaRole === "liveVideo" ? { ...media, rejectedUploadKey: r.key, liveVideoKey: r.key, liveVideoBucket: originalBucket } : { ...media, status: "DELETED", uploadConfirmed: false };
      } else {
        operations.push("release");
        reservations.delete(input.TransactItems[0].Delete.Key.sk.S);
        const change = input.TransactItems[1];
        if (change.Put) media = unmarshall(change.Put.Item);
        else for (const field of change.Update.UpdateExpression.slice("REMOVE ".length).split(", ")) delete media[field];
      }
    }
    if (command instanceof db.UpdateItemCommand) {
      if (input.Key.sk.S === "PROFILE") { operations.push("reconcile"); profile.reservedBytes = Number(input.ExpressionAttributeValues[":total"].N); }
      else { operations.push("renew"); reservations.get(input.Key.sk.S).expiresAt = Number(input.ExpressionAttributeValues[":expires"].N); }
    }
    return {};
  });
  vi.spyOn(storage.S3Client.prototype, "send").mockImplementation(async (command: any) => {
    const { input } = command;
    if (command instanceof storage.HeadObjectCommand) {
      if (!objects.has(input.Key)) throw Object.assign(new Error("missing"), { name: "NotFound" });
      return objects.get(input.Key);
    }
    if (command instanceof storage.AbortMultipartUploadCommand) throw Object.assign(new Error("completed"), { name: "NoSuchUpload" });
    if (command instanceof storage.DeleteObjectCommand) {
      operations.push(`delete:${input.Key}`);
      if (input.Bucket === thumbnailBucket && failThumbnail) throw new Error("S3 unavailable");
      objects.delete(input.Key);
    }
    return {};
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("expired upload cleanup", () => {
  it.each(["length", "owner"])("fences and removes invalid completed originals and thumbnails before releasing quota (%s)", async mismatch => {
    const r = reserve("asset");
    media = { originalPhotoBucket: originalBucket, originalPhotoKey: r.key, thumbnailBucket, thumbnailKey: "photo/thumbnail.jpg" };
    objects.set(r.key, { ContentLength: mismatch === "length" ? 13 : 12, Metadata: { "owner-sub": mismatch === "owner" ? "other" : subject } });
    objects.set(media.thumbnailKey, {});
    await worker()();
    expect(operations).toEqual(["fence", `delete:${r.key}`, "delete:photo/thumbnail.jpg", "release", "reconcile"]);
    expect(reservations.size).toBe(0);
    expect(objects.size).toBe(0);
    expect(media).toEqual({ email, sk: "PHOTO#asset", status: "DELETED", uploadConfirmed: false });
    expect(profile).toMatchObject({ usedBytes: 100, reservedBytes: 0, photoCount: 1 });
    expect(transactions[0][0].Update).toMatchObject({ UpdateExpression: "SET cleanupPending = :yes REMOVE expiresAt", ConditionExpression: expect.stringContaining("uploadId = :upload") });
    expect(transactions[0][1].Update.ConditionExpression).toContain("attribute_not_exists(#marker)");
  });

  it("keeps a durable reservation, references and quota when S3 deletion fails, then retries", async () => {
    const r = reserve("retry");
    media = { thumbnailBucket, thumbnailKey: "photo/retry.jpg" };
    objects.set(r.key, { ContentLength: 99, Metadata: { "owner-sub": subject } });
    objects.set(media.thumbnailKey, {}); failThumbnail = true;
    const handler = worker();
    await expect(handler()).rejects.toThrow("S3 unavailable");
    expect(reservations.get(r.sk)).toMatchObject({ cleanupPending: true });
    expect(reservations.get(r.sk)).not.toHaveProperty("expiresAt");
    expect(media.thumbnailKey).toBe("photo/retry.jpg");
    expect(profile.reservedBytes).toBe(12);
    expect(operations).not.toContain("release");
    failThumbnail = false;
    await handler();
    expect(objects.size).toBe(0); expect(reservations.size).toBe(0); expect(profile.reservedBytes).toBe(0);
  });

  it("cleans only the invalid Live Photo movie and preserves its charged still photo", async () => {
    const r = reserve("live", "liveVideo");
    media = { status: "READY", uploadConfirmed: true, originalPhotoKey: "photo/still.heic", thumbnailBucket, thumbnailKey: "photo/still.jpg", liveVideoKey: r.key, liveVideoSize: 99 };
    objects.set(r.key, { ContentLength: 99, Metadata: { "owner-sub": subject } });
    objects.set(media.originalPhotoKey, {}); objects.set(media.thumbnailKey, {});
    await worker()();
    expect(media).toMatchObject({ status: "READY", uploadConfirmed: true, originalPhotoKey: "photo/still.heic", thumbnailKey: "photo/still.jpg", rejectedUploadKey: r.key });
    expect(media).not.toHaveProperty("liveVideoKey");
    expect([...objects.keys()]).toEqual(["photo/still.heic", "photo/still.jpg"]);
    expect(profile).toMatchObject({ usedBytes: 100, photoBytes: 100, photoCount: 1, reservedBytes: 0 });
  });

  it("renews a valid completed upload without deleting or unreserving it", async () => {
    const r = reserve("valid");
    objects.set(r.key, { ContentLength: r.size, Metadata: { "owner-sub": subject } });
    await worker()();
    expect(operations).toEqual(["renew", "reconcile"]);
    expect(r.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(profile.reservedBytes).toBe(r.size);
    expect(reservations.size).toBe(1);
  });

  it("does not delete storage or reconcile a stale snapshot after concurrent finalization wins the fence", async () => {
    const r = reserve("race"); finalized = true;
    objects.set(r.key, { ContentLength: 99 });
    await worker()();
    expect(operations).toEqual([]);
    expect(objects.has(r.key)).toBe(true);
    expect(profile.reservedBytes).toBe(12);
  });

  it("processes every reservation page before applying a complete quota total", async () => {
    const expired = reserve("expired", "video");
    const completed = reserve("completed", "video", 20);
    const active = reserve("active", "video", 30); active.expiresAt = Date.now() / 1000 + 3600;
    objects.set(completed.key, { ContentLength: 20, Metadata: { "owner-sub": subject } });
    pages = [[expired], [], [completed, active]]; profile.reservedBytes = 62;
    await worker()();
    expect(reservationQueries).toHaveLength(3);
    expect(reservationQueries.map(input => input.ExclusiveStartKey?.sk.S)).toEqual([undefined, "1", "2"]);
    expect([...reservations.values()].map(r => r.uploadId)).toEqual(["completed", "active"]);
    expect(profile.reservedBytes).toBe(50);
    expect(operations[operations.length - 1]).toBe("reconcile");
  });
});
