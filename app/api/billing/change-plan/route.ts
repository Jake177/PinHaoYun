import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/lib/sessionUser";
import { getProfileRecord, updateProfileRecord } from "@/app/lib/profileStore";
import { resolveProfileBillingState } from "@/app/lib/profileBilling";
import {
  DEFAULT_PLAN_CODE,
  getPriceIdForPlanCode,
  isLegacyPlan,
  isPaidPlan,
  isPlanCode,
  type PlanCode,
} from "@/app/lib/plans";
import { getStripe } from "@/app/lib/stripe";

export const runtime = "nodejs";

function toIsoString(unixSeconds?: number): string | null {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function getSubscriptionCurrentPeriodEnd(
  subscription: Awaited<ReturnType<ReturnType<typeof getStripe>["subscriptions"]["retrieve"]>>,
): number | undefined {
  return subscription.items.data[0]?.current_period_end;
}

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

    if (!targetPlanCode || !isPlanCode(targetPlanCode) || isLegacyPlan(targetPlanCode)) {
      return NextResponse.json({ error: "Invalid plan selection" }, { status: 400 });
    }

    const profile = await getProfileRecord(user.email);
    const billing = resolveProfileBillingState(profile);

    if (billing.isLegacy) {
      return NextResponse.json(
        { error: "Legacy accounts cannot be changed through billing." },
        { status: 400 },
      );
    }

    if (!billing.stripeSubscriptionId || !billing.stripeCustomerId) {
      return NextResponse.json(
        { error: "No active subscription found for this account." },
        { status: 400 },
      );
    }

    if (billing.planCode === "FREE") {
      return NextResponse.json(
        { error: "Use checkout to start a paid subscription." },
        { status: 400 },
      );
    }

    if (
      targetPlanCode === billing.planCode &&
      !billing.pendingPlanCode &&
      !billing.cancelAtPeriodEnd
    ) {
      return NextResponse.json({
        ok: true,
        pendingPlanCode: null,
        message: "This plan is already active.",
      });
    }

    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(
      billing.stripeSubscriptionId,
    );
    const subscriptionItem = subscription.items.data[0];
    if (!subscriptionItem) {
      throw new Error("Stripe subscription item is missing");
    }

    const now = new Date().toISOString();

    if (targetPlanCode === DEFAULT_PLAN_CODE) {
      const updated = await stripe.subscriptions.update(subscription.id, {
        cancel_at_period_end: true,
        metadata: {
          email: user.email,
          pendingPlanCode: DEFAULT_PLAN_CODE,
        },
      });

      await updateProfileRecord(user.email, {
        set: {
          pendingPlanCode: DEFAULT_PLAN_CODE,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: toIsoString(getSubscriptionCurrentPeriodEnd(updated)),
          stripeSubscriptionId: updated.id,
          stripeCustomerId:
            typeof updated.customer === "string"
              ? updated.customer
              : billing.stripeCustomerId,
          updatedAt: now,
        },
      });

      return NextResponse.json({
        ok: true,
        pendingPlanCode: DEFAULT_PLAN_CODE,
      });
    }

    if (!isPaidPlan(targetPlanCode)) {
      return NextResponse.json({ error: "Invalid paid plan" }, { status: 400 });
    }

    const priceId = getPriceIdForPlanCode(targetPlanCode);
    if (!priceId) {
      return NextResponse.json(
        { error: "Stripe price is not configured for this plan." },
        { status: 500 },
      );
    }

    const updated = await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: false,
      proration_behavior: "none",
      items: [
        {
          id: subscriptionItem.id,
          price: priceId,
        },
      ],
      metadata: {
        email: user.email,
        pendingPlanCode: targetPlanCode,
      },
    });

    await updateProfileRecord(user.email, {
      set: {
        pendingPlanCode: targetPlanCode,
        cancelAtPeriodEnd: false,
        stripePriceId: priceId,
        stripeSubscriptionId: updated.id,
        stripeCustomerId:
          typeof updated.customer === "string"
            ? updated.customer
            : billing.stripeCustomerId,
        currentPeriodEnd: toIsoString(getSubscriptionCurrentPeriodEnd(updated)),
        updatedAt: now,
      },
    });

    return NextResponse.json({
      ok: true,
      pendingPlanCode: targetPlanCode,
    });
  } catch (error: any) {
    console.error("[billing/change-plan] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to update plan" },
      { status: 500 },
    );
  }
}
