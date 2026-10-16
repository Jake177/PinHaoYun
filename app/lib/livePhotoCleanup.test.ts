import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const load = createRequire(import.meta.url);
const db = load("@aws-sdk/client-dynamodb"), storage = load("@aws-sdk/client-s3");
const email = "live@example.invalid", key = `photo/${email}/asset_live.mov`;
beforeEach(() => {
  vi.stubEnv("VIDEOS_TABLE", "development-media"); vi.stubEnv("S3_ORIGINAL_BUCKET", "development-original"); vi.stubEnv("S3_THUMBNAIL_BUCKET", "development-thumbnail");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each([false, true])("rechecks Live Photo movie cleanup when a fenced write fails (deletion=%s)", async deleted => {
  let rejected = false, profileReads = 0;
  vi.spyOn(db.DynamoDBClient.prototype, "send").mockImplementation(async (command: any) => {
    if (command instanceof db.GetItemCommand) {
      const sk = command.input.Key.sk.S;
      if (sk === "PROFILE") {
        profileReads++;
        // The transaction wrapper's first rejection recheck may itself fail.
        if (deleted && rejected && profileReads === 2) throw new Error("temporary read failure");
        return { Item: { userSub: { S: "owner" }, accountStatus: { S: rejected && deleted ? "DELETING" : "ACTIVE" } } };
      }
      return {};
    }
    if (command instanceof db.TransactWriteItemsCommand) { rejected = true; throw Object.assign(new Error("fenced"), { name: "TransactionCanceledException" }); }
    return {};
  });
  const s3 = vi.spyOn(storage.S3Client.prototype, "send").mockResolvedValue({ Metadata: { "owner-sub": "owner" } });
  const path = "../../aws/lambda/photoIngest.js";
  delete load.cache[load.resolve(path)];
  await expect(load(path).handler({ Records: [{ s3: { bucket: { name: "development-original" }, object: { key, size: 12 } } }] })).rejects.toThrow(deleted ? "temporary read failure" : "fenced");
  expect(profileReads).toBeGreaterThanOrEqual(3);
  const deletes = s3.mock.calls.filter(([command]: any) => command instanceof storage.DeleteObjectCommand);
  expect(deletes).toHaveLength(deleted ? 1 : 0);
  if (deleted) expect((deletes[0][0] as { input: unknown }).input).toEqual({ Bucket: "development-original", Key: key });
});
it("does not delete a still image's thumbnail when replaying a rejected Live Photo movie", async () => {
  vi.spyOn(db.DynamoDBClient.prototype, "send").mockImplementation(async (command: any) => ({ Item: command.input.Key.sk.S === "PROFILE" ? { userSub: { S: "owner" }, accountStatus: { S: "ACTIVE" } } : { status: { S: "READY" }, uploadConfirmed: { BOOL: true }, rejectedUploadKey: { S: key } } }));
  const s3 = vi.spyOn(storage.S3Client.prototype, "send").mockResolvedValue({ Metadata: { "owner-sub": "owner" } });
  const path = "../../aws/lambda/photoIngest.js";
  delete load.cache[load.resolve(path)];
  await expect(load(path).handler({ Records: [{ s3: { bucket: { name: "development-original" }, object: { key, size: 12 } } }] })).resolves.toEqual({ ok: true });
  const deletes = s3.mock.calls.filter(([command]: any) => command instanceof storage.DeleteObjectCommand);
  expect(deletes.length).toBeGreaterThan(0);
  for (const [command] of deletes as any) expect(command.input).toEqual({ Bucket: "development-original", Key: key });
});
