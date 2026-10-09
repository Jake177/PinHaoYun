import { createRequire } from "node:module";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { rejectDeletedBackup, suppressionKey } from "./backupDeletion";
const load = createRequire(import.meta.url);
const db = load("@aws-sdk/client-dynamodb");
const storage = load("@aws-sdk/client-s3");
const guard = load("../../aws/lambda/accountGuard.js");
const email = "backup@example.invalid", subject = "backup-subject", hash = "a".repeat(64) + "-12";
const object = { Bucket: "development-original", Key: `photo/${email}/asset_image.png` };
let deleted: boolean;
let source: string;
let reservation: Record<string, unknown> | undefined;
let transactions: unknown[];
let nonce: string | undefined;
let media: Record<string, unknown> | undefined;
let transactionFailures: number;
const update = () => new db.UpdateItemCommand({ TableName: "development-media", Key: { email: { S: email }, sk: { S: "PHOTO#asset" } }, UpdateExpression: "SET updatedAt = :now", ExpressionAttributeValues: { ":now": { S: "now" } } });
beforeEach(async () => {
  vi.stubEnv("VIDEOS_TABLE", "development-media"); vi.stubEnv("S3_ORIGINAL_BUCKET", object.Bucket);
  deleted = false; source = "automatic"; reservation = undefined; transactions = []; nonce = undefined; media = undefined; transactionFailures = 0;
  vi.spyOn(db.DynamoDBClient.prototype, "send").mockImplementation(async (...args: unknown[]) => {
    const command = args[0] as { input: { Key?: { sk: { S: string } }; TransactItems?: unknown[] } };
    const sk = command.input.Key?.sk.S;
    if (sk === "PROFILE") return { Item: { sk: { S: "PROFILE" }, userSub: { S: subject }, accountStatus: { S: "ACTIVE" }, requiresOwnerMetadata: { BOOL: true } } };
    if (sk?.startsWith("BACKUP_DELETED#")) return deleted ? { Item: { sk: { S: sk } } } : {};
    if (sk?.startsWith("RESERVE#")) return reservation ? { Item: reservation } : {};
    if (sk?.startsWith("PHOTO#")) return media ? { Item: media } : {};
    if (command.input.TransactItems) { transactions.push(command.input.TransactItems); if (transactionFailures-- > 0) throw Object.assign(new Error("conflict"), { name: "TransactionCanceledException" }); }
    return {};
  });
  vi.spyOn(storage.S3Client.prototype, "send").mockImplementation(async (...args: unknown[]) => (args[0] as { constructor: { name: string } }).constructor.name === "HeadObjectCommand" ? { Metadata: { "owner-sub": subject, "upload-source": source, "backup-hash": hash, ...(nonce ? { "upload-request-id": nonce } : {}) } } : {});
  await guard.canProcess(email, undefined, "stale-subject");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("automatic backup deletion", () => {
  it("isolates suppression by owner and media type", () => {
    expect(suppressionKey(email, "PHOTO", hash)).not.toEqual(suppressionKey("another@example.invalid", "PHOTO", hash));
    expect(suppressionKey(email, "PHOTO", hash)).not.toEqual(suppressionKey(email, "VIDEO", hash));
  });
  it("rejects delayed automatic originals and deletes the late S3 object", async () => {
    deleted = true;
    expect(await guard.canProcess(email, object)).toBe(false);
    expect(storage.S3Client.prototype.send).toHaveBeenCalledWith(expect.any(storage.DeleteObjectCommand));
  });
  it("checks the deleted fingerprint atomically even after the first check succeeds", async () => {
    expect(await guard.canProcess(email, object)).toBe(true);
    deleted = true;
    const send = vi.fn(async (_command: { input: unknown }) => { throw Object.assign(new Error("late deletion"), { name: "TransactionCanceledException" }); });
    await expect(guard.protectMediaWrites({ send }).send(update())).rejects.toThrow("late deletion");
    expect(send.mock.calls[0][0].input).toMatchObject({ TransactItems: [{ ConditionCheck: { Key: suppressionKey(email, "PHOTO", hash), ConditionExpression: "attribute_not_exists(sk)" } }, {}, {}] });
  });
  it("allows an explicit manual upload without removing the automatic suppression marker", async () => {
    deleted = true; source = "manual";
    expect(await guard.canProcess(email, object)).toBe(true);
    const send = vi.fn(async (_command: { input: unknown }) => ({}));
    await guard.protectMediaWrites({ send }).send(update());
    expect((send.mock.calls[0][0].input as { TransactItems: unknown[] }).TransactItems).toHaveLength(2);
    expect(deleted).toBe(true);
  });
  it("cleans a thumbnail created while deletion was being accepted", async () => {
    expect(await guard.canProcess(email, object)).toBe(true); deleted = true;
    const thumbnail = { Bucket: "development-thumbnail", Key: "late-thumb.jpg" };
    await guard.cleanupRejectedObjects(email, object, [thumbnail]);
    expect(storage.S3Client.prototype.send).toHaveBeenCalledWith(expect.objectContaining({ input: thumbnail }));
  });
  it("releases an in-flight automatic reservation without charging media bytes", async () => {
    deleted = true;
    reservation = { key: { S: object.Key }, uploadId: { S: "upload" }, size: { N: "12" }, uploadSource: { S: "automatic" }, backupHash: { S: hash } };
    expect(await rejectDeletedBackup(email, subject, object.Key)).toBe(true);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject([{}, { Update: { UpdateExpression: "ADD reservedBytes :negative", ExpressionAttributeValues: { ":negative": { N: "-12" } } } }, { Put: { Item: { status: { S: "DELETED" }, uploadConfirmed: { BOOL: false } } } }]);
  });
  it("uses the reservation source so manual reuploads remain allowed", async () => {
    deleted = true;
    reservation = { key: { S: object.Key }, uploadId: { S: "upload" }, size: { N: "12" }, uploadSource: { S: "manual" }, backupHash: { S: hash } };
    expect(await rejectDeletedBackup(email, subject, object.Key)).toBe(false);
    expect(transactions).toHaveLength(0);
  });
  it("fences unconfirmed processing against the exact upload lease", async () => {
    nonce = "fixture-nonce";
    reservation = { key: { S: object.Key }, requestId: { S: nonce } };
    expect(await guard.canProcess(email, object)).toBe(true);
    const send = vi.fn(async (_command: { input: unknown }) => ({}));
    await guard.protectMediaWrites({ send }).send(update());
    expect(send.mock.calls[0][0].input).toMatchObject({ TransactItems: [{ ConditionCheck: { Key: { sk: { S: "RESERVE#PHOTO#asset" } }, ExpressionAttributeValues: { ":request": { S: nonce } } } }, {}, {}, {}] });
  });
  it("does not write metadata after its reservation is cancelled", async () => {
    nonce = "fixture-nonce"; reservation = { key: { S: object.Key }, requestId: { S: nonce } };
    expect(await guard.canProcess(email, object)).toBe(true); reservation = undefined;
    const send = vi.fn(async (_command: { input: unknown }) => { throw Object.assign(new Error("cancelled lease"), { name: "TransactionCanceledException" }); });
    await expect(guard.protectMediaWrites({ send }).send(update())).rejects.toThrow("cancelled lease");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rechecks finalization that consumed the lease while metadata was processing", async () => {
    nonce = "fixture-nonce"; reservation = { key: { S: object.Key }, requestId: { S: nonce } };
    expect(await guard.canProcess(email, object)).toBe(true);
    reservation = undefined; media = { status: { S: "READY" }, uploadConfirmed: { BOOL: true }, originalPhotoKey: { S: object.Key }, contentHash: { S: hash } };
    const send = vi.fn(async (_command: { input: unknown }) => ({})).mockRejectedValueOnce(Object.assign(new Error("lease consumed"), { name: "TransactionCanceledException" }));
    await guard.protectMediaWrites({ send }).send(update());
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[1][0].input as { TransactItems: unknown[] }).TransactItems).toHaveLength(2);
  });
  it("keeps an already-confirmed copy when a different duplicate was deleted", async () => {
    deleted = true; media = { status: { S: "READY" }, uploadConfirmed: { BOOL: true }, originalPhotoKey: { S: object.Key }, contentHash: { S: hash } };
    expect(await guard.canProcess(email, object)).toBe(true);
  });
  it("retries quota-release conflicts instead of silently keeping reserved bytes", async () => {
    deleted = true; transactionFailures = 1;
    reservation = { key: { S: object.Key }, uploadId: { S: "upload" }, size: { N: "12" }, uploadSource: { S: "automatic" }, backupHash: { S: hash } };
    expect(await rejectDeletedBackup(email, subject, object.Key)).toBe(true);
    expect(transactions).toHaveLength(2);
  });
});
