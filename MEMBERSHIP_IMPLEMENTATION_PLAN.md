# PinHaoYun Membership Implementation Plan

This document captures the agreed first version of the PinHaoYun membership system so future implementation work can follow a stable reference.

## Scope

First version goals:

- Web-only purchase and subscription management
- No in-app purchase flow
- Stripe as the billing provider
- Storage entitlement is driven by DynamoDB `PROFILE.quotaBytes`
- Existing users are permanently grandfathered into a free legacy tier

Out of scope for v1:

- Native app purchase flows
- Monthly billing
- Coupons / promo codes
- Team / family plans
- Proration-heavy upgrade logic
- Full billing history UI

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

### Business rules

- All newly registered users start on `FREE`.
- Existing users are migrated to `LEGACY_5TB`.
- `LEGACY_5TB` is permanently free.
- Payment failure grants a 7-day grace period.
- During grace period, the current paid quota remains active.
- After grace period expires without recovery, the user falls back to `FREE`.
- If a downgrade would put the user over the new quota:
  - browsing and downloading remain allowed
  - new uploads are blocked
- First version applies plan changes on the next billing cycle.
  - This includes upgrade and downgrade.
  - A target plan should be stored as `pendingPlanCode`.

## Canonical Storage Values

Use binary units consistently (`1024`-based):

| Plan Code | Bytes |
| --- | ---: |
| `FREE` | `10 * 1024 * 1024 * 1024` = `10737418240` |
| `PLUS` | `256 * 1024 * 1024 * 1024` = `274877906944` |
| `PRO` | `1024 * 1024 * 1024 * 1024` = `1099511627776` |
| `ULTRA` | `5 * 1024 * 1024 * 1024 * 1024` = `5497558138880` |
| `LEGACY_5TB` | `5 * 1024 * 1024 * 1024 * 1024` = `5497558138880` |

## Current Relevant Code

Current quota defaults and enforcement are spread across:

- `aws/lambda/postConfirmation.js`
- `app/api/videos/multipart/init/route.ts`
- `app/api/videos/notify/route.ts`
- `app/api/user/profile/route.ts`
- `app/components/profile/ProfileClient.tsx`
- `app/components/dashboard/DashboardClient.tsx`

The implementation should centralize plan definitions so quota values are not hard-coded in multiple places.

## Proposed New Shared Config

Add a shared plan config module:

- `app/lib/plans.ts`

Suggested responsibilities:

- export plan constants
- export a `PLAN_DEFINITIONS` map
- export helper functions such as:
  - `getPlanQuotaBytes(planCode)`
  - `isPublicPlan(planCode)`
  - `isLegacyPlan(planCode)`
  - `getPlanPriceLabel(planCode)`

Suggested plan codes:

- `FREE`
- `PLUS`
- `PRO`
- `ULTRA`
- `LEGACY_5TB`

## DynamoDB PROFILE Changes

Extend the existing `PROFILE` item with these fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `planCode` | string | Current active plan code |
| `planStatus` | string | `free`, `active`, `grace_period`, `canceled` |
| `quotaBytes` | number | Current enforced storage quota |
| `isLegacy` | boolean | Marks grandfathered users |
| `billingProvider` | string | `stripe` for paid users |
| `stripeCustomerId` | string | Stripe customer ID |
| `stripeSubscriptionId` | string | Stripe subscription ID |
| `stripePriceId` | string | Active Stripe price ID |
| `currentPeriodEnd` | string | ISO timestamp for current billing period end |
| `gracePeriodEndsAt` | string | ISO timestamp when grace period ends |
| `pendingPlanCode` | string | Next-cycle plan change target |
| `cancelAtPeriodEnd` | boolean | Stripe cancellation intent |

Notes:

- `quotaBytes` remains the upload enforcement source of truth.
- `planCode` must always match `quotaBytes`.
- `LEGACY_5TB` users should have:
  - `planCode = LEGACY_5TB`
  - `planStatus = active`
  - `isLegacy = true`
  - no Stripe fields

## Registration Defaults

Change new-user defaults in `aws/lambda/postConfirmation.js`:

- set `planCode = FREE`
- set `planStatus = free`
- set `quotaBytes = 10GB`
- set `isLegacy = false`

Also update any server fallback logic that currently assumes `256GB`.

Known places to change:

- `aws/lambda/postConfirmation.js`
- `app/api/videos/multipart/init/route.ts`
- `app/api/videos/notify/route.ts`
- `app/api/user/profile/route.ts`
- any UI fallback using `256 * 1024 * 1024 * 1024`

## Stripe Model

Use Stripe Billing for subscriptions.

Recommended Stripe objects:

- One Product for PinHaoYun storage
- Three yearly recurring prices:
  - `PLUS`
  - `PRO`
  - `ULTRA`

No Stripe product is needed for:

- `FREE`
- `LEGACY_5TB`

Suggested environment variables:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_PLUS_YEARLY`
- `STRIPE_PRICE_PRO_YEARLY`
- `STRIPE_PRICE_ULTRA_YEARLY`
- `NEXT_PUBLIC_APP_URL`

## Backend API Surface

Suggested first-version endpoints:

### `GET /api/billing/plans`

Returns:

- public plan list
- current user plan
- pending plan if any
- grace period info if any
- whether user is legacy

### `POST /api/billing/checkout`

Creates a Stripe Checkout Session for a new paid subscription.

Input:

- `targetPlanCode`

Rules:

- reject `FREE`
- reject `LEGACY_5TB`
- require logged-in user

### `POST /api/billing/portal`

Creates a Stripe Billing Portal session for users who already have a Stripe customer.

### `POST /api/billing/webhook`

Receives Stripe webhook events and updates `PROFILE`.

This endpoint is the billing source of truth.

## Stripe Webhook Behavior

Implement only the minimum event set for v1:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

High-level expected behavior:

### Payment success / active subscription

- set `planStatus = active`
- set `planCode` to the paid plan
- set `quotaBytes` to the plan quota
- clear `gracePeriodEndsAt`
- set `currentPeriodEnd`

### Payment failed

- set `planStatus = grace_period`
- set `gracePeriodEndsAt = now + 7 days`
- keep current `quotaBytes`

### Grace period expired without recovery

This can be handled by:

- webhook logic if Stripe gives a definitive terminal state, or
- a scheduled cleanup job that checks expired grace periods

Result:

- set `planCode = FREE`
- set `planStatus = free`
- set `quotaBytes = 10GB`
- clear paid subscription state as appropriate

### Cancellation / downgrade

For v1:

- do not apply immediately
- store target in `pendingPlanCode`
- apply on next cycle boundary

If the target plan is smaller than current usage:

- still apply the lower `quotaBytes`
- upload attempts must fail
- existing media remains viewable/downloadable

## Upload Enforcement

The existing upload gate in `app/api/videos/multipart/init/route.ts` should stay the main enforcement point.

Required behavior:

- continue checking `usedBytes + reservedBytes + newUploadSize <= quotaBytes + GRACE_BYTES`
- no deletion or hiding when user is over quota
- only block new uploads

This means no large refactor is needed for media operations.

## Frontend

Add a simple plans page, for example:

- `app/dashboard/plans/page.tsx`
- `app/components/billing/PlansClient.tsx`

First version UI should show:

- current active plan
- legacy badge if applicable
- yearly public plans
- upgrade / subscribe button
- manage billing button for paid users
- pending plan change notice
- grace period warning if payment failed

Profile API should return the new billing fields so the UI can render plan state.

## Legacy Migration

A one-time migration script is required.

Purpose:

- find all existing `PROFILE` items
- set each to `LEGACY_5TB`

Required values:

- `planCode = LEGACY_5TB`
- `planStatus = active`
- `quotaBytes = 5497558138880`
- `isLegacy = true`

Stripe fields should not be created for legacy users.

Suggested script:

- `scripts/migrate-users-to-legacy-plan.js`

## Rollout Order

Recommended rollout sequence:

1. Create `app/lib/plans.ts`.
2. Replace all hard-coded quota defaults with shared plan helpers.
3. Change new-user registration default to `FREE 10GB`.
4. Extend `PROFILE` reads/writes to include plan fields.
5. Create and test the legacy migration script.
6. Run legacy migration in production data.
7. Add Stripe Checkout / Portal / Webhook endpoints.
8. Create a minimal plans page in the dashboard.
9. Verify:
   - new users get 10GB
   - legacy users stay on free 5TB
   - paid users get correct quota
   - failed payments enter grace period
   - over-quota downgraded users cannot upload

## Open Implementation Notes

- Even though v1 applies upgrades on the next billing cycle, note that this is unusual UX.
- A future version may change this to:
  - upgrade immediately
  - downgrade at next renewal
- If mobile apps are added later, do not assume the same payment entry flow can be reused inside native apps.

## Summary

The v1 membership system should be built around one principle:

- Stripe controls subscription state
- DynamoDB `PROFILE` stores the app-facing entitlement state
- `quotaBytes` remains the operational upload gate

This keeps the first version small, compatible with the current codebase, and expandable later.
