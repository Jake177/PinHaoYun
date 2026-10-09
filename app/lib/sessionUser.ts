import { cookies, headers } from "next/headers";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { verifyIdToken, verifyAccessToken } from "@/app/lib/jwt";
import { POLICY_VERSION } from "@/app/lib/mobilePolicy";

const ddb = new DynamoDBClient({ region: process.env.COGNITO_REGION || "ap-southeast-2" });
export type SessionUser = {
  email: string; username: string | null; sub: string; idToken: string;
  accessToken: string | null; claims: Awaited<ReturnType<typeof verifyIdToken>>;
  profile: Record<string, unknown>;
};

export async function getSessionUser(options: { allowDeleting?: boolean; allowUnconsented?: boolean } = {}): Promise<SessionUser | null> {
  const incoming = await headers();
  const cookieStore = await cookies();
  const authorization = incoming.get("authorization");
  // Invalid explicit credentials must never downgrade to a browser cookie.
  const idToken = authorization !== null
    ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1]
    : cookieStore.get("id_token")?.value;
  const accessToken = authorization !== null
    ? incoming.get("x-access-token")
    : cookieStore.get("access_token")?.value ?? null;
  if (!idToken) return null;
  let claims;
  try {
    claims = await verifyIdToken(idToken);
    if (accessToken) await verifyAccessToken(accessToken, claims);
  } catch { return null; }
  const email = (claims.email as string).toLowerCase().trim();
  const table = process.env.VIDEOS_TABLE || process.env.USERS_TABLE;
  if (!table) throw new Error("Missing user table");
  const result = await ddb.send(new GetItemCommand({
    TableName: table, Key: { email: { S: email }, sk: { S: "PROFILE" } }, ConsistentRead: true,
  }));
  if (!result.Item) return null;
  const profile = unmarshall(result.Item);
  if (profile.userSub && profile.userSub !== claims.sub) return null;
  if (!options.allowDeleting && profile.accountStatus && profile.accountStatus !== "ACTIVE") return null;
  if (authorization !== null && !options.allowUnconsented) {
    const consent = await ddb.send(new GetItemCommand({
      TableName: table, Key: { email: { S: email }, sk: { S: "CONSENT" } }, ConsistentRead: true,
    }));
    if (consent.Item?.userSub?.S !== claims.sub || consent.Item?.termsVersion?.S !== POLICY_VERSION || consent.Item?.privacyVersion?.S !== POLICY_VERSION) return null;
  }
  return {
    email, sub: claims.sub!, username: (claims.preferred_username as string) || null,
    idToken, accessToken, claims, profile,
  };
}
