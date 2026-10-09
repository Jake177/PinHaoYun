import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";

function deriveRegionFromUserPoolId(id: string): string | null {
  // e.g. ap-southeast-2_7U6opGDwY => ap-southeast-2
  const idx = id.indexOf("_");
  return idx > 0 ? id.slice(0, idx) : null;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function configuration() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID || process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
  if (!userPoolId || !clientId) throw new Error("JWT verification is not configured");
  const region = process.env.COGNITO_REGION || process.env.NEXT_PUBLIC_COGNITO_REGION || deriveRegionFromUserPoolId(userPoolId) || "ap-southeast-2";
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  let JWKS = jwksCache.get(issuer);
  if (!JWKS) { JWKS = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)); jwksCache.set(issuer, JWKS); }
  return { issuer, clientId, JWKS };
}

export async function verifyIdToken(idToken: string) {
  const { issuer, clientId, JWKS } = configuration();
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer,
    audience: [clientId!, process.env.COGNITO_MOBILE_CLIENT_ID].filter(Boolean) as string[],
    algorithms: ["RS256"],
  });
  if (payload.token_use !== "id" || !payload.sub || typeof payload.email !== "string" || payload.email_verified !== true) throw new Error("Invalid identity token");
  return payload;
}

export async function verifyAccessToken(accessToken: string, identity: JWTPayload) {
  const { issuer, JWKS } = configuration();
  const { payload } = await jwtVerify(accessToken, JWKS, { issuer, algorithms: ["RS256"] });
  if (payload.token_use !== "access" || payload.sub !== identity.sub || payload.client_id !== identity.aud) throw new Error("Access token identity mismatch");
  return payload;
}

// Display-only legacy Web labels. API authorization must use getSessionUser.
export function decodeIdToken(token: string) { return decodeJwt(token); }
