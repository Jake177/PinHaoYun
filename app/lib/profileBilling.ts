import {
  DEFAULT_PLAN_CODE,
  getPlanDisplayName,
  getPlanPriceLabel,
  getPlanQuotaBytes,
  inferPlanCodeFromQuotaBytes,
  isLegacyPlan,
  isPlanCode,
  LEGACY_PLAN_CODE,
  type PlanCode,
  type PlanStatus,
} from "@/app/lib/plans";

const VALID_PLAN_STATUSES = new Set<PlanStatus>([
  "free",
  "active",
  "grace_period",
  "canceled",
]);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const asBoolean = (value: unknown): boolean =>
  value === true || value === "true" || value === 1 || value === "1";

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const resolvePlanStatus = (
  value: unknown,
  planCode: PlanCode,
): PlanStatus => {
  if (typeof value === "string" && VALID_PLAN_STATUSES.has(value as PlanStatus)) {
    return value as PlanStatus;
  }
  return planCode === DEFAULT_PLAN_CODE ? "free" : "active";
};

export type ResolvedProfileBilling = {
  planCode: PlanCode;
  planDisplayName: string;
  planPriceLabel: string;
  planStatus: PlanStatus;
  quotaBytes: number;
  isLegacy: boolean;
  billingProvider: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  currentPeriodEnd: string | null;
  gracePeriodEndsAt: string | null;
  pendingPlanCode: PlanCode | null;
  pendingPlanDisplayName: string | null;
  cancelAtPeriodEnd: boolean;
  isGraceExpired: boolean;
};

export function resolveProfileBillingState(
  dbProfile: Record<string, unknown>,
  now = new Date(),
): ResolvedProfileBilling {
  const quotaFromProfile = asNumber(dbProfile.quotaBytes);
  const inferredPlanCode = inferPlanCodeFromQuotaBytes(quotaFromProfile);

  let planCode = isPlanCode(dbProfile.planCode)
    ? dbProfile.planCode
    : inferredPlanCode || DEFAULT_PLAN_CODE;

  const isLegacy = asBoolean(dbProfile.isLegacy) || isLegacyPlan(planCode);

  if (isLegacy) {
    planCode = LEGACY_PLAN_CODE;
  }

  let planStatus = resolvePlanStatus(dbProfile.planStatus, planCode);
  let quotaBytes = quotaFromProfile ?? getPlanQuotaBytes(planCode);
  const gracePeriodEndsAt = asString(dbProfile.gracePeriodEndsAt);
  const graceEndsAtMs = gracePeriodEndsAt ? Date.parse(gracePeriodEndsAt) : NaN;
  const isGraceExpired =
    planStatus === "grace_period" &&
    Number.isFinite(graceEndsAtMs) &&
    graceEndsAtMs <= now.getTime();

  if (isLegacy) {
    planStatus = "active";
    quotaBytes = getPlanQuotaBytes(LEGACY_PLAN_CODE);
  } else if (isGraceExpired) {
    planCode = DEFAULT_PLAN_CODE;
    planStatus = "free";
    quotaBytes = getPlanQuotaBytes(DEFAULT_PLAN_CODE);
  }

  const pendingPlanCode = isPlanCode(dbProfile.pendingPlanCode)
    ? dbProfile.pendingPlanCode
    : null;

  return {
    planCode,
    planDisplayName: getPlanDisplayName(planCode),
    planPriceLabel: getPlanPriceLabel(planCode),
    planStatus,
    quotaBytes,
    isLegacy,
    billingProvider: asString(dbProfile.billingProvider),
    stripeCustomerId: asString(dbProfile.stripeCustomerId),
    stripeSubscriptionId: asString(dbProfile.stripeSubscriptionId),
    stripePriceId: asString(dbProfile.stripePriceId),
    currentPeriodEnd: asString(dbProfile.currentPeriodEnd),
    gracePeriodEndsAt,
    pendingPlanCode,
    pendingPlanDisplayName: pendingPlanCode
      ? getPlanDisplayName(pendingPlanCode)
      : null,
    cancelAtPeriodEnd: asBoolean(dbProfile.cancelAtPeriodEnd),
    isGraceExpired,
  };
}
