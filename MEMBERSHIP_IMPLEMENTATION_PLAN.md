# PinHaoYun Membership Implementation Status

Last audited: 2026-05-11.

This document is the current membership reference for the web app. The original v1 plan has mostly been implemented; this file now tracks the implemented behavior, the code surface, and the remaining gaps.

## Current Status

Implemented:

- Shared plan definitions live in `shared/plans.json` and are exposed through `app/lib/plans.ts`.
- New Cognito-confirmed users are initialized on the `FREE` plan by `aws/lambda/postConfirmation.js`.
- Existing pre-membership profiles can be migrated to `LEGACY_5TB` with `pnpm backfill:legacy-membership`.
- Upload quota enforcement reads the resolved billing state and enforces `PROFILE.quotaBytes`.
- Profile and dashboard UI show plan, storage usage, photo/video counts, and membership state.
- `/dashboard/plans` shows public plans and current membership state.
- Stripe Checkout starts new paid subscriptions.
- Stripe Billing Portal opens for users with a Stripe customer.
- `/api/billing/change-plan` schedules next-cycle switches for existing paid subscriptions.
- Stripe webhooks update plan status, quota, Stripe IDs, grace-period fields, cancellation state, and pending plan state.

Not implemented:

- Native-app purchase flows.
- Billing history UI inside PinHaoYun.
- Coupons, promo codes, monthly billing, team plans, or family plans.
- A scheduled job that proactively downgrades expired grace-period profiles. The app resolves expired grace periods at read/enforcement time, but it does not currently persist that cleanup unless a later billing event writes the profile.

## Product Rules

### Public plans

| Plan Code | Display Name | Storage | Price |
| --- | --- | ---: | ---: |
| `FREE` | Free | 10 GB | $0 / year |
| `PLUS` | Plus | 256 GB | $39.99 / year |
| `PRO` | Pro | 1 TB | $119.99 / year |
| `ULTRA` | Ultra | 5 TB | $299.99 / year |

### Legacy plan

| Plan Code | Display Name | Storage | Price | Visibility |
| --- | --- | ---: | ---: | --- |
| `LEGACY_5TB` | Legacy 5TB | 5 TB | $0 / year | Existing users only |

Business behavior:

- All newly registered users start on `FREE`.
- Existing users can be migrated to `LEGACY_5TB`.
- `LEGACY_5TB` is permanently free and cannot be changed through billing.
- Payment failure stores a 7-day grace period.
- During grace period, the paid quota remains active.
- After grace period expiry, resolved billing state falls back to `FREE`.
- If usage exceeds the active quota, browsing/downloading remain allowed and new uploads are blocked.
- First-version plan changes apply on the next billing cycle through `pendingPlanCode`.

## Canonical Storage Values

All values use binary units (`1024`-based):

| Plan Code | Bytes |
| --- | ---: |
| `FREE` | `10737418240` |
| `PLUS` | `274877906944` |
| `PRO` | `1099511627776` |
| `ULTRA` | `5497558138880` |
| `LEGACY_5TB` | `5497558138880` |

## Current Code Surface

Shared config and billing helpers:

- `shared/plans.json`
- `app/lib/plans.ts`
- `app/lib/profileBilling.ts`
- `app/lib/profileStore.ts`
- `app/lib/stripe.ts`
- `scripts/backfill-legacy-membership.js`

API routes:

- `GET /api/billing/plans`
- `POST /api/billing/checkout`
- `POST /api/billing/portal`
- `POST /api/billing/change-plan`
- `POST /api/billing/webhook`
- `GET /api/user/profile`
- `POST /api/videos/multipart/init`
- `POST /api/videos/notify`

UI:

- `app/dashboard/plans/page.tsx`
- `app/components/billing/PlansClient.tsx`
- `app/components/profile/ProfileClient.tsx`
- `app/components/dashboard/DashboardClient.tsx`

AWS:

- `aws/lambda/postConfirmation.js`

## DynamoDB PROFILE Fields

The app reads or writes these membership fields on the `PROFILE` item:

| Field | Purpose |
| --- | --- |
| `planCode` | Current active plan code |
| `planStatus` | `free`, `active`, `grace_period`, or `canceled` |
| `quotaBytes` | Upload enforcement quota |
| `isLegacy` | Marks grandfathered users |
| `billingProvider` | `stripe` for paid users |
| `stripeCustomerId` | Stripe customer ID |
| `stripeSubscriptionId` | Stripe subscription ID |
| `stripePriceId` | Active or scheduled Stripe price ID |
| `currentPeriodEnd` | ISO timestamp for current period end |
| `gracePeriodEndsAt` | ISO timestamp when grace period ends |
| `pendingPlanCode` | Next-cycle target plan |
| `cancelAtPeriodEnd` | Stripe cancellation intent |

## Stripe Events

Handled webhook events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Important behavior:

- `invoice.paid` activates the paid plan and updates `quotaBytes`.
- `invoice.payment_failed` marks `planStatus = grace_period` and sets `gracePeriodEndsAt`.
- `customer.subscription.deleted` falls back to `FREE`.
- Subscription updates preserve next-cycle plan changes through `pendingPlanCode`.

## Operational Notes

Required environment variables:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_PLUS_YEARLY`
- `STRIPE_PRICE_PRO_YEARLY`
- `STRIPE_PRICE_ULTRA_YEARLY`
- `NEXT_PUBLIC_APP_URL`

Backfill commands:

- `pnpm backfill:legacy-membership -- --dry-run`
- `pnpm backfill:legacy-membership`
- `pnpm backfill:legacy-membership -- --email=user@example.com`
