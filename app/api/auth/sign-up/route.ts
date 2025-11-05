import { NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import crypto from "node:crypto";

const region = process.env.COGNITO_REGION || process.env.NEXT_PUBLIC_AWS_REGION;
const userPoolId = process.env.COGNITO_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_CLIENT_ID || process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
const clientSecret = process.env.COGNITO_CLIENT_SECRET; // server-only

function secretHash(username: string) {
  const hmac = crypto.createHmac("sha256", clientSecret as string);
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

    const client = new CognitoIdentityProviderClient({ region });
    const cmd = new SignUpCommand({
      ClientId: clientId as string,
      SecretHash: secretHash(body.email!),
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
