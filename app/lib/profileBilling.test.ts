import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_CODE,
  getPlanDisplayName,
  getPlanQuotaBytes,
  LEGACY_PLAN_CODE,
  PLAN_CODES,
} from "./plans";
import { resolveProfileBillingState } from "./profileBilling";

describe("plans", () => {
  it("exposes canonical quotas for each plan", () => {
    expect(PLAN_CODES).toEqual([
      "FREE",
      "PLUS",
      "PRO",
      "ULTRA",
      "LEGACY_5TB",
    ]);
    expect(getPlanQuotaBytes("FREE")).toBe(10 * 1024 * 1024 * 1024);
    expect(getPlanQuotaBytes("PLUS")).toBe(256 * 1024 * 1024 * 1024);
    expect(getPlanQuotaBytes("PRO")).toBe(1024 * 1024 * 1024 * 1024);
    expect(getPlanQuotaBytes("ULTRA")).toBe(5 * 1024 * 1024 * 1024 * 1024);
    expect(getPlanQuotaBytes("LEGACY_5TB")).toBe(
      5 * 1024 * 1024 * 1024 * 1024,
    );
  });

  it("falls back to the free plan for unknown plan values", () => {
    expect(getPlanQuotaBytes("UNKNOWN")).toBe(getPlanQuotaBytes(DEFAULT_PLAN_CODE));
    expect(getPlanDisplayName("UNKNOWN")).toBe("Free");
  });
});

describe("resolveProfileBillingState", () => {
  it("forces legacy profiles to the Legacy 5TB entitlement", () => {
    const billing = resolveProfileBillingState({
      planCode: "FREE",
      planStatus: "free",
      quotaBytes: getPlanQuotaBytes("FREE"),
      isLegacy: true,
    });

    expect(billing.planCode).toBe(LEGACY_PLAN_CODE);
    expect(billing.planStatus).toBe("active");
    expect(billing.quotaBytes).toBe(getPlanQuotaBytes(LEGACY_PLAN_CODE));
    expect(billing.isLegacy).toBe(true);
  });

  it("falls back to free when a grace period has expired", () => {
    const billing = resolveProfileBillingState(
      {
        planCode: "PRO",
        planStatus: "grace_period",
        quotaBytes: getPlanQuotaBytes("PRO"),
        gracePeriodEndsAt: "2026-05-01T00:00:00Z",
      },
      new Date("2026-05-11T00:00:00Z"),
    );

    expect(billing.planCode).toBe("FREE");
    expect(billing.planStatus).toBe("free");
    expect(billing.quotaBytes).toBe(getPlanQuotaBytes("FREE"));
    expect(billing.isGraceExpired).toBe(true);
  });

  it("keeps paid quota during an active grace period", () => {
    const billing = resolveProfileBillingState(
      {
        planCode: "PLUS",
        planStatus: "grace_period",
        quotaBytes: getPlanQuotaBytes("PLUS"),
        gracePeriodEndsAt: "2026-05-20T00:00:00Z",
      },
      new Date("2026-05-11T00:00:00Z"),
    );

    expect(billing.planCode).toBe("PLUS");
    expect(billing.planStatus).toBe("grace_period");
    expect(billing.quotaBytes).toBe(getPlanQuotaBytes("PLUS"));
    expect(billing.isGraceExpired).toBe(false);
  });

  it("resolves pending plan display state", () => {
    const billing = resolveProfileBillingState({
      planCode: "PLUS",
      planStatus: "active",
      pendingPlanCode: "ULTRA",
    });

    expect(billing.pendingPlanCode).toBe("ULTRA");
    expect(billing.pendingPlanDisplayName).toBe("Ultra");
  });
});
