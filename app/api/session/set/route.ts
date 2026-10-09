import { NextResponse } from "next/server";
import { verifyIdToken, verifyAccessToken } from "@/app/lib/jwt";

export async function POST(request: Request) {
  try {
    const { idToken, accessToken } = (await request.json()) as {
      idToken?: string;
      accessToken?: string;
    };
    if (!idToken) {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }

    const payload = await verifyIdToken(idToken);
    if (accessToken) await verifyAccessToken(accessToken, payload);

    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    const res = NextResponse.json({ ok: true });

    res.cookies.set("id_token", idToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      expires: exp ? new Date(exp * 1000) : undefined,
    });

    // Also store access token for Cognito API calls
    if (accessToken) {
      res.cookies.set("access_token", accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        expires: exp ? new Date(exp * 1000) : undefined,
      });
    }

    return res;
  } catch {
    return NextResponse.json(
      { error: "Invalid token" },
      { status: 401 }
    );
  }
}
