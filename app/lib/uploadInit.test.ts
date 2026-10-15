import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ database: vi.fn(), storage: vi.fn(), reservation: undefined as any, state: "READY" }));
vi.mock("./sessionUser", () => ({ getSessionUser: async () => ({ email: "upload@example.invalid", sub: "owner", claims: { email: "upload@example.invalid" } }) }));
vi.mock("./backupDeletion", () => ({ backupSuppressed: async () => false, suppressionCheck: vi.fn() }));
vi.mock("./profileBilling", () => ({ resolveProfileBillingState: () => ({ quotaBytes: 1000000 }) }));
vi.mock("@aws-sdk/client-dynamodb", async original => ({ ...await original<typeof import("@aws-sdk/client-dynamodb")>(), DynamoDBClient: class { send = mock.database; } }));
vi.mock("@aws-sdk/client-s3", async original => ({ ...await original<typeof import("@aws-sdk/client-s3")>(), S3Client: class { send = mock.storage; } }));
let POST: typeof import("../api/videos/multipart/init/route").POST;
const requestId = "12345678-1234-1234-1234-123456789abc";
const request = () => new Request("https://example.invalid/api/videos/multipart/init", { method: "POST", body: JSON.stringify({ mediaType: "PHOTO", mediaRole: "liveVideo", photoId: "asset", fileName: "live.mov", size: 12, requestId }) });
beforeAll(async () => {
  vi.stubEnv("S3_ORIGINAL_BUCKET", "development-original"); vi.stubEnv("VIDEOS_TABLE", "development-media");
  ({ POST } = await import("../api/videos/multipart/init/route"));
});
beforeEach(() => {
  mock.reservation = undefined; mock.state = "READY";
  mock.database.mockReset().mockImplementation(async (command: any) => {
    const sk = command.input.Key?.sk.S;
    if (sk === "PHOTO#asset") return { Item: { status: { S: mock.state }, contentHash: { S: "a".repeat(64) + "-12" }, rejectedUploadKey: { S: "previous-live.mov" } } };
    if (sk === "RESERVE#PHOTO#asset") return { Item: mock.reservation };
    if (sk === "PROFILE") return { Item: { usedBytes: { N: "0" }, reservedBytes: { N: "0" } } };
    return {};
  });
  mock.storage.mockReset().mockResolvedValue({ UploadId: "new-upload" });
});
afterEach(() => vi.unstubAllEnvs());
it("refuses to resume a matching reservation while its durable cleanup is pending", async () => {
  mock.reservation = { key: { S: `photo/upload@example.invalid/asset_live-${requestId}.mov` }, size: { N: "12" }, uploadId: { S: "previous" }, cleanupPending: { BOOL: true } };
  expect((await POST(request())).status).toBe(409);
  expect(mock.storage).not.toHaveBeenCalled();
  expect(mock.database.mock.calls.some(([command]) => command.input.TransactItems)).toBe(false);
});
it("allows a new Live Photo attempt to clear rejection only atomically with reserving its new upload", async () => {
  expect((await POST(request())).status).toBe(200);
  const transaction = mock.database.mock.calls.find(([command]) => command.input.TransactItems)?.[0].input.TransactItems;
  expect(transaction[0].Update).toMatchObject({ Key: { sk: { S: "PHOTO#asset" } }, UpdateExpression: "REMOVE rejectedUploadKey", ConditionExpression: expect.stringContaining("liveUploadConfirmed = :no") });
  expect(transaction.some((item: any) => item.Put?.Item.sk.S === "RESERVE#PHOTO#asset" && item.Put.ConditionExpression === "attribute_not_exists(sk)")).toBe(true);
});
it.each(["DELETING", "DELETED"])("does not restart a Live Photo whose parent is %s", async state => {
  mock.state = state;
  expect((await POST(request())).status).toBe(409);
  expect(mock.storage).not.toHaveBeenCalled();
});
