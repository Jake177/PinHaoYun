import { NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import crypto from "node:crypto";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const region = process.env.COGNITO_REGION || process.env.NEXT_PUBLIC_COGNITO_REGION;
const clientId = process.env.COGNITO_CLIENT_ID || process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
const secretId = process.env.COGNITO_SECRET_ID;
const secretsClient = new SecretsManagerClient({
  region: process.env.AWS_REGION || "ap-southeast-2",
});

let cachedClientSecret: string | undefined;

const resolveClientSecret = async () => {
  if (cachedClientSecret) return cachedClientSecret;
  if (process.env.COGNITO_CLIENT_SECRET) {
    cachedClientSecret = process.env.COGNITO_CLIENT_SECRET;
    return cachedClientSecret;
  }
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: secretId,
        VersionStage: "AWSCURRENT",
      }),
    );
    const secretString = response.SecretString;
    if (!secretString) return undefined;
    try {
      const parsed = JSON.parse(secretString);
      cachedClientSecret = parsed.COGNITO_CLIENT_SECRET || secretString;
    } catch {
      cachedClientSecret = secretString;
    }
    return cachedClientSecret;
  } catch (error) {
    console.warn("[auth/confirm-sign-up] Failed to load secret", error);
    return undefined;
  }
};

async function secretHash(username: string) {
  const clientSecret = await resolveClientSecret();
  if (!clientSecret) {
    throw new Error("Server configuration error: COGNITO_CLIENT_SECRET is not set");
  }
  const hmac = crypto.createHmac("sha256", clientSecret);
  hmac.update(username + clientId);
  return hmac.digest("base64");
}

export async function POST(req: Request) {
  try {
    const { email, code } = (await req.json()) as { email?: string; code?: string };
    if (!email || !code) {
      return NextResponse.json({ error: "Missing email or code" }, { status: 400 });
    }

    if (!region || !clientId) {
      console.warn("[auth/confirm-sign-up] Missing env: COGNITO_REGION, COGNITO_CLIENT_ID");
    }

    const client = new CognitoIdentityProviderClient({ region });
    const cmd = new ConfirmSignUpCommand({
      ClientId: clientId as string,
      Username: email,
      ConfirmationCode: code,
      SecretHash: await secretHash(email),
    });
    await client.send(cmd);

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Confirmation failed" },
      { status: 400 },
    );
  }
}
