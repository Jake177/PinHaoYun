import crypto from "node:crypto";
import {
  CognitoIdentityProviderClient, InitiateAuthCommand, SignUpCommand,
  ConfirmSignUpCommand, ResendConfirmationCodeCommand, ForgotPasswordCommand,
  ConfirmForgotPasswordCommand, RevokeTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { verifyIdToken } from "./jwt";
import { POLICY_VERSION } from "./mobilePolicy";

const region = process.env.COGNITO_REGION || "ap-southeast-2";
const cognito = new CognitoIdentityProviderClient({ region });
const secrets = new SecretsManagerClient({ region });
const ddb = new DynamoDBClient({ region });
const secretCache = new Map<string, string>();
const table = () => process.env.VIDEOS_TABLE!;
const profileKey = (email: string) => ({ email: { S: email }, sk: { S: "PROFILE" } });

export function requiredString(body: Record<string, unknown>, key: string, max = 1024): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${key}`);
  return value;
}
export function requireConsent(body: Record<string, unknown>) {
  if (body.acceptedTerms !== true || body.acknowledgedPrivacy !== true || body.termsVersion !== POLICY_VERSION || body.privacyVersion !== POLICY_VERSION) throw new Error("Please read and accept the current terms and privacy notice");
}
export async function recordConsent(email: string, sub: string) {
  await ddb.send(new PutItemCommand({ TableName: table(), Item: {
    email: { S: email }, sk: { S: "CONSENT" }, userSub: { S: sub },
    termsVersion: { S: POLICY_VERSION }, privacyVersion: { S: POLICY_VERSION }, acceptedAt: { S: new Date().toISOString() },
  } }));
}
async function clientConfig(username: string) {
  const ClientId = process.env.COGNITO_MOBILE_CLIENT_ID;
  const secretId = process.env.COGNITO_MOBILE_SECRET_ID;
  if (!ClientId || !secretId) throw new Error("Mobile authentication is not configured");
  let secret = secretCache.get(secretId);
  if (!secret) {
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    const raw = value.SecretString;
    if (!raw) throw new Error("Mobile authentication is not configured");
    try { secret = JSON.parse(raw).COGNITO_CLIENT_SECRET; } catch { secret = raw; }
    if (!secret) throw new Error("Mobile authentication is not configured");
    secretCache.set(secretId, secret);
  }
  return { ClientId, SecretHash: crypto.createHmac("sha256", secret).update(username + ClientId).digest("base64"), secret };
}
async function tokenResponse(result: { IdToken?: string; AccessToken?: string; RefreshToken?: string; ExpiresIn?: number }, refreshToken?: string) {
  if (!result.IdToken || !result.AccessToken) throw new Error("Sign-in requires an unsupported additional challenge");
  const claims = await verifyIdToken(result.IdToken);
  const email = (claims.email as string).toLowerCase();
  const profile = await ddb.send(new GetItemCommand({ TableName: table(), Key: profileKey(email), ConsistentRead: true }));
  if (profile.Item?.accountStatus?.S && profile.Item.accountStatus.S !== "ACTIVE") throw new Error("Account deletion is in progress");
  if (profile.Item?.userSub?.S && profile.Item.userSub.S !== claims.sub) throw new Error("Account identity mismatch");
  if (!profile.Item) throw new Error("Account profile is not available yet");
  await ddb.send(new UpdateItemCommand({ TableName: table(), Key: profileKey(email),
    UpdateExpression: "SET userSub = if_not_exists(userSub, :sub)",
    ConditionExpression: "attribute_exists(sk) AND (attribute_not_exists(accountStatus) OR accountStatus = :active)",
    ExpressionAttributeValues: { ":sub": { S: claims.sub! }, ":active": { S: "ACTIVE" } },
  }));
  const consent = await ddb.send(new GetItemCommand({ TableName: table(), Key: { email: { S: email }, sk: { S: "CONSENT" } }, ConsistentRead: true }));
  return { idToken: result.IdToken, accessToken: result.AccessToken, refreshToken: result.RefreshToken || refreshToken,
    expiresIn: result.ExpiresIn || 3600, username: claims.sub, sub: claims.sub, email,
    requiresConsent: consent.Item?.userSub?.S !== claims.sub || consent.Item?.termsVersion?.S !== POLICY_VERSION || consent.Item?.privacyVersion?.S !== POLICY_VERSION };
}

export async function mobileAuth(operation: string, body: Record<string, unknown>) {
  if (process.env.APP_ENV === "production" && process.env.POLICIES_APPROVED !== "true") throw new Error("Production policies require operator approval");
  const email = operation === "refresh" || operation === "sign-out" ? "" : requiredString(body, "email", 320).trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid email");
  const username = operation === "refresh" ? requiredString(body, "username", 256) : email;
  const config = await clientConfig(username);
  switch (operation) {
    case "sign-in": {
      const result = await cognito.send(new InitiateAuthCommand({ ClientId: config.ClientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: email, PASSWORD: requiredString(body, "password"), SECRET_HASH: config.SecretHash } }));
      return tokenResponse(result.AuthenticationResult || {});
    }
    case "refresh": {
      const refreshToken = requiredString(body, "refreshToken", 4096);
      const result = await cognito.send(new InitiateAuthCommand({ ClientId: config.ClientId, AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: refreshToken, SECRET_HASH: config.SecretHash } }));
      return tokenResponse(result.AuthenticationResult || {}, refreshToken);
    }
    case "sign-up": {
      if (process.env.PH_API_ONLY === "true" && !(process.env.MOBILE_TEST_EMAILS || "").split(",").map(value => value.trim().toLowerCase()).includes(email)) throw new Error("Invalid test registration email");
      requireConsent(body);
      const profile = await ddb.send(new GetItemCommand({ TableName: table(), Key: profileKey(email), ConsistentRead: true }));
      if (profile.Item?.accountStatus?.S === "DELETING") throw new Error("Account deletion is in progress");
      const attributes = { email, preferred_username: requiredString(body, "preferredUsername", 128), given_name: requiredString(body, "givenName", 128), family_name: requiredString(body, "familyName", 128), gender: requiredString(body, "gender", 32) };
      if (!["Male", "Female", "Other"].includes(attributes.gender)) throw new Error("Invalid gender");
      const result = await cognito.send(new SignUpCommand({ ClientId: config.ClientId, SecretHash: config.SecretHash, Username: email, Password: requiredString(body, "password"), UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })) }));
      if (!result.UserSub) throw new Error("Registration failed");
      await recordConsent(email, result.UserSub);
      return { ok: true, userConfirmed: result.UserConfirmed || false };
    }
    case "confirm-sign-up":
      await cognito.send(new ConfirmSignUpCommand({ ClientId: config.ClientId, SecretHash: config.SecretHash, Username: email, ConfirmationCode: requiredString(body, "code", 32) })); break;
    case "resend-code":
      await cognito.send(new ResendConfirmationCodeCommand({ ClientId: config.ClientId, SecretHash: config.SecretHash, Username: email })); break;
    case "forgot-password":
      await cognito.send(new ForgotPasswordCommand({ ClientId: config.ClientId, SecretHash: config.SecretHash, Username: email })); break;
    case "confirm-forgot-password":
      await cognito.send(new ConfirmForgotPasswordCommand({ ClientId: config.ClientId, SecretHash: config.SecretHash, Username: email, ConfirmationCode: requiredString(body, "code", 32), Password: requiredString(body, "password") })); break;
    case "sign-out":
      await cognito.send(new RevokeTokenCommand({ ClientId: config.ClientId, ClientSecret: config.secret, Token: requiredString(body, "refreshToken", 4096) })); break;
    default: throw new Error("Unknown authentication operation");
  }
  return { ok: true };
}
