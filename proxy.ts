import { NextRequest, NextResponse } from "next/server";
import { verifyIdToken } from "./app/lib/jwt";

const PROTECTED_PATHS = ["/dashboard"];
const testPaths = /^(\/api\/mobile\/(health|policies|consent|auth\/[^/]+)|\/api\/media\/urls|\/api\/user\/(profile|delete-account|deletion-status)|\/api\/videos\/(list|delete|notify|multipart\/(init|part|status|complete|abort)))$/;
const authHits = new Map<string, { until: number; count: number }>();

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (process.env.PH_API_ONLY === "true") {
    if (!testPaths.test(pathname)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (pathname.startsWith("/api/mobile/auth/")) {
      const now = Date.now();
      for (const [key, value] of authHits) if (value.until <= now) authHits.delete(key);
      const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      const value = authHits.get(key) || { until: now + 60_000, count: 0 };
      if (++value.count > 30 || (!authHits.has(key) && authHits.size >= 256)) return NextResponse.json({ error: "Please wait before trying again" }, { status: 429, headers: { "Retry-After": "60" } });
      authHits.set(key, value);
    }
    return NextResponse.next();
  }

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
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
