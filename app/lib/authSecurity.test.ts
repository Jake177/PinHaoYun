import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, type JWTPayload } from "jose";
import { POLICY_VERSION } from "./mobilePolicy";
const mock = vi.hoisted(() => ({ keys: [] as Record<string,unknown>[], authorization: null as string|null, cookie: "", access: "", send: vi.fn() }));
vi.mock("jose", async original => {
  const real = await original<typeof import("jose")>();
  return { ...real, createRemoteJWKSet: () => (header: Parameters<ReturnType<typeof real.createLocalJWKSet>>[0], token: Parameters<ReturnType<typeof real.createLocalJWKSet>>[1]) => real.createLocalJWKSet({ keys: mock.keys })(header, token) };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers({ ...(mock.authorization !== null ? { authorization: mock.authorization } : {}), ...(mock.access ? { "x-access-token": mock.access } : {}) }), cookies: async () => ({ get: (name: string) => { const value = name === "id_token" ? mock.cookie : mock.access; return value ? { value } : undefined; } }) }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class { send = mock.send; }, GetItemCommand: class { constructor(public input: Record<string,unknown>) {} } }));
let key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let verify: typeof import("./jwt"); let sessions: typeof import("./sessionUser");
const issuer = "https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_test";
async function token(extra: JWTPayload = {}, secret = key) {
  return new SignJWT({ token_use: "id", email: "owner@example.invalid", email_verified: true, ...extra }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(issuer).setAudience("web-client").setSubject("owner-sub").setExpirationTime("1h").sign(secret);
}
beforeAll(async () => {
  vi.stubEnv("COGNITO_USER_POOL_ID", "ap-southeast-2_test"); vi.stubEnv("COGNITO_CLIENT_ID", "web-client"); vi.stubEnv("COGNITO_MOBILE_CLIENT_ID", "mobile-client"); vi.stubEnv("VIDEOS_TABLE", "isolated-test");
  const pair = await generateKeyPair("RS256"); key = pair.privateKey;
  mock.keys = [{ ...await exportJWK(pair.publicKey), kid: "test", alg: "RS256" }];
  verify = await import("./jwt"); sessions = await import("./sessionUser");
});
beforeEach(() => {
  mock.authorization = null; mock.cookie = ""; mock.access = ""; mock.send.mockReset();
  mock.send.mockImplementation(async (command: { input: { Key: { sk: { S: string } } } }) => command.input.Key.sk.S === "PROFILE" ? { Item: { email: { S: "owner@example.invalid" }, sk: { S: "PROFILE" }, userSub: { S: "owner-sub" }, accountStatus: { S: "ACTIVE" } } } : { Item: { userSub: { S: "owner-sub" }, termsVersion: { S: POLICY_VERSION }, privacyVersion: { S: POLICY_VERSION } } });
});
describe("actual JWT signature and claims", () => {
  it("accepts signed, verified identities", async () => { expect((await verify.verifyIdToken(await token())).sub).toBe("owner-sub"); });
  it("rejects a forged signature", async () => { const other = await generateKeyPair("RS256"); await expect(verify.verifyIdToken(await token({}, other.privateKey))).rejects.toThrow(); });
  it("rejects access tokens used as identity tokens and unverified email", async () => { await expect(verify.verifyIdToken(await token({ token_use: "access" }))).rejects.toThrow(); await expect(verify.verifyIdToken(await token({ email_verified: false }))).rejects.toThrow(); });
  it("rejects wrong audience, issuer, and expired tokens", async () => {
    for (const payload of [{ aud: "other" }, { iss: "https://attacker.invalid" }, { exp: 1 }]) {
      const value = await new SignJWT({ token_use: "id", email: "owner@example.invalid", email_verified: true, sub: "owner-sub", iss: issuer, aud: "web-client", exp: Math.floor(Date.now()/1000)+60, ...payload }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(key);
      await expect(verify.verifyIdToken(value)).rejects.toThrow();
    }
  });
  it("binds an access token to both subject and client", async () => {
    const identity = await verify.verifyIdToken(await token());
    const access = (sub: string, client_id: string) => new SignJWT({ token_use: "access", sub, client_id }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(issuer).setExpirationTime("1h").sign(key);
    await expect(verify.verifyAccessToken(await access("other-sub", "web-client"), identity)).rejects.toThrow();
    await expect(verify.verifyAccessToken(await access("owner-sub", "mobile-client"), identity)).rejects.toThrow();
    expect((await verify.verifyAccessToken(await access("owner-sub", "web-client"), identity)).sub).toBe("owner-sub");
  });
});
describe("request credentials and lifecycle", () => {
  it("keeps legacy cookie and bearer access working", async () => {
    mock.cookie = await token(); expect((await sessions.getSessionUser())?.email).toBe("owner@example.invalid");
    mock.authorization = `Bearer ${mock.cookie}`; expect((await sessions.getSessionUser())?.sub).toBe("owner-sub");
  });
  it("does not fall back to a valid cookie when bearer is invalid", async () => {
    mock.cookie = await token(); mock.authorization = "Bearer forged";
    expect(await sessions.getSessionUser()).toBeNull(); expect(mock.send).not.toHaveBeenCalled();
  });
  it("denies deleted or missing accounts and an email reused by a different subject", async () => {
    mock.cookie = await token();
    for (const Item of [undefined, { accountStatus: { S: "DELETING" } }, { userSub: { S: "different-generation" } }]) {
      mock.send.mockResolvedValueOnce({ Item }); expect(await sessions.getSessionUser()).toBeNull();
    }
  });
  it("requires current consent for bearer access but allows acknowledgement", async () => {
    mock.authorization = `Bearer ${await token()}`;
    mock.send.mockResolvedValueOnce({ Item: { userSub: { S: "owner-sub" } } }).mockResolvedValueOnce({});
    expect(await sessions.getSessionUser()).toBeNull();
    expect((await sessions.getSessionUser({ allowUnconsented: true }))?.sub).toBe("owner-sub");
  });
});
