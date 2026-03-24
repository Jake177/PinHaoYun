"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type PublicPlan = {
  code: string;
  displayName: string;
  storageLabel: string;
  priceLabel: string;
  quotaBytes: number;
  isPaid: boolean;
  stripeConfigured: boolean;
};

type BillingData = {
  plans: PublicPlan[];
  currentPlan: {
    code: string;
    displayName: string;
    priceLabel: string;
    planStatus: string;
    quotaBytes: number;
    pendingPlanCode: string | null;
    pendingPlanDisplayName: string | null;
    currentPeriodEnd: string | null;
    gracePeriodEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    isLegacy: boolean;
    usedBytes: number;
    overQuota: boolean;
  };
  billing: {
    canCheckout: boolean;
    canManagePortal: boolean;
    hasSubscription: boolean;
  };
};

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** power;
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[power]}`;
};

const formatDate = (value: string | null): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

export default function PlansClient() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPlan, setActionPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const checkoutState = useMemo(() => searchParams.get("checkout"), [searchParams]);

  const fetchPlans = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/billing/plans");
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error || "Failed to load plans.");
      }
      const payload = (await response.json()) as BillingData;
      setData(payload);
    } catch (err: any) {
      setError(err?.message || "Failed to load plans.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  useEffect(() => {
    if (checkoutState === "success") {
      setNotice("Checkout completed. Your plan will appear after Stripe confirms payment.");
    } else if (checkoutState === "canceled") {
      setNotice("Checkout was canceled.");
    }
  }, [checkoutState]);

  const postAndRedirect = useCallback(async (url: string, body?: Record<string, unknown>) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      url?: string;
      message?: string;
    };
    if (!response.ok) {
      throw new Error(payload.error || payload.message || "Request failed.");
    }
    if (!payload.url) {
      throw new Error("Redirect URL is missing.");
    }
    window.location.assign(payload.url);
  }, []);

  const handleCheckout = useCallback(
    async (targetPlanCode: string) => {
      setActionPlan(targetPlanCode);
      setError(null);
      setNotice(null);
      try {
        await postAndRedirect("/api/billing/checkout", { targetPlanCode });
      } catch (err: any) {
        setError(err?.message || "Failed to start checkout.");
        setActionPlan(null);
      }
    },
    [postAndRedirect],
  );

  const handlePortal = useCallback(async () => {
    setActionPlan("portal");
    setError(null);
    setNotice(null);
    try {
      await postAndRedirect("/api/billing/portal");
    } catch (err: any) {
      setError(err?.message || "Failed to open billing portal.");
      setActionPlan(null);
    }
  }, [postAndRedirect]);

  const handleChangePlan = useCallback(
    async (targetPlanCode: string) => {
      setActionPlan(targetPlanCode);
      setError(null);
      setNotice(null);
      try {
        const response = await fetch("/api/billing/change-plan", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ targetPlanCode }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || "Failed to update plan.");
        }
        setNotice("Plan change scheduled for the next billing cycle.");
        await fetchPlans();
      } catch (err: any) {
        setError(err?.message || "Failed to update plan.");
      } finally {
        setActionPlan(null);
      }
    },
    [fetchPlans],
  );

  const getActionForPlan = (plan: PublicPlan) => {
    if (!data) {
      return {
        disabled: true,
        label: "Loading...",
        onClick: () => undefined,
      };
    }

    const currentPlan = data.currentPlan;
    const isCurrent = currentPlan.code === plan.code;
    const isPending = currentPlan.pendingPlanCode === plan.code;
    const billingUnavailable = !data.billing.canCheckout || !plan.stripeConfigured;

    if (currentPlan.isLegacy) {
      return {
        disabled: true,
        label: isCurrent ? "Current plan" : "Legacy account",
        onClick: () => undefined,
      };
    }

    if (isCurrent && !currentPlan.pendingPlanCode) {
      return {
        disabled: true,
        label: "Current plan",
        onClick: () => undefined,
      };
    }

    if (isPending) {
      return {
        disabled: true,
        label: "Scheduled",
        onClick: () => undefined,
      };
    }

    if (currentPlan.code === "FREE") {
      if (plan.code === "FREE") {
        return {
          disabled: true,
          label: "Current plan",
          onClick: () => undefined,
        };
      }
      return {
        disabled: billingUnavailable,
        label: billingUnavailable ? "Billing unavailable" : "Upgrade yearly",
        onClick: () => handleCheckout(plan.code),
      };
    }

    if (plan.code === "FREE") {
      return {
        disabled: false,
        label: "Move at renewal",
        onClick: () => handleChangePlan("FREE"),
      };
    }

    return {
      disabled: billingUnavailable,
      label: billingUnavailable ? "Billing unavailable" : "Switch next cycle",
      onClick: () => handleChangePlan(plan.code),
    };
  };

  if (loading) {
    return (
      <div className="plans-page">
        <div className="profile-card">
          <p className="muted">Loading plans...</p>
        </div>
      </div>
    );
  }

  const currentPlanDate =
    data?.currentPlan.planStatus === "grace_period"
      ? formatDate(data.currentPlan.gracePeriodEndsAt)
      : formatDate(data?.currentPlan.currentPeriodEnd || null);

  return (
    <div className="plans-page">
      <div className="profile-header">
        <Link href="/dashboard" className="back-link">
          ← Back to videos
        </Link>
        <h1>Membership</h1>
        <p className="plans-page__subtitle">
          Plan changes apply on the next billing cycle. If your current usage is
          above the new quota, uploads pause until usage drops back under the limit.
        </p>
      </div>

      {error ? <div className="auth-errors">{error}</div> : null}
      {notice ? <div className="auth-feedback">{notice}</div> : null}

      {data ? (
        <>
          <section className="plans-summary">
            <div className="plans-summary__card">
              <div className="plans-summary__eyebrow">Current plan</div>
              <h2>{data.currentPlan.displayName}</h2>
              <p className="plans-summary__storage">
                {formatBytes(data.currentPlan.usedBytes)} used of{" "}
                {formatBytes(data.currentPlan.quotaBytes)}
              </p>
              <p className="plans-summary__meta">
                {data.currentPlan.isLegacy
                  ? "Permanent free legacy access"
                  : data.currentPlan.planStatus === "grace_period"
                    ? `Payment grace period until ${currentPlanDate || "soon"}`
                    : data.currentPlan.pendingPlanDisplayName
                      ? `Next cycle: ${data.currentPlan.pendingPlanDisplayName}`
                      : currentPlanDate
                        ? `Current cycle ends ${currentPlanDate}`
                        : data.currentPlan.priceLabel}
              </p>
              {data.currentPlan.overQuota ? (
                <div className="plans-summary__warning">
                  Uploads are blocked until usage falls below your active quota.
                </div>
              ) : null}
            </div>

            <div className="plans-summary__actions">
              {data.billing.canManagePortal ? (
                <button
                  type="button"
                  className="pill pill--secondary"
                  onClick={handlePortal}
                  disabled={actionPlan === "portal"}
                >
                  {actionPlan === "portal" ? "Opening..." : "Manage Billing"}
                </button>
              ) : null}
            </div>
          </section>

          <section className="plans-grid">
            {data.plans.map((plan) => {
              const action = getActionForPlan(plan);
              const isCurrent = data.currentPlan.code === plan.code;
              const isPending = data.currentPlan.pendingPlanCode === plan.code;

              return (
                <article
                  key={plan.code}
                  className={`plan-card ${isCurrent ? "plan-card--current" : ""}`}
                >
                  <div className="plan-card__header">
                    <div>
                      <div className="plan-card__name">{plan.displayName}</div>
                      <div className="plan-card__price">{plan.priceLabel}</div>
                    </div>
                    {isCurrent ? (
                      <span className="plan-card__badge">Active</span>
                    ) : isPending ? (
                      <span className="plan-card__badge plan-card__badge--pending">
                        Next
                      </span>
                    ) : null}
                  </div>
                  <div className="plan-card__storage">{plan.storageLabel}</div>
                  <div className="plan-card__hint">
                    {plan.code === "FREE"
                      ? "Best for getting started"
                      : plan.code === "PLUS"
                        ? "Ideal for a light personal archive"
                        : plan.code === "PRO"
                          ? "Balanced storage for growing libraries"
                          : "Best for full-resolution long-term storage"}
                  </div>
                  <button
                    type="button"
                    className={`pill ${isCurrent ? "pill--secondary" : "pill--primary"}`}
                    onClick={action.onClick}
                    disabled={action.disabled || actionPlan === plan.code}
                  >
                    {actionPlan === plan.code ? "Working..." : action.label}
                  </button>
                </article>
              );
            })}
          </section>
        </>
      ) : null}
    </div>
  );
}
