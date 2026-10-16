import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const load = createRequire(import.meta.url);
const db = load("@aws-sdk/client-dynamodb"), storage = load("@aws-sdk/client-s3");
const child = load("node:child_process");
const email = "processor@example.invalid";
const originalBucket = "development-original", thumbnailBucket = "development-thumbnail";
beforeEach(() => {
  vi.stubEnv("VIDEOS_TABLE", "development-media"); vi.stubEnv("S3_ORIGINAL_BUCKET", originalBucket); vi.stubEnv("S3_THUMBNAIL_BUCKET", thumbnailBucket);
  vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
  // Exercise the real handlers, files and stream pipeline without Lambda binary layers.
  const exec = vi.spyOn(child, "execFile");
  Object.defineProperty(exec, promisify.custom, { configurable: true, value: async (program: string, args: string[]) => {
    if (program.endsWith("ffprobe")) return { stdout: '{"streams":[],"format":{}}' };
    if (args[args.length - 1].endsWith(".jpg")) await writeFile(args[args.length - 1], "thumbnail fixture");
    return { stdout: program.endsWith("identify") ? "10\n10" : "" };
  } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function scenario(kind: string, failure: string, race = true) {
  const photo = kind === "photo", id = photo ? "asset" : "asset_clip.mov";
  const key = `${kind}/${email}/${photo ? "asset_image.heic" : id}`;
  const thumbnailKey = `${kind}/${photo ? email : encodeURIComponent(email)}/${id}.jpg`;
  const event = { Records: [{ s3: { bucket: { name: originalBucket }, object: { key, size: 12 } } }] };
  let deleted = false, originalPresent = true, thumbnailPresent = false;
  let originalFailures = failure === "original" ? 2 : 0, thumbnailFailures = failure === "thumbnail" ? 1 : 0;
  vi.spyOn(db.DynamoDBClient.prototype, "send").mockImplementation(async (command: any) => {
    if (command instanceof db.GetItemCommand) return { Item: command.input.Key.sk.S === "PROFILE" ? { userSub: { S: "owner" }, accountStatus: { S: "ACTIVE" } } : deleted ? { status: { S: "DELETED" } } : undefined };
    if (command instanceof db.TransactWriteItemsCommand && deleted) throw Object.assign(new Error("fenced"), { name: "TransactionCanceledException" });
    return {};
  });
  const s3 = vi.spyOn(storage.S3Client.prototype, "send").mockImplementation(async (command: any) => {
    const { input } = command;
    if (command instanceof storage.HeadObjectCommand) {
      if (!originalPresent) throw Object.assign(new Error("original already removed"), { name: "NotFound" });
      return { Metadata: { "owner-sub": "owner" } };
    }
    if (command instanceof storage.GetObjectCommand) return { Body: Readable.from(["original fixture"]) };
    if (command instanceof storage.PutObjectCommand) {
      if (!Buffer.isBuffer(input.Body)) for await (const chunk of input.Body) void chunk;
      expect(input.Key).toBe(thumbnailKey);
      thumbnailPresent = true; deleted = race;
      // A successful write can lose its acknowledgement, leaving thumbResult unset.
      if (failure === "publish") throw new Error("thumbnail acknowledgement lost");
    }
    if (command instanceof storage.DeleteObjectCommand) {
      if (input.Bucket === originalBucket && input.Key === key) {
        if (originalFailures-- > 0) throw new Error("original delete unavailable");
        originalPresent = false;
      } else if (input.Bucket === thumbnailBucket && input.Key === thumbnailKey) {
        if (thumbnailFailures-- > 0) throw new Error("thumbnail delete unavailable");
        thumbnailPresent = false;
      } else throw new Error("unexpected object deletion");
    }
    return {};
  });
  const path = `../../aws/lambda/${photo ? "photoIngest" : "transcodeVideo"}.js`;
  const reload = () => { delete load.cache[load.resolve(path)]; return load(path).handler; };
  return { handler: reload(), reload, event, s3, present: () => ({ original: originalPresent, thumbnail: thumbnailPresent }) };
}

it.each(["video", "photo"].flatMap(kind => ["original", "thumbnail", "publish"].map(failure => [kind, failure])))("retries rejected %s cleanup after a %s failure and finishes without reprocessing", async (kind, failure) => {
  const s = scenario(kind, failure);
  await expect(s.handler(s.event)).rejects.toThrow();
  if (failure === "thumbnail") expect(s.present()).toEqual({ original: false, thumbnail: true });
  if (failure === "original") expect(s.present()).toEqual({ original: true, thumbnail: true });
  await expect(s.reload()(s.event)).resolves.toEqual({ ok: true });
  expect(s.present()).toEqual({ original: false, thumbnail: false });
  expect(s.s3.mock.calls.filter(([command]: any) => command instanceof storage.GetObjectCommand)).toHaveLength(1);
  expect(s.s3.mock.calls.filter(([command]: any) => command instanceof storage.PutObjectCommand)).toHaveLength(1);
});

it.each(["video", "photo"])("preserves the original and thumbnail after an accepted %s write", async kind => {
  const s = scenario(kind, "none", false);
  await expect(s.handler(s.event)).resolves.toEqual({ ok: true });
  expect(s.present()).toEqual({ original: true, thumbnail: true });
  expect(s.s3.mock.calls.filter(([command]: any) => command instanceof storage.DeleteObjectCommand)).toHaveLength(0);
});
