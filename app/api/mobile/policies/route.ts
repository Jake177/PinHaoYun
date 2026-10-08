import { NextResponse } from "next/server";
import { policies } from "@/app/lib/mobilePolicy";
export async function GET() { return NextResponse.json(policies, { headers: { "Cache-Control": "no-store" } }); }
