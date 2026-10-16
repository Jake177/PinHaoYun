import { NextResponse } from "next/server";
import { mobileAuth } from "@/app/lib/mobileAuth";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ operation: string }> }) {
  try {
    const { operation } = await context.params;
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    return NextResponse.json(await mobileAuth(operation, body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : "Authentication failed";
    const known = /^(Invalid |Please read|Unknown authentication|Account deletion|Production policies|Mobile authentication|Sign-in requires)/.test(message);
    return NextResponse.json({ error: known ? message : "Authentication failed", code: name }, { status: name === "NotAuthorizedException" ? 401 : 400, headers: { "Cache-Control": "no-store" } });
  }
}
