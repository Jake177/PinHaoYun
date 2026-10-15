import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const load = createRequire(import.meta.url);
const db = load("@aws-sdk/client-dynamodb");
const confirmation = load("../../aws/lambda/postConfirmation.js");
const event = (triggerSource: string) => ({
  triggerSource, userName: "fixture-subject", response: {},
  request: { userAttributes: { email: "Fixture@Example.invalid", sub: "fixture-subject", email_verified: "true" } },
});
beforeEach(() => { vi.stubEnv("VIDEOS_TABLE", "development-media"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("Cognito confirmation lifecycle", () => {
  it("returns password-reset confirmation without writing or resetting existing account data", async () => {
    const send = vi.spyOn(db.DynamoDBClient.prototype, "send").mockRejectedValue(new Error("Existing profile cannot be overwritten"));
    const reset = event("PostConfirmation_ConfirmForgotPassword");
    expect(await confirmation.handler(reset)).toBe(reset);
    expect(send).not.toHaveBeenCalled();
  });
  it("never creates a profile during password reset, even when the profile environment is unavailable", async () => {
    vi.stubEnv("VIDEOS_TABLE", ""); vi.stubEnv("USERS_TABLE", "");
    const send = vi.spyOn(db.DynamoDBClient.prototype, "send");
    const reset = event("PostConfirmation_ConfirmForgotPassword");
    expect(await confirmation.handler(reset)).toBe(reset);
    expect(send).not.toHaveBeenCalled();
  });
  it("still initializes a confirmed signup with subject-bound defaults and a create-only condition", async () => {
    const send = vi.spyOn(db.DynamoDBClient.prototype, "send").mockResolvedValue({});
    const signup = event("PostConfirmation_ConfirmSignUp");
    expect(await confirmation.handler(signup)).toBe(signup);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({
      TableName: "development-media", ConditionExpression: "attribute_not_exists(email) AND attribute_not_exists(sk)",
      Item: expect.objectContaining({ email: { S: "fixture@example.invalid" }, userSub: { S: "fixture-subject" }, usedBytes: { N: "0" }, accountStatus: { S: "ACTIVE" } }),
    }) }));
  });
  it("keeps signup collision protection rather than overwriting another account generation", async () => {
    const conflict = Object.assign(new Error("collision"), { name: "ConditionalCheckFailedException" });
    vi.spyOn(db.DynamoDBClient.prototype, "send").mockRejectedValue(conflict);
    await expect(confirmation.handler(event("PostConfirmation_ConfirmSignUp"))).rejects.toBe(conflict);
  });
});
