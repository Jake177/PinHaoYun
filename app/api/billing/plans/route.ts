import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/lib/sessionUser";
import {
  PLAN_DEFINITIONS,
  PUBLIC_PLAN_CODES,
  getPriceIdForPlanCode,
} from "@/app/lib/plans";
import { getProfileRecord } from "@/app/lib/profileStore";
import { resolveProfileBillingState } from "@/app/lib/profileBilling";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const profile = await getProfileRecord(user.email);
    const billing = resolveProfileBillingState(profile);
    const usedBytes = Number(profile.usedBytes || 0);

    return NextResponse.json({
      plans: PUBLIC_PLAN_CODES.map((code) => ({
        code,
        displayName: PLAN_DEFINITIONS[code].displayName,
        storageLabel: PLAN_DEFINITIONS[code].storageLabel,
        priceLabel: PLAN_DEFINITIONS[code].priceLabel,
        quotaBytes: PLAN_DEFINITIONS[code].quotaBytes,
        isPaid: PLAN_DEFINITIONS[code].isPaid,
        stripeConfigured: Boolean(getPriceIdForPlanCode(code)),
      })),
      currentPlan: {
        code: billing.planCode,
        displayName: billing.planDisplayName,
        priceLabel: billing.planPriceLabel,
        planStatus: billing.planStatus,
        quotaBytes: billing.quotaBytes,
        pendingPlanCode: billing.pendingPlanCode,
        pendingPlanDisplayName: billing.pendingPlanDisplayName,
        currentPeriodEnd: billing.currentPeriodEnd,
        gracePeriodEndsAt: billing.gracePeriodEndsAt,
        cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
        isLegacy: billing.isLegacy,
        usedBytes,
        overQuota: usedBytes > billing.quotaBytes,
      },
      billing: {
        canCheckout: Boolean(process.env.STRIPE_SECRET_KEY),
        canManagePortal: Boolean(
          process.env.STRIPE_SECRET_KEY && billing.stripeCustomerId,
        ),
        hasSubscription: Boolean(billing.stripeSubscriptionId),
      },
    });
  } catch (error: any) {
    console.error("[billing/plans] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to load plans" },
      { status: 500 },
    );
  }
}
