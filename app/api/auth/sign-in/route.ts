import { NextResponse } from "next/server";
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import crypto from "node:crypto";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const region = process.env.COGNITO_REGION || process.env.NEXT_PUBLIC_COGNITO_REGION;
const userPoolId = process.env.COGNITO_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_CLIENT_ID || process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
const secretId = process.env.COGNITO_SECRET_ID || process.env.COGNITO_SECRET_ARN || "pinhaoyun/secret";
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
    console.warn("[auth/sign-in] Failed to load secret", error);
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
    const { email, password } = (await req.json()) as {
      email?: string;
      password?: string;
    };
    if (!email || !password) {
      return NextResponse.json({ error: "Missing email or password" }, { status: 400 });
    }

    if (!region || !userPoolId || !clientId) {
      console.warn("[auth/sign-in] Missing env: COGNITO_REGION, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID");
    }

    const client = new CognitoIdentityProviderClient({ region });
    const command = new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId as string,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
        SECRET_HASH: await secretHash(email),
      },
    });

    const result = await client.send(command);

    if (result.ChallengeName === "NEW_PASSWORD_REQUIRED") {
      return NextResponse.json({ challenge: "NEW_PASSWORD_REQUIRED" }, { status: 409 });
    }

    const idToken = result.AuthenticationResult?.IdToken;
    const accessToken = result.AuthenticationResult?.AccessToken;
    const expiresIn = result.AuthenticationResult?.ExpiresIn ?? 3600; // seconds
    if (!idToken) {
      return NextResponse.json({ error: "Auth failed" }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set("id_token", idToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: expiresIn,
    });

    // Also store access token for Cognito API calls (profile updates)
    if (accessToken) {
      res.cookies.set("access_token", accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: expiresIn,
      });
    }

    return res;
  } catch (err: any) {
    const msg = err?.name === "UserNotConfirmedException"
      ? "账户未验证，请先完成邮箱验证码验证。"
      : err?.message || "登录失败";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
