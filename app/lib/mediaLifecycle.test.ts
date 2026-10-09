import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const load = createRequire(import.meta.url);
const db = load("@aws-sdk/client-dynamodb");
const storage = load("@aws-sdk/client-s3");
const guard = load("../../aws/lambda/accountGuard.js");
const email = "lifecycle@example.invalid";
const object = { Bucket: "development-original", Key: `photo/${email}/asset.png` };
let profile: Record<string, unknown>;
let objectOwner: string;
const update = () => new db.UpdateItemCommand({ TableName: "development-media", Key: { email: { S: email }, sk: { S: "PHOTO#asset" } }, UpdateExpression: "SET updatedAt = :now", ExpressionAttributeValues: { ":now": { S: "now" } } });

beforeEach(async () => {
  profile = { sk: { S: "PROFILE" }, accountStatus: { S: "ACTIVE" }, userSub: { S: "current-subject" }, requiresOwnerMetadata: { BOOL: true } };
  objectOwner = "current-subject";
  vi.spyOn(db.DynamoDBClient.prototype, "send").mockImplementation(async () => ({ Item: profile }));
  vi.spyOn(storage.S3Client.prototype, "send").mockImplementation(async () => ({ Metadata: { "owner-sub": objectOwner } }));
  await guard.canProcess(email, undefined, "stale-subject");
});
afterEach(() => vi.restoreAllMocks());

describe("background media lifecycle", () => {
  it("checks account status and the verified subject atomically with media writes", async () => {
    expect(await guard.canProcess(email, object)).toBe(true);
    const send = vi.fn(async (_command: { input: unknown }) => ({}));
    const client = guard.protectMediaWrites({ send }, true);
    await client.send(update());
    expect(send.mock.calls[0][0]).toBeInstanceOf(db.TransactWriteItemsCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({ TransactItems: [
      { ConditionCheck: { Key: { sk: { S: "PROFILE" } }, ConditionExpression: expect.stringContaining("accountStatus = :active"), ExpressionAttributeValues: { ":active": { S: "ACTIVE" }, ":subject": { S: "current-subject" } } } },
      { Update: { ConditionExpression: expect.stringContaining("attribute_exists(sk)"), ExpressionAttributeValues: { ":erasing": { S: "DELETING" }, ":erased": { S: "DELETED" } } } },
    ] });
    expect(send.mock.calls[0][0].input).toMatchObject({ TransactItems: [{ ConditionCheck: { ConditionExpression: expect.stringContaining("userSub = :subject") } }, {}] });
  });
  it("refuses writes without a verified record context", () => {
    const send = vi.fn();
    const client = guard.protectMediaWrites({ send });
    expect(() => client.send(update())).toThrow("verified account");
    expect(send).not.toHaveBeenCalled();
  });
  it("drops delayed location events from missing or old account subjects", async () => {
    expect(await guard.canProcess(email)).toBe(false);
    expect(await guard.canProcess(email, undefined, "stale-subject")).toBe(false);
    expect(await guard.canProcess(email, undefined, "current-subject")).toBe(true);
  });
  it("keeps legacy untagged events compatible without admitting new-generation accounts", async () => {
    profile = { sk: { S: "PROFILE" } };
    expect(await guard.canProcess(email)).toBe(true);
    const send = vi.fn(async (_command: { input: unknown }) => ({}));
    await guard.protectMediaWrites({ send }).send(update());
    expect(send.mock.calls[0][0].input).toMatchObject({ TransactItems: [{ ConditionCheck: { ConditionExpression: expect.stringContaining("requiresOwnerMetadata = :legacy"), ExpressionAttributeValues: { ":legacy": { BOOL: false } } } }, {}] });
  });
  it("rejects an inactivated account and clears a previously verified context", async () => {
    expect(await guard.canProcess(email, object)).toBe(true);
    profile.accountStatus = { S: "DELETING" };
    expect(await guard.canProcess(email, object)).toBe(false);
    expect(() => guard.protectMediaWrites({ send: vi.fn() }).send(update())).toThrow("verified account");
  });
});
