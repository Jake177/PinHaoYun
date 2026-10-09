import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";

const userPoolId = process.env.COGNITO_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_CLIENT_ID || process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
const regionEnv = process.env.COGNITO_REGION || process.env.NEXT_PUBLIC_COGNITO_REGION;

if (!userPoolId || !clientId) {
  throw new Error("JWT verification missing env: NEXT_PUBLIC_COGNITO_USER_POOL_ID / NEXT_PUBLIC_COGNITO_CLIENT_ID");
}

function deriveRegionFromUserPoolId(id: string): string | null {
  // e.g. ap-southeast-2_7U6opGDwY => ap-southeast-2
  const idx = id.indexOf("_");
  return idx > 0 ? id.slice(0, idx) : null;
}

const region = regionEnv || deriveRegionFromUserPoolId(userPoolId) || "ap-southeast-2";
const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;

const JWKS = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

export async function verifyIdToken(idToken: string) {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer,
    audience: [clientId!, process.env.COGNITO_MOBILE_CLIENT_ID].filter(Boolean) as string[],
    algorithms: ["RS256"],
  });
  if (payload.token_use !== "id" || !payload.sub || typeof payload.email !== "string" || payload.email_verified !== true) throw new Error("Invalid identity token");
  return payload;
}

export async function verifyAccessToken(accessToken: string, identity: JWTPayload) {
  const { payload } = await jwtVerify(accessToken, JWKS, { issuer, algorithms: ["RS256"] });
  if (payload.token_use !== "access" || payload.sub !== identity.sub || payload.client_id !== identity.aud) throw new Error("Access token identity mismatch");
  return payload;
}

// Display-only legacy Web labels. API authorization must use getSessionUser.
export function decodeIdToken(token: string) { return decodeJwt(token); }
