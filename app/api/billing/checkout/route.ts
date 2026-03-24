import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/lib/sessionUser";
import { resolveProfileBillingState } from "@/app/lib/profileBilling";
import { getProfileRecord, updateProfileRecord } from "@/app/lib/profileStore";
import {
  getPriceIdForPlanCode,
  isPaidPlan,
  type PlanCode,
} from "@/app/lib/plans";
import { getAppUrl, getStripe } from "@/app/lib/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as {
      targetPlanCode?: PlanCode;
    };
    const targetPlanCode = body.targetPlanCode;

    if (!targetPlanCode || !isPaidPlan(targetPlanCode)) {
      return NextResponse.json(
        { error: "Invalid paid plan selection" },
        { status: 400 },
      );
    }

    const profile = await getProfileRecord(user.email);
    const billing = resolveProfileBillingState(profile);

    if (billing.isLegacy) {
      return NextResponse.json(
        { error: "Legacy 5TB accounts do not need a paid upgrade." },
        { status: 400 },
      );
    }

    if (billing.stripeSubscriptionId && billing.planCode !== "FREE") {
      return NextResponse.json(
        { error: "Use the plan change flow for existing subscriptions." },
        { status: 400 },
      );
    }

    const priceId = getPriceIdForPlanCode(targetPlanCode);
    if (!priceId) {
      return NextResponse.json(
        { error: "Stripe price is not configured for this plan." },
        { status: 500 },
      );
    }

    const stripe = getStripe();
    const now = new Date().toISOString();

    let customerId = billing.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.username || undefined,
        metadata: {
          email: user.email,
        },
      });
      customerId = customer.id;
      await updateProfileRecord(user.email, {
        set: {
          stripeCustomerId: customerId,
          billingProvider: "stripe",
          updatedAt: now,
        },
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      success_url: `${getAppUrl()}/dashboard/plans?checkout=success`,
      cancel_url: `${getAppUrl()}/dashboard/plans?checkout=canceled`,
      client_reference_id: user.email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        email: user.email,
        targetPlanCode,
      },
      subscription_data: {
        metadata: {
          email: user.email,
          targetPlanCode,
        },
      },
    });

    if (!session.url) {
      throw new Error("Stripe Checkout session URL is missing");
    }

    return NextResponse.json({ url: session.url });
  } catch (error: any) {
    console.error("[billing/checkout] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to create checkout session" },
      { status: 500 },
    );
  }
}
