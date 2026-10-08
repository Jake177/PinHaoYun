import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/lib/sessionUser";
import { recordConsent, requireConsent } from "@/app/lib/mobileAuth";
export async function POST(request: Request) {
  const user = await getSessionUser({ allowUnconsented: true });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    requireConsent(await request.json());
    await recordConsent(user.email, user.sub);
    return NextResponse.json({ ok: true });
  } catch { return NextResponse.json({ error: "Please accept the current terms and privacy notice" }, { status: 400 }); }
}
