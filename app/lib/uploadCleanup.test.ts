import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discardUnconfirmedUpload, rejectDeletedBackup, finalizeConcurrentDuplicate } from "./backupDeletion";

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
let failAbort: boolean, failOriginal: boolean, releaseFailures: number, suppressed: boolean;
let duplicates: Map<string, any>;

function worker() {
  const path = "../../aws/lambda/cleanupUploads.js";
  delete load.cache[load.resolve(path)];
  return load(path).handler;
}
function deleteMedia() {
  const path = "../../aws/lambda/deleteVideo.js";
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
  failAbort = false; failOriginal = false; releaseFailures = 0; suppressed = false; duplicates = new Map();
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
    if (command instanceof db.GetItemCommand) {
      const sk = input.Key.sk.S;
      const item = sk === "PROFILE" ? profile : sk.startsWith("RESERVE#") ? reservations.get(sk) : sk.startsWith("BACKUP_DELETED#") ? (suppressed ? { sk } : undefined) : duplicates.get(sk) || media;
      return item ? { Item: marshall(item) } : {};
    }
    if (command instanceof db.TransactWriteItemsCommand) {
      transactions.push(input.TransactItems);
      if (input.TransactItems[0].Put) {
        operations.push("delete-media");
        media = unmarshall(input.TransactItems[0].Put.Item);
        const change = input.TransactItems[1].Update;
        profile.usedBytes = Number(change.ExpressionAttributeValues[":used"].N);
        profile.reservedBytes = Number(change.ExpressionAttributeValues[":reserved"].N);
        profile[change.ExpressionAttributeNames["#bytes"]] = Number(change.ExpressionAttributeValues[":bytes"].N);
        profile[change.ExpressionAttributeNames["#count"]] = Number(change.ExpressionAttributeValues[":count"].N);
      } else if (input.TransactItems[0].Update) {
        const change = input.TransactItems[0].Update;
        const r = reservations.get(change.Key.sk.S);
        if (finalized || !r || (r.cleanupOwner && r.cleanupLeaseUntil > Date.now())) throw Object.assign(new Error("cleanup fence conflict"), { name: "TransactionCanceledException" });
        operations.push("fence");
        r.cleanupPending = true; delete r.expiresAt;
        r.cleanupOwner = change.ExpressionAttributeValues[":owner"].S; r.cleanupLeaseUntil = Number(change.ExpressionAttributeValues[":until"].N);
        media = r.mediaRole === "liveVideo" ? { ...media, rejectedUploadKey: r.key, liveVideoKey: r.key, liveVideoBucket: originalBucket } : { ...media, status: "DELETED", uploadConfirmed: false };
        const duplicate = input.TransactItems[1].Update.ExpressionAttributeValues[":duplicate"]?.S;
        if (duplicate) media.duplicateOf = duplicate;
      } else {
        if (releaseFailures-- > 0) throw Object.assign(new Error("release conflict"), { name: "TransactionCanceledException" });
        const change = input.TransactItems[0].Delete;
        if (change.ExpressionAttributeValues[":owner"] && reservations.get(change.Key.sk.S)?.cleanupOwner !== change.ExpressionAttributeValues[":owner"].S) throw Object.assign(new Error("lease lost"), { name: "TransactionCanceledException" });
        operations.push("release");
        reservations.delete(input.TransactItems[0].Delete.Key.sk.S);
        const mediaChange = input.TransactItems.find((item: any) => item.Put || item.Update?.Key.sk.S.startsWith("PHOTO#") || item.Update?.Key.sk.S.startsWith("VIDEO#"));
        if (mediaChange.Put) media = unmarshall(mediaChange.Put.Item);
        else for (const field of mediaChange.Update.UpdateExpression.slice("REMOVE ".length).split(", ")) delete media[field];
        const quota = input.TransactItems.find((item: any) => item.Update?.Key.sk.S === "PROFILE");
        if (quota) profile.reservedBytes += Number(quota.Update.ExpressionAttributeValues[":negative"].N);
      }
    }
    if (command instanceof db.UpdateItemCommand) {
      if (input.UpdateExpression === "REMOVE cleanupOwner, cleanupLeaseUntil") {
        const r = reservations.get(input.Key.sk.S);
        if (!r || r.cleanupOwner !== input.ExpressionAttributeValues[":owner"].S) throw Object.assign(new Error("not owner"), { name: "ConditionalCheckFailedException" });
        delete r.cleanupOwner; delete r.cleanupLeaseUntil;
      } else if (input.Key.sk.S === "PROFILE") { operations.push("reconcile"); profile.reservedBytes = Number(input.ExpressionAttributeValues[":total"].N); }
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
    if (command instanceof storage.AbortMultipartUploadCommand) {
      if (failAbort) throw new Error("abort unavailable");
      throw Object.assign(new Error("completed"), { name: "NoSuchUpload" });
    }
    if (command instanceof storage.DeleteObjectCommand) {
      operations.push(`delete:${input.Key}`);
      if (input.Bucket === originalBucket && failOriginal) throw new Error("original unavailable");
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
    expect(operations).toEqual(["fence", `delete:${r.key}`, `delete:photo/${email}/asset.jpg`, "delete:photo/thumbnail.jpg", "release", "reconcile"]);
    expect(reservations.size).toBe(0);
    expect(objects.size).toBe(0);
    expect(media).toEqual({ email, sk: "PHOTO#asset", status: "DELETED", uploadConfirmed: false });
    expect(profile).toMatchObject({ usedBytes: 100, reservedBytes: 0, photoCount: 1 });
    expect(transactions[0][0].Update).toMatchObject({ UpdateExpression: expect.stringContaining("REMOVE expiresAt"), ConditionExpression: expect.stringContaining("uploadId = :upload") });
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

describe("shared cancellation and scheduled cleanup", () => {
  const hash = "a".repeat(64) + "-12";
  it("keeps a confirmed original when completion wins before manual cancellation", async () => {
    const r = reserve("confirmed"); finalized = true;
    media = { status: "READY", uploadConfirmed: true, originalPhotoKey: r.key };
    objects.set(r.key, { ContentLength: 12 });
    await expect(discardUnconfirmedUpload(email, subject, r.key, r.uploadId)).rejects.toThrow("conflict");
    expect(operations).toEqual([]);
    expect(objects.has(r.key)).toBe(true);
    expect(profile).toMatchObject({ reservedBytes: 12, usedBytes: 100, photoCount: 1 });
  });

  it("cancels an unconfirmed Live Photo movie without changing its confirmed still image or counters", async () => {
    const r = reserve("manual-live", "liveVideo");
    media = { status: "READY", uploadConfirmed: true, originalPhotoKey: "photo/still.heic", thumbnailBucket, thumbnailKey: "photo/still.jpg" };
    for (const key of [r.key, media.originalPhotoKey, media.thumbnailKey]) objects.set(key, {});
    expect(await discardUnconfirmedUpload(email, subject, r.key, r.uploadId)).toBe(true);
    expect([...objects.keys()]).toEqual(["photo/still.heic", "photo/still.jpg"]);
    expect(media).toMatchObject({ status: "READY", uploadConfirmed: true, originalPhotoKey: "photo/still.heic", thumbnailKey: "photo/still.jpg" });
    expect(profile).toMatchObject({ reservedBytes: 0, usedBytes: 100, photoCount: 1, photoBytes: 100 });
  });

  it.each(["abort", "original", "thumbnail"])("retains a manual cancellation across %s failure, then releases quota exactly once", async failure => {
    const r = reserve("manual");
    r.expiresAt = Date.now() / 1000 + 3600;
    media = { thumbnailBucket, thumbnailKey: `photo/${email}/manual.jpg` };
    objects.set(r.key, { ContentLength: 12 }); objects.set(media.thumbnailKey, {});
    failAbort = failure === "abort"; failOriginal = failure === "original"; failThumbnail = failure === "thumbnail";
    await expect(discardUnconfirmedUpload(email, subject, r.key, r.uploadId)).rejects.toThrow("unavailable");
    expect(reservations.get(r.sk)).toMatchObject({ cleanupPending: true, key: r.key, uploadId: r.uploadId });
    expect(reservations.get(r.sk)).not.toHaveProperty("expiresAt");
    expect(reservations.get(r.sk)).not.toHaveProperty("cleanupOwner");
    expect(media.thumbnailKey).toBe(`photo/${email}/manual.jpg`);
    expect(profile.reservedBytes).toBe(12); expect(operations).not.toContain("release");
    failAbort = false; failOriginal = false; failThumbnail = false;
    expect(await discardUnconfirmedUpload(email, subject, r.key, r.uploadId)).toBe(true);
    expect(reservations.size).toBe(0); expect(objects.size).toBe(0);
    expect(profile).toMatchObject({ usedBytes: 100, photoCount: 1, reservedBytes: 0 });
    expect(await discardUnconfirmedUpload(email, subject, r.key, r.uploadId)).toBe(false);
    expect(operations.filter(op => op === "release")).toHaveLength(1);
  });

  it.each(["suppression", "duplicate"])("lets the scheduled worker finish a failed %s cleanup without losing its tombstone", async source => {
    const r: any = reserve("automatic"); r.uploadSource = "automatic"; r.backupHash = hash;
    media = { thumbnailBucket, thumbnailKey: `photo/${email}/automatic.jpg` };
    objects.set(r.key, { ContentLength: 12 }); objects.set(media.thumbnailKey, {});
    failThumbnail = true; suppressed = source === "suppression";
    duplicates.set(`HASH#PHOTO#${hash}`, { mediaId: "confirmed-target" });
    duplicates.set("PHOTO#confirmed-target", { status: "READY", uploadConfirmed: true });
    const invoke = () => source === "suppression" ? rejectDeletedBackup(email, subject, r.key) : finalizeConcurrentDuplicate(email, subject, r.key, hash);
    await expect(invoke()).rejects.toThrow("S3 unavailable");
    expect(profile.reservedBytes).toBe(12);
    failThumbnail = false;
    await worker()();
    expect(reservations.size).toBe(0); expect(objects.size).toBe(0); expect(profile.reservedBytes).toBe(0);
    if (source === "duplicate") expect(media.duplicateOf).toBe("confirmed-target");
    expect(duplicates.get("PHOTO#confirmed-target")).toEqual({ status: "READY", uploadConfirmed: true });
  });

  it("prevents a second cleaner from deleting objects while another cleaner owns the upload", async () => {
    const r = reserve("concurrent");
    let unlock!: () => void, entered!: () => void;
    const paused = new Promise<void>(resolve => { unlock = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const send = vi.mocked(storage.S3Client.prototype.send), original = send.getMockImplementation()!;
    send.mockImplementation(async (command: any) => {
      if (command instanceof storage.AbortMultipartUploadCommand) { entered(); await paused; }
      return original(command);
    });
    const first = discardUnconfirmedUpload(email, subject, r.key, r.uploadId);
    try {
      await started;
      expect(await discardUnconfirmedUpload(email, subject, r.key, r.uploadId)).toBe(false);
      await worker()();
      await expect(deleteMedia()({ Records: [{ body: JSON.stringify({ email, mediaType: "PHOTO", mediaId: "concurrent", userSub: subject }) }] })).rejects.toThrow("conflict");
      expect(operations.filter(op => op === "fence")).toHaveLength(1);
      expect(operations.some(op => op.startsWith("delete:"))).toBe(false);
      expect(profile.reservedBytes).toBe(12);
    } finally { unlock(); }
    expect(await first).toBe(true);
    expect(reservations.size).toBe(0); expect(profile.reservedBytes).toBe(0);
  });

  it("finishes pending Live Photo upload cleanup before deleting the charged parent, without double quota release", async () => {
    const r = reserve("delete-live", "liveVideo");
    media = { status: "DELETING", uploadConfirmed: true, size: 100, originalPhotoKey: "photo/still.heic", originalPhotoBucket: originalBucket, thumbnailBucket, thumbnailKey: "photo/still.jpg" };
    for (const key of [r.key, media.originalPhotoKey, media.thumbnailKey]) objects.set(key, {});
    const event = { Records: [{ body: JSON.stringify({ email, mediaType: "PHOTO", mediaId: "delete-live", userSub: subject }) }] };
    failAbort = true;
    const handler = deleteMedia();
    await expect(handler(event)).rejects.toThrow("abort unavailable");
    expect(reservations.get(r.sk)).toMatchObject({ cleanupPending: true });
    expect(objects.has("photo/still.heic")).toBe(true); expect(profile.usedBytes).toBe(100); expect(profile.reservedBytes).toBe(12);
    failAbort = false;
    await expect(handler(event)).resolves.toEqual({ ok: true });
    expect(reservations.size).toBe(0); expect(objects.size).toBe(0);
    expect(profile).toMatchObject({ usedBytes: 0, reservedBytes: 0, photoCount: 0, photoBytes: 0 });
    expect(operations.filter(op => op === "release")).toHaveLength(1);
    expect(operations.filter(op => op === "delete-media")).toHaveLength(1);
  });

  it("takes over an expired cleanup lock and retries a quota-release conflict without double charging", async () => {
    const r: any = reserve("crashed");
    r.cleanupPending = true; r.cleanupOwner = "crashed-worker"; r.cleanupLeaseUntil = Date.now() - 1; delete r.expiresAt;
    releaseFailures = 1;
    expect(await discardUnconfirmedUpload(email, subject, r.key, r.uploadId)).toBe(true);
    expect(operations.filter(op => op === "fence")).toHaveLength(2);
    expect(operations.filter(op => op === "release")).toHaveLength(1);
    expect(profile.reservedBytes).toBe(0);
  });
});
