import { NextResponse } from "next/server";
import { verifyIdToken } from "@/app/lib/jwt";

export async function POST(request: Request) {
  try {
    const { idToken } = (await request.json()) as { idToken?: string };
    if (!idToken) {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }

    const payload = await verifyIdToken(idToken);

    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    const res = NextResponse.json({ ok: true });

    res.cookies.set("id_token", idToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      expires: exp ? new Date(exp * 1000) : undefined,
    });

    return res;
  } catch (err) {
    return NextResponse.json(
      { error: "Invalid token" },
      { status: 401 }
    );
  }
}
