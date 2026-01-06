import { NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  ResendConfirmationCodeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import crypto from "node:crypto";

const region = process.env.COGNITO_REGION || process.env.NEXT_PUBLIC_COGNITO_REGION;
const clientId = process.env.COGNITO_CLIENT_ID || process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
const clientSecret = process.env.COGNITO_CLIENT_SECRET;

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
    const { email } = (await req.json()) as { email?: string };
    if (!email) {
      return NextResponse.json({ error: "Missing email" }, { status: 400 });
    }

    const client = new CognitoIdentityProviderClient({ region });
    const cmd = new ResendConfirmationCodeCommand({
      ClientId: clientId as string,
      Username: email,
      SecretHash: secretHash(email),
    });
    await client.send(cmd);

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "发送验证码失败" }, { status: 400 });
  }
}
