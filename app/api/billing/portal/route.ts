import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/lib/sessionUser";
import { getProfileRecord } from "@/app/lib/profileStore";
import { resolveProfileBillingState } from "@/app/lib/profileBilling";
import { getAppUrl, getStripe } from "@/app/lib/stripe";

export const runtime = "nodejs";

export async function POST() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const profile = await getProfileRecord(user.email);
    const billing = resolveProfileBillingState(profile);

    if (!billing.stripeCustomerId) {
      return NextResponse.json(
        { error: "This account does not have a billing portal yet." },
        { status: 400 },
      );
    }

    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: `${getAppUrl()}/dashboard/plans`,
    });

    return NextResponse.json({ url: session.url });
  } catch (error: any) {
    console.error("[billing/portal] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to create billing portal session" },
      { status: 500 },
    );
  }
}
