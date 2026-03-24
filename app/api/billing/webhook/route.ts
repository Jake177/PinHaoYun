import { headers } from "next/headers";
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getProfileRecord, updateProfileRecord } from "@/app/lib/profileStore";
import { resolveProfileBillingState } from "@/app/lib/profileBilling";
import {
  DEFAULT_PLAN_CODE,
  MEMBERSHIP_GRACE_PERIOD_MS,
  getPlanCodeForPriceId,
  getPlanQuotaBytes,
} from "@/app/lib/plans";
import { getCustomerEmail, getStripe, getStripeWebhookSecret } from "@/app/lib/stripe";

export const runtime = "nodejs";

function toIsoString(unixSeconds?: number | null): string | null {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function getSubscriptionPriceId(subscription: Stripe.Subscription): string | null {
  return subscription.items.data[0]?.price?.id || null;
}

function getSubscriptionCurrentPeriodEnd(
  subscription: Stripe.Subscription,
): number | undefined {
  return subscription.items.data[0]?.current_period_end;
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (typeof subscription === "string") return subscription;
  if (subscription && typeof subscription === "object") return subscription.id;
  return null;
}

async function resolveEventEmail(
  stripe: Stripe,
  options: {
    metadataEmail?: string | null;
    customerEmail?: string | null;
    customerId?: string | null;
  },
): Promise<string | null> {
  if (options.metadataEmail) return options.metadataEmail.toLowerCase();
  if (options.customerEmail) return options.customerEmail.toLowerCase();
  if (options.customerId) return getCustomerEmail(stripe, options.customerId);
  return null;
}

export async function POST(request: Request) {
  const stripe = getStripe();
  const headerStore = await headers();
  const signature = headerStore.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing Stripe signature" },
      { status: 400 },
    );
  }

  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      getStripeWebhookSecret(),
    );
  } catch (error: any) {
    console.error("[billing/webhook] signature error", error);
    return NextResponse.json(
      { error: error?.message || "Invalid webhook signature" },
      { status: 400 },
    );
  }

  try {
    const now = new Date();
    const nowIso = now.toISOString();

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId =
          typeof session.customer === "string" ? session.customer : null;
        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : null;
        const email = await resolveEventEmail(stripe, {
          metadataEmail: session.metadata?.email || null,
          customerEmail:
            session.customer_details?.email || session.customer_email || null,
          customerId,
        });

        if (email) {
          await updateProfileRecord(email, {
            set: {
              billingProvider: "stripe",
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscriptionId,
              updatedAt: nowIso,
            },
          });
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : null;
        const email = await resolveEventEmail(stripe, {
          metadataEmail: subscription.metadata?.email || null,
          customerId,
        });

        if (!email) break;

        const currentPriceId = getSubscriptionPriceId(subscription);
        const profile = await getProfileRecord(email);
        const billing = resolveProfileBillingState(profile, now);
        const pendingPlanCode = subscription.cancel_at_period_end
          ? DEFAULT_PLAN_CODE
          : billing.pendingPlanCode;

        await updateProfileRecord(email, {
          set: {
            billingProvider: "stripe",
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
            stripePriceId: currentPriceId,
            currentPeriodEnd: toIsoString(
              getSubscriptionCurrentPeriodEnd(subscription),
            ),
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            ...(pendingPlanCode ? { pendingPlanCode } : {}),
            updatedAt: nowIso,
          },
          remove: pendingPlanCode ? [] : ["pendingPlanCode"],
        });
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId =
          typeof invoice.customer === "string" ? invoice.customer : null;
        const subscriptionId = getInvoiceSubscriptionId(invoice);
        const email = await resolveEventEmail(stripe, {
          metadataEmail: invoice.metadata?.email || null,
          customerEmail: invoice.customer_email || null,
          customerId,
        });

        if (!email || !subscriptionId) break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = getSubscriptionPriceId(subscription);
        const planCode = getPlanCodeForPriceId(priceId);
        if (!planCode) break;

        await updateProfileRecord(email, {
          set: {
            planCode,
            planStatus: "active",
            quotaBytes: getPlanQuotaBytes(planCode),
            isLegacy: false,
            billingProvider: "stripe",
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
            stripePriceId: priceId,
            currentPeriodEnd: toIsoString(
              getSubscriptionCurrentPeriodEnd(subscription),
            ),
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            updatedAt: nowIso,
          },
          remove: [
            "gracePeriodEndsAt",
            ...(subscription.cancel_at_period_end ? [] : ["pendingPlanCode"]),
          ],
        });
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId =
          typeof invoice.customer === "string" ? invoice.customer : null;
        const subscriptionId = getInvoiceSubscriptionId(invoice);
        const email = await resolveEventEmail(stripe, {
          metadataEmail: invoice.metadata?.email || null,
          customerEmail: invoice.customer_email || null,
          customerId,
        });

        if (!email) break;

        let currentPeriodEnd: string | null = null;
        let cancelAtPeriodEnd = false;
        let priceId: string | null = null;

        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          currentPeriodEnd = toIsoString(
            getSubscriptionCurrentPeriodEnd(subscription),
          );
          cancelAtPeriodEnd = subscription.cancel_at_period_end;
          priceId = getSubscriptionPriceId(subscription);
        }

        await updateProfileRecord(email, {
          set: {
            planStatus: "grace_period",
            gracePeriodEndsAt: new Date(
              now.getTime() + MEMBERSHIP_GRACE_PERIOD_MS,
            ).toISOString(),
            billingProvider: "stripe",
            stripeCustomerId: customerId,
            ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
            ...(priceId ? { stripePriceId: priceId } : {}),
            ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
            cancelAtPeriodEnd,
            updatedAt: nowIso,
          },
        });
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : null;
        const email = await resolveEventEmail(stripe, {
          metadataEmail: subscription.metadata?.email || null,
          customerId,
        });

        if (!email) break;

        await updateProfileRecord(email, {
          set: {
            planCode: DEFAULT_PLAN_CODE,
            planStatus: "free",
            quotaBytes: getPlanQuotaBytes(DEFAULT_PLAN_CODE),
            isLegacy: false,
            billingProvider: "stripe",
            ...(customerId ? { stripeCustomerId: customerId } : {}),
            cancelAtPeriodEnd: false,
            updatedAt: nowIso,
          },
          remove: [
            "stripeSubscriptionId",
            "stripePriceId",
            "currentPeriodEnd",
            "gracePeriodEndsAt",
            "pendingPlanCode",
          ],
        });
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (error: any) {
    console.error("[billing/webhook] handler error", error);
    return NextResponse.json(
      { error: error?.message || "Webhook handler failed" },
      { status: 500 },
    );
  }
}
