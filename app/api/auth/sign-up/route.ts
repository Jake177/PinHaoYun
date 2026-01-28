import { NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import crypto from "node:crypto";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const region = process.env.COGNITO_REGION || process.env.NEXT_PUBLIC_COGNITO_REGION;
const userPoolId = process.env.COGNITO_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
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
    console.warn("[auth/sign-up] Failed to load secret", error);
    return undefined;
  }
};

async function secretHash(username: string) {
  const clientSecret = await resolveClientSecret();
  if (!clientSecret) {
    throw new Error("服务器配置错误: COGNITO_CLIENT_SECRET 未定义");
  }
  const hmac = crypto.createHmac("sha256", clientSecret);
  hmac.update(username + clientId);
  return hmac.digest("base64");
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      email?: string;
      password?: string;
      preferredUsername?: string;
      givenName?: string;
      familyName?: string;
      gender?: "Male" | "Female" | "Other";
    };

    const required = ["email", "password", "preferredUsername", "givenName", "familyName", "gender"] as const;
    for (const k of required) {
      if (!body[k]) {
        return NextResponse.json({ error: `Missing ${k}` }, { status: 400 });
      }
    }

    if (!region || !userPoolId || !clientId) {
      console.warn("[auth/sign-up] Missing env: COGNITO_REGION, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID");
    }

    const client = new CognitoIdentityProviderClient({ region });
    const cmd = new SignUpCommand({
      ClientId: clientId as string,
      SecretHash: await secretHash(body.email!),
      Username: body.email!,
      Password: body.password!,
      UserAttributes: [
        { Name: "email", Value: body.email! },
        { Name: "preferred_username", Value: body.preferredUsername! },
        { Name: "given_name", Value: body.givenName! },
        { Name: "family_name", Value: body.familyName! },
        { Name: "gender", Value: body.gender! },
      ],
    });

    const result = await client.send(cmd);
    // Depending on pool settings, the user may need to confirm by code
    return NextResponse.json({ ok: true, userConfirmed: result.UserConfirmed ?? false });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "注册失败" }, { status: 400 });
  }
}
