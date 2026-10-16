import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/lib/sessionUser";
import { discardUnconfirmedUpload } from "@/app/lib/backupDeletion";
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { key, uploadId } = await request.json();
  if (typeof key !== "string" || typeof uploadId !== "string" || (!key.startsWith(`photo/${user.email}/`) && !key.startsWith(`video/${user.email}/`))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  await discardUnconfirmedUpload(user.email, user.sub, key, uploadId);
  return NextResponse.json({ ok: true });
}
