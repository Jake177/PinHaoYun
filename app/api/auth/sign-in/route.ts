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

if (!region || !userPoolId || !clientId || !clientSecret) {
  console.warn("[auth/sign-in] Missing env: COGNITO_REGION, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_CLIENT_SECRET");
}

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
    const { email, password } = (await req.json()) as {
      email?: string;
      password?: string;
    };
    if (!email || !password) {
      return NextResponse.json({ error: "Missing email or password" }, { status: 400 });
    }

    const client = new CognitoIdentityProviderClient({ region });
    const command = new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId as string,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
        SECRET_HASH: secretHash(email),
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
