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

const secret_name = "pinhaoyun/secret/COGNITO_CLIENT_SECRET";
const client = new SecretsManagerClient({
  region: "ap-southeast-2",
});

let response;

try {
  response = await client.send(
    new GetSecretValueCommand({
      SecretId: secret_name,
      VersionStage: "AWSCURRENT", // VersionStage defaults to AWSCURRENT if unspecified
    })
  );
} catch (error) {
  // For a list of exceptions thrown, see
  // https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
  throw error;
}

const clientSecret = response.SecretString || process.env.COGNITO_CLIENT_SECRET;

function secretHash(username: string) {
  if (!clientSecret) {
    throw new Error("服务器配置错误: COGNITO_CLIENT_SECRET 未定义");
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

    const client = new CognitoIdentityProviderClient({ region });
    const cmd = new ConfirmSignUpCommand({
      ClientId: clientId as string,
      Username: email,
      ConfirmationCode: code,
      SecretHash: secretHash(email),
    });
    await client.send(cmd);

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "确认失败" }, { status: 400 });
  }
}
