import { NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import crypto from "node:crypto";

const region = process.env.COGNITO_REGION || process.env.NEXT_PUBLIC_AWS_REGION;
const clientId = process.env.COGNITO_CLIENT_ID || process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
const clientSecret = process.env.COGNITO_CLIENT_SECRET;

function secretHash(username: string) {
  const hmac = crypto.createHmac("sha256", clientSecret as string);
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
