import planData from "@/shared/plans.json";

export const PLAN_CODES = [
  "FREE",
  "PLUS",
  "PRO",
  "ULTRA",
  "LEGACY_5TB",
] as const;

export type PlanCode = (typeof PLAN_CODES)[number];
export type PlanStatus = "free" | "active" | "grace_period" | "canceled";

export type PlanDefinition = {
  code: PlanCode;
  displayName: string;
  storageLabel: string;
  quotaBytes: number;
  priceUsdCents: number;
  priceLabel: string;
  isPublic: boolean;
  isPaid: boolean;
};

type RawPlanDefinition = Omit<PlanDefinition, "code">;

const rawPlans = planData.plans as Record<PlanCode, RawPlanDefinition>;

export const DEFAULT_PLAN_CODE: PlanCode = "FREE";
export const LEGACY_PLAN_CODE: PlanCode = "LEGACY_5TB";
export const MEMBERSHIP_GRACE_PERIOD_DAYS = 7;
export const MEMBERSHIP_GRACE_PERIOD_MS =
  MEMBERSHIP_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
export const UPLOAD_GRACE_BYTES = 1024 * 1024 * 1024;

export const PLAN_DEFINITIONS: Record<PlanCode, PlanDefinition> =
  PLAN_CODES.reduce((acc, code) => {
    acc[code] = {
      code,
      ...rawPlans[code],
    };
    return acc;
  }, {} as Record<PlanCode, PlanDefinition>);

export const PUBLIC_PLAN_CODES = PLAN_CODES.filter(
  (code) => PLAN_DEFINITIONS[code].isPublic,
);

export const PAID_PLAN_CODES = PLAN_CODES.filter(
  (code) => PLAN_DEFINITIONS[code].isPaid,
);

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && value in PLAN_DEFINITIONS;
}

export function isLegacyPlan(value: unknown): value is PlanCode {
  return value === LEGACY_PLAN_CODE;
}

export function isPublicPlan(value: unknown): value is PlanCode {
  return isPlanCode(value) && PLAN_DEFINITIONS[value].isPublic;
}

export function isPaidPlan(value: unknown): value is PlanCode {
  return isPlanCode(value) && PLAN_DEFINITIONS[value].isPaid;
}

export function getPlanDefinition(planCode?: string | null): PlanDefinition {
  if (planCode && isPlanCode(planCode)) {
    return PLAN_DEFINITIONS[planCode];
  }
  return PLAN_DEFINITIONS[DEFAULT_PLAN_CODE];
}

export function getPlanQuotaBytes(planCode?: string | null): number {
  return getPlanDefinition(planCode).quotaBytes;
}

export function getPlanDisplayName(planCode?: string | null): string {
  return getPlanDefinition(planCode).displayName;
}

export function getPlanPriceLabel(planCode?: string | null): string {
  return getPlanDefinition(planCode).priceLabel;
}

export function getPlanStorageLabel(planCode?: string | null): string {
  return getPlanDefinition(planCode).storageLabel;
}

export function inferPlanCodeFromQuotaBytes(
  quotaBytes?: number | null,
): PlanCode | null {
  if (!quotaBytes || !Number.isFinite(quotaBytes) || quotaBytes <= 0) {
    return null;
  }

  for (const code of PLAN_CODES) {
    if (PLAN_DEFINITIONS[code].quotaBytes === quotaBytes) {
      return code;
    }
  }

  return null;
}

export function getPriceIdForPlanCode(planCode: PlanCode): string | null {
  switch (planCode) {
    case "PLUS":
      return process.env.STRIPE_PRICE_PLUS_YEARLY || null;
    case "PRO":
      return process.env.STRIPE_PRICE_PRO_YEARLY || null;
    case "ULTRA":
      return process.env.STRIPE_PRICE_ULTRA_YEARLY || null;
    default:
      return null;
  }
}

export function getPlanCodeForPriceId(priceId?: string | null): PlanCode | null {
  if (!priceId) return null;

  if (priceId === process.env.STRIPE_PRICE_PLUS_YEARLY) return "PLUS";
  if (priceId === process.env.STRIPE_PRICE_PRO_YEARLY) return "PRO";
  if (priceId === process.env.STRIPE_PRICE_ULTRA_YEARLY) return "ULTRA";
  return null;
}
