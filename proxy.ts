import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken } from "./app/lib/jwt";

const PROTECTED_PATHS = ["/dashboard"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PATHS.some((p) => pathname.startsWith(p));
  if (!isProtected) return NextResponse.next();

  const token = request.cookies.get("id_token")?.value;
  if (!token) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  try {
    await verifyIdToken(token);
    return NextResponse.next();
  } catch {
    // invalid or expired token
    const res = NextResponse.redirect(new URL("/login", request.url));
    res.cookies.delete("id_token");
    return res;
  }
}

export const config = {
  matcher: ["/dashboard"],
};
