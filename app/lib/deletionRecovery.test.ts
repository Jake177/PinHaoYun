import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const load = createRequire(import.meta.url);
const db = load("@aws-sdk/client-dynamodb");
const storage = load("@aws-sdk/client-s3");
const queue = load("@aws-sdk/client-sqs");
const identity = load("@aws-sdk/client-cognito-identity-provider");
const { marshall } = load("@aws-sdk/util-dynamodb");
const email = "erase@example.invalid";
const job = { requestId: "request", email, userSub: "owner", username: "owner", state: "CLEANING", quiesced: true };
const event = { Records: [{ messageId: "message", body: JSON.stringify({ requestId: job.requestId }) }] };

beforeEach(() => {
  vi.stubEnv("VIDEOS_TABLE", "development-media");
  vi.stubEnv("ACCOUNT_DELETIONS_TABLE", "development-deletions");
  vi.stubEnv("S3_ORIGINAL_BUCKET", "development-original");
  vi.stubEnv("S3_THUMBNAIL_BUCKET", "development-thumbnail");
  vi.stubEnv("S3_PROFILE_BUCKET", "development-profile");
  vi.stubEnv("VIDEOS_DELETE_QUEUE_URL", "https://sqs.ap-southeast-2.amazonaws.com/123/deletions");
  vi.spyOn(storage.S3Client.prototype, "send").mockResolvedValue({});
  vi.spyOn(queue.SQSClient.prototype, "send").mockResolvedValue({});
  vi.spyOn(identity.CognitoIdentityProviderClient.prototype, "send").mockResolvedValue({});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function worker(path: string) {
  delete load.cache[load.resolve(path)];
  return load(path);
}

describe("historical account object erasure", () => {
  it.each(["development-profile", undefined, "external-profile"])("checks a PROFILE signature before retaining the profile for quiescence (bucket=%s)", async signatureBucket => {
    const activeJob = { ...job, quiesced: false };
    const profile = { email, sk: "PROFILE", userSub: job.userSub, deletionRequestId: job.requestId, signatureKey: "legacy/profile-signature.png", ...(signatureBucket ? { signatureBucket } : {}) };
    const cursors: unknown[] = [];
    const ddb = vi.spyOn(db.DynamoDBClient.prototype, "send").mockImplementation(async (command: any) => {
      if (command instanceof db.GetItemCommand) return { Item: marshall(command.input.TableName === "development-deletions" ? activeJob : profile) };
      if (command instanceof db.QueryCommand) {
        cursors.push(command.input.ExclusiveStartKey);
        if (cursors.length > 3) throw new Error("Partition cleanup did not advance");
        // A page containing only retained records still has to advance.
        if (!command.input.ExclusiveStartKey) return { Items: [marshall(profile), marshall({ email, sk: "CONSENT" })], LastEvaluatedKey: { email: { S: email }, sk: { S: "PROFILE" } } };
        return { Items: [marshall({ email, sk: "RESERVE#legacy" })] };
      }
      return {};
    });
    const s3 = vi.mocked(storage.S3Client.prototype.send).mockImplementation(async (command: any) => command instanceof storage.ListObjectVersionsCommand && command.input.Prefix === profile.signatureKey ? { Versions: [{ Key: profile.signatureKey, VersionId: "old" }, { Key: `${profile.signatureKey}.other-owner`, VersionId: "neighbor" }], DeleteMarkers: [{ Key: profile.signatureKey, VersionId: "marker" }] } : {});
    expect(await worker("../../aws/lambda/deleteAccount.js").handler(event)).toEqual({ batchItemFailures: [] });
    expect(cursors).toEqual([undefined, { email: { S: email }, sk: { S: "PROFILE" } }]);
    const removed = s3.mock.calls.filter(([command]: any) => command instanceof storage.DeleteObjectsCommand).map(([command]: any) => command.input);
    expect(removed).toEqual(signatureBucket === "external-profile" ? [] : [{ Bucket: "development-profile", Delete: { Quiet: true, Objects: [{ Key: profile.signatureKey, VersionId: "old" }, { Key: profile.signatureKey, VersionId: "marker" }] } }]);
    const deletedRecords = ddb.mock.calls.filter(([command]: any) => command instanceof db.DeleteItemCommand).map(([command]: any) => command.input.Key.sk.S);
    expect(deletedRecords).toEqual(["RESERVE#legacy"]);
    expect(vi.mocked(identity.CognitoIdentityProviderClient.prototype.send).mock.calls.some(([command]: any) => command instanceof identity.AdminDeleteUserCommand)).toBe(false);
    expect(ddb.mock.calls.some(([command]: any) => command.input.ExpressionAttributeValues?.[":done"]?.S === "COMPLETE" && command.input.UpdateExpression?.includes("completedAt"))).toBe(false);
  });

  it("retains a failed profile signature reference and retries before completing account erasure", async () => {
    const profile = { email, sk: "PROFILE", userSub: job.userSub, deletionRequestId: job.requestId, signatureBucket: "development-profile", signatureKey: "legacy/signature.png" };
    let fail = true;
    const ddb = vi.spyOn(db.DynamoDBClient.prototype, "send").mockImplementation(async (command: any) => {
      if (command instanceof db.GetItemCommand) return { Item: marshall(command.input.TableName === "development-deletions" ? job : profile) };
      if (command instanceof db.QueryCommand) return { Items: [marshall(profile)] };
      return {};
    });
    vi.mocked(storage.S3Client.prototype.send).mockImplementation(async (command: any) => {
      if (command instanceof storage.ListObjectVersionsCommand && command.input.Prefix === profile.signatureKey) return { Versions: [{ Key: profile.signatureKey, VersionId: "legacy" }] };
      if (command instanceof storage.DeleteObjectsCommand && fail) return { Errors: [{ Code: "AccessDenied" }] };
      return {};
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = worker("../../aws/lambda/deleteAccount.js").handler;
    expect(await handler(event)).toEqual({ batchItemFailures: [{ itemIdentifier: "message" }] });
    expect(ddb.mock.calls.some(([command]: any) => command instanceof db.DeleteItemCommand)).toBe(false);
    fail = false;
    expect(await handler(event)).toEqual({ batchItemFailures: [] });
    expect(ddb.mock.calls.some(([command]: any) => command instanceof db.DeleteItemCommand && command.input.Key.sk.S === "PROFILE")).toBe(true);
  });

  const record = {
    email, sk: "PHOTO#legacy",
    originalBucket: "development-original", originalKey: "legacy/original.heic",
    liveVideoBucket: "development-original", liveVideoKey: "legacy/live.mov",
    thumbnailBucket: "development-thumbnail", thumbnailKey: "legacy/thumbnail.jpg",
    signatureBucket: "development-profile", signatureKey: "legacy/signature.png",
    originalPhotoBucket: "external-bucket", originalPhotoKey: "not-owned",
  };
  function database() {
    return vi.spyOn(db.DynamoDBClient.prototype, "send").mockImplementation(async (command: any) => {
      if (command instanceof db.GetItemCommand) return { Item: marshall(command.input.TableName === "development-deletions" ? job : { userSub: job.userSub, deletionRequestId: job.requestId }) };
      if (command instanceof db.QueryCommand) return { Items: [marshall(record)] };
      return {};
    });
  }

  it("deletes every paginated version and delete marker of exact historical keys before removing metadata", async () => {
    const ddb = database();
    const requests: Record<string, unknown>[] = [];
    const removed: { Key: string; VersionId: string }[] = [];
    vi.mocked(storage.S3Client.prototype.send).mockImplementation(async (command: any) => {
      const { input } = command;
      if (command instanceof storage.ListObjectVersionsCommand && input.Prefix.startsWith("legacy/")) {
        requests.push(input);
        if (!input.KeyMarker) return {
          Versions: Array.from({ length: 1000 }, (_, i) => ({ Key: input.Prefix, VersionId: `v${i}` })),
          IsTruncated: true, NextKeyMarker: input.Prefix, NextVersionIdMarker: "v999",
        };
        expect(input.VersionIdMarker).toBe("v999");
        return { Versions: [{ Key: input.Prefix, VersionId: "null" }, { Key: `${input.Prefix}.other-owner`, VersionId: "neighbor" }], DeleteMarkers: [{ Key: input.Prefix, VersionId: "marker" }] };
      }
      if (command instanceof storage.DeleteObjectsCommand) {
        expect(input.Delete.Objects.length).toBeLessThanOrEqual(1000);
        removed.push(...input.Delete.Objects);
      }
      return {};
    });
    await expect(worker("../../aws/lambda/deleteAccount.js").handler(event)).resolves.toEqual({ batchItemFailures: [] });
    expect(requests).toHaveLength(8);
    expect(removed).toHaveLength(4 * 1002);
    expect(removed.every(object => object.VersionId && !object.Key.endsWith(".other-owner"))).toBe(true);
    const metadataDelete = ddb.mock.calls.findIndex(([command]: any) => command instanceof db.DeleteItemCommand && command.input.Key.sk.S === record.sk);
    expect(metadataDelete).toBeGreaterThan(-1);
    const storageOrders = vi.mocked(storage.S3Client.prototype.send).mock.invocationCallOrder;
    expect(ddb.mock.invocationCallOrder[metadataDelete]).toBeGreaterThan(Math.max(...storageOrders));
  });

  it("retains historical references on partial S3 failure and retries them before completing erasure", async () => {
    const ddb = database();
    let fail = true;
    vi.mocked(storage.S3Client.prototype.send).mockImplementation(async (command: any) => {
      if (command instanceof storage.ListObjectVersionsCommand && command.input.Prefix.startsWith("legacy/")) return { Versions: [{ Key: command.input.Prefix, VersionId: "old" }] };
      if (command instanceof storage.DeleteObjectsCommand && fail) return { Errors: [{ Code: "AccessDenied" }] };
      return {};
    });
    const handler = worker("../../aws/lambda/deleteAccount.js").handler;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await handler(event)).toEqual({ batchItemFailures: [{ itemIdentifier: "message" }] });
    expect(ddb.mock.calls.some(([command]: any) => command instanceof db.DeleteItemCommand)).toBe(false);
    expect(vi.mocked(identity.CognitoIdentityProviderClient.prototype.send).mock.calls.some(([command]: any) => command instanceof identity.AdminDeleteUserCommand)).toBe(false);
    fail = false;
    expect(await handler(event)).toEqual({ batchItemFailures: [] });
    expect(ddb.mock.calls.some(([command]: any) => command instanceof db.DeleteItemCommand && command.input.Key.sk.S === record.sk)).toBe(true);
  });
});

describe("media deletion dispatch recovery", () => {
  it("follows empty filtered query pages and resets the cursor for each account and profile scan page", async () => {
    const accounts = ["one@example.invalid", "two@example.invalid"];
    const seen: { email: string; cursor: unknown }[] = [];
    vi.spyOn(db.DynamoDBClient.prototype, "send").mockImplementation(async (command: any) => {
      const { input } = command;
      if (command instanceof db.ScanCommand) return input.ExclusiveStartKey ? { Items: [marshall({ email: accounts[1], userSub: "two", sk: "PROFILE" })] } : { Items: [marshall({ email: accounts[0], userSub: "one", sk: "PROFILE" }), marshall({ email: "inactive", accountStatus: "DELETING", sk: "PROFILE" })], LastEvaluatedKey: { email: { S: accounts[0] }, sk: { S: "PROFILE" } } };
      if (command instanceof db.QueryCommand && input.FilterExpression) {
        const owner = input.ExpressionAttributeValues[":email"].S;
        seen.push({ email: owner, cursor: input.ExclusiveStartKey });
        if (!input.ExclusiveStartKey) return { Items: [], LastEvaluatedKey: { email: { S: owner }, sk: { S: "HASH#last" } } };
        if (input.ExclusiveStartKey.sk.S === "HASH#last") return { Items: [marshall({ sk: "PHOTO#old#import" })], LastEvaluatedKey: { email: { S: owner }, sk: { S: "PHOTO#old#import" } } };
        return { Items: [marshall({ sk: "VIDEO#clip" })] };
      }
      return {};
    });
    await worker("../../aws/lambda/cleanupUploads.js").handler();
    expect(seen).toHaveLength(6);
    expect(seen.filter(page => !page.cursor).map(page => page.email)).toEqual(accounts);
    const messages = vi.mocked(queue.SQSClient.prototype.send).mock.calls.map(([command]: any) => JSON.parse(command.input.MessageBody));
    expect(messages).toEqual(accounts.flatMap((owner, index) => [
      { email: owner, userSub: index ? "two" : "one", mediaType: "PHOTO", mediaId: "old#import" },
      { email: owner, userSub: index ? "two" : "one", mediaType: "VIDEO", mediaId: "clip" },
    ]));
  });

  it("propagates a later-page queue failure so the scheduled invocation can retry", async () => {
    vi.spyOn(db.DynamoDBClient.prototype, "send").mockImplementation(async (command: any) => {
      if (command instanceof db.ScanCommand) return { Items: [marshall({ email, sk: "PROFILE" })] };
      if (command instanceof db.QueryCommand) return command.input.ExclusiveStartKey ? { Items: [marshall({ sk: "PHOTO#retry" })] } : { Items: [], LastEvaluatedKey: { email: { S: email }, sk: { S: "HASH#last" } } };
      return {};
    });
    vi.mocked(queue.SQSClient.prototype.send).mockRejectedValueOnce(new Error("queue unavailable"));
    const handler = worker("../../aws/lambda/cleanupUploads.js").handler;
    await expect(handler()).rejects.toThrow("queue unavailable");
    await expect(handler()).resolves.toBeUndefined();
    expect(queue.SQSClient.prototype.send).toHaveBeenCalledTimes(2);
  });
});
