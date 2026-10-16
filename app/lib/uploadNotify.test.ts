import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ database: vi.fn(), storage: vi.fn() }));
vi.mock("./sessionUser", () => ({ getSessionUser: async () => ({ email: "upload@example.invalid", sub: "owner" }) }));
vi.mock("./backupDeletion", () => ({ rejectDeletedBackup: async () => false, finalizeConcurrentDuplicate: async () => null, suppressionCheck: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class { send = mock.database; },
  GetItemCommand: class { constructor(public input: any) {} },
  TransactWriteItemsCommand: class { constructor(public input: any) {} },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mock.storage; },
  HeadObjectCommand: class { constructor(public input: any) {} },
}));
import { POST } from "../api/videos/notify/route";
const key = "photo/upload@example.invalid/asset_image.heic";
beforeEach(() => {
  vi.stubEnv("VIDEOS_TABLE", "development-media");
  vi.stubEnv("S3_ORIGINAL_BUCKET", "development-original");
  mock.database.mockReset().mockImplementation(async (command: any) => command.input.Key?.sk.S.startsWith("RESERVE#") ? { Item: { key: { S: key }, size: { N: "12" } } } : {});
  mock.storage.mockReset().mockResolvedValue({ ContentLength: 12, Metadata: { "owner-sub": "owner" } });
});
afterEach(() => vi.unstubAllEnvs());
it.each(["2020-03-04T05:06:07Z", undefined, "invalid", 1234])("persists valid source modification dates with their timeline (%s)", async fileLastModified => {
  const response = await POST(new Request("https://example.invalid/api/videos/notify", { method: "POST", body: JSON.stringify({ key, bucket: "development-original", mediaType: "PHOTO", contentHash: "a".repeat(64) + "-12", fileLastModified }) }));
  expect(response.status).toBe(200);
  const transaction = mock.database.mock.calls.find(([command]) => command.input.TransactItems)?.[0].input.TransactItems;
  expect(transaction).toBeDefined();
  const media = transaction[1].Update;
  expect(transaction[0].Delete.ConditionExpression).toContain("attribute_not_exists(cleanupPending)");
  const fields = Object.fromEntries(Object.entries(media.ExpressionAttributeNames).filter(([alias]) => alias.startsWith("#f")).map(([alias, name]) => [name, media.ExpressionAttributeValues[`:v${alias.slice(2)}`]]));
  if (fileLastModified === "2020-03-04T05:06:07Z") {
    expect(fields.fileLastModified).toEqual({ S: "2020-03-04T05:06:07.000Z" });
    expect(media.ExpressionAttributeValues[":mediaAt"]).toEqual(fields.fileLastModified);
    expect(media.ExpressionAttributeValues[":source"]).toEqual({ S: "file" });
  } else {
    expect(fields).not.toHaveProperty("fileLastModified");
    expect(media.ExpressionAttributeValues[":source"]).toEqual({ S: "upload" });
  }
});
it("does not finalize or release a reservation while cleanup is pending", async () => {
  mock.database.mockImplementation(async (command: any) => command.input.Key?.sk.S.startsWith("RESERVE#") ? { Item: { key: { S: key }, size: { N: "12" }, cleanupPending: { BOOL: true } } } : {});
  const response = await POST(new Request("https://example.invalid/api/videos/notify", { method: "POST", body: JSON.stringify({ key, bucket: "development-original", mediaType: "PHOTO", contentHash: "a".repeat(64) + "-12" }) }));
  expect(response.status).toBe(409);
  expect(mock.storage).not.toHaveBeenCalled();
  expect(mock.database.mock.calls.every(([command]) => !command.input.TransactItems)).toBe(true);
});
