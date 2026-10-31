# Kidocoach Website

Landing website for kidocoach.app.

## Features

- Centered autoplay welcome avatar video (URL loaded from Firestore)
- Top-right hamburger menu with Terms and Conditions + Privacy Policy
- Bottom-right App Store and Play Store links (loaded from Firestore)
- Static legal pages

## Local Run

1. Copy env vars:

```bash
cp .env.example .env
```

2. Fill in Firebase web config values in `.env`.
  Add GA4 measurement ID as well:

```bash
VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX
```

3. Install and run:

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Firestore Document

Document path:

`public_site/config`

Example payload:

```json
{
  "welcomeVideoUrl": "https://storage.googleapis.com/<bucket>/public/welcome.mp4",
  "appStoreUrl": "https://apps.apple.com/app/id6774532766",
  "playStoreUrl": "https://play.google.com/store/apps/details?id=com.kidocoach.app"
}
```

### Seed Command (Recommended)

You can seed this document using Firebase Admin SDK:

```bash
cd functions
npm run seed:public-site
```

Optional overrides:

```bash
WEBSITE_WELCOME_VIDEO_URL="https://storage.googleapis.com/<bucket>/public/welcome.mp4" \
WEBSITE_APP_STORE_URL="https://apps.apple.com/app/id6774532766" \
WEBSITE_PLAY_STORE_URL="https://play.google.com/store/apps/details?id=com.kidocoach.app" \
npm run seed:public-site
```

## Firebase Hosting

1. Build website:

```bash
cd website
npm run build
cd ..
```

2. Set hosting target (one-time):

```bash
firebase target:apply hosting website <your-hosting-site-id>
```

3. Deploy website target:

```bash
firebase deploy --only hosting:website
```

## Domain

Connect `kidocoach.app` to the Hosting site in Firebase Console and configure DNS records from your domain provider.

## Web payments and shared mobile access

`/profile` is the sign-in, registration, profile, and subscription page. `/subscribe` redirects
there while preserving coupon parameters. The website uses the same Firebase project and
**Firebase Auth UID as the RevenueCat App User ID** as the mobile app, so a family pays once and
has access on web, iPhone/iPad and Android.

- **Payments:** Paddle Billing (merchant of record: Paddle collects and remits VAT / sales tax).
  Cloud Functions create the transaction; the website only opens Paddle's overlay checkout
  (`@paddle/paddle-js`) with a client-side token. No Paddle API key is in the website.
- **Entitlement:** RevenueCat. Each Paddle subscription is imported into RevenueCat under the
  parent's Firebase UID, next to any App Store / Google Play purchase. Any active entitlement
  unlocks every platform.
- **One paying family:** `createPaddleCheckout` asks RevenueCat first and refuses checkout when
  the UID already has access from **any** store. It also imports the UID's existing Paddle
  subscriptions first. The mobile paywall is skipped once the shared entitlement is active.
- **Affiliates:** in-house (Cloud Functions + a signed Paddle webhook; see Affiliates below and ADR-019).

Existing guest families must link their account in the mobile Profile screen before signing in
on the web. Buying with a different Firebase account does not merge accounts or subscriptions.
Email, Google, and Apple sign-in are supported; enable the providers and authorize the website
domain in Firebase Authentication. Apple web sign-in additionally requires an Apple Services ID,
web domain/return URL registration, and its Firebase OAuth configuration. Associate the web Services
ID with the native app's primary App ID so Apple sign-in identifies the same parent across platforms.

### Web sign-in setup

Use [Firebase Authentication > Sign-in method](https://console.firebase.google.com/project/kids-routine-coach-app/authentication/providers)
in the existing `kids-routine-coach-app` project, not a separate web project.

1. Enable **Email/Password** (password-based sign-in, not email-link-only). The Profile form
   supports account creation, sign-in, and password reset. Do not put passwords in configuration.
2. Enable **Google**, choose the project's support email, and save. Firebase configures its
   web OAuth client; no Google client secret belongs in Vite variables.
3. For **Apple**, use an Apple **Services ID** registered for web sign-in as the Firebase
   provider's Service ID, associated with the mobile app's primary App ID. A native bundle ID
   alone does not configure web sign-in. Keep the existing native bundle IDs allowed.
   Register the domain `kids-routine-coach-app.firebaseapp.com` and this exact Return URL
   in that Services ID's Sign in with Apple configuration:

   ```text
   https://kids-routine-coach-app.firebaseapp.com/__/auth/handler
   ```

   Keep the Apple Team ID, Key ID, and `.p8` private key in Firebase's Apple OAuth code-flow
   settings only. Configure Apple's private email relay for Firebase's sender if parents use
   Hide My Email. Do not send the private key through chat or commit it.
4. Under **Authentication > Settings > Authorized domains**, include `kidocoach.app`,
   `www.kidocoach.app`, the existing Firebase Hosting domains, and `localhost` for local testing.
   `VITE_FIREBASE_AUTH_DOMAIN` currently uses `kids-routine-coach-app.firebaseapp.com`;
   the Apple return URL must match that auth domain, not `/profile`.
5. Open `/profile` and exercise each method with a test parent account, then sign out and
   sign in on mobile with the same provider. Confirm the UID and recovered child profile match.
   Test password reset and popup cancellation/blocked popups too. Allow sign-in popups in
   the browser; provider buttons show actionable errors if the browser blocks them.

The Google and Apple buttons render their logos locally. An email collision asks the parent
to use their original sign-in method; it never silently merges accounts or moves guest data.

### Paddle + RevenueCat setup (required before live payments)

Cloud Functions: `getWebBilling` (status + plans from Paddle prices), `createPaddleCheckout`
(creates a Paddle transaction with `custom_data.app_user_id` = UID), `syncPaddlePurchases` (runs
after checkout completes and on **Refresh subscription status**), `createPaddlePortal` (Paddle
customer portal for cancel / card / invoices). `deleteAccount` cancels the family's Paddle
subscriptions before deleting data. `billing_customers/{uid}` maps the UID to its Paddle customer
(stored only after a paid, server-created transaction) and is server-only.

1. **Paddle** (sandbox account first; sandbox and live are separate accounts):
   - **Catalog:** create a product with recurring price(s) (`pri_...`).
   - **Developer tools > Authentication:** create an **API key** (server) and a **client-side
     token** (`test_...` in sandbox, `live_...` in production).
   - **Checkout > Website approval:** approve `kidocoach.app` (live requires pricing, terms,
     privacy and refund-policy pages). **Checkout settings:** set the default payment link to
     `https://kidocoach.app/profile`.
   - Optional: **Discounts** with a code (see Coupons).
2. **RevenueCat** (the **same project** as iOS/Android):
   - **Project settings > Apps > + New > Paddle**: paste a Paddle API key with the permissions
     RevenueCat lists (Transactions, Customer portal sessions, Client-side tokens and Notification
     settings read+write; read on the rest). Copy that app's **public API key**.
   - Enable **Track new purchases from server-to-server notifications** and choose
     **Read App User ID from a Paddle metadata field** = `app_user_id`. Purchases then sync even if
     the parent closes the tab before `syncPaddlePurchases` runs.
   - Import the Paddle products and attach them to the **same entitlement** as the store products.
   - **Project settings > API keys:** create a **secret API key (v2)** (`sk_...`) with customer
     information read (the server reads `GET /v2/projects/{id}/customers/{uid}` and its subscriptions).
     Project configuration write lets scripts create the Paddle app via `POST /v2/projects/{id}/apps`.
   - Keep **Restore behavior** on "Transfer if there are no active subscriptions" (or stricter).
3. **Firebase Functions config:**

   ```bash
   firebase functions:secrets:set PADDLE_SANDBOX_API_KEY     # pdl_sdbx_... (the API base follows the key prefix)
   firebase functions:secrets:set REVENUECAT_SECRET_API_KEY  # RevenueCat v2 secret key
   ```

   And in `functions/.env.kids-routine-coach-app` (or answer the deploy prompt):

   ```bash
   PADDLE_PRICE_IDS=pri_monthly123,pri_yearly456
   REVENUECAT_PROJECT_ID=proj...
   REVENUECAT_PADDLE_PUBLIC_API_KEY=<RevenueCat Paddle app public key>
   ```

   The functions' Paddle key needs write access to Transactions, Subscriptions and Customer portal
   sessions, and read access to Prices, Products, Discounts and Customers.
4. **Website:** `VITE_PADDLE_CLIENT_TOKEN` in `website/.env`.
5. Deploy: `firebase deploy --only functions,firestore:rules,firestore:indexes`, then build and deploy the website.

Native access refreshes on foreground and web access on focus / Refresh status. Offline native
launches retain the existing cached-access behavior. Web checkout requires a connection.
A store subscription stays managed by its store (the profile page links to it); a web
subscription is managed in the Paddle customer portal.

### Coupons

- Coupon link: `https://kidocoach.app/profile?discount_code=SAVE20` (`coupon` is an alias).
  The code is a Paddle **discount code** (letters and digits); it is saved in the browser for
  30 days and applied when the transaction is created. Unknown or expired codes are rejected
  before checkout.
- Web coupons do not discount App Store or Google Play purchases.

### Affiliates (in-house)

Partner links are `https://kidocoach.app/?ref={code}` (any page). The website keeps the first
unexpired link for 60 days and, once the parent signs in, `claimAffiliateReferral` records an
immutable first-touch attribution (`affiliate_attributions/{uid}`). Self-referrals, disabled or
unknown codes and families that already bought on the web are refused. `createPaddleCheckout` then
stamps `custom_data.affiliate_code` from **that server record** (never from the browser), and
Paddle copies it to the subscription and every renewal. A partner coupon (`discountCode`) also
attributes an unattributed family at checkout. Affiliate errors never block a purchase.

`paddleWebhook` turns Paddle events into a commission ledger (`affiliate_commissions/{txn}`):
`transaction.completed` → `rate × (total − tax)` for the first payment within 60 days of the
claim and renewals for the partner's `recurringMonths` (default 12); approved refunds and
chargebacks reverse it proportionally. Commissions are held 30 days, then
`approveAffiliateCommissions` (daily, 03:00 UTC) approves them. Every collection is server-only.

1. **Webhook:** Paddle **Developer tools > Notifications > New destination**, URL
   `https://us-central1-kids-routine-coach-app.cloudfunctions.net/paddleWebhook`, events
   `transaction.completed`, `adjustment.created`, `adjustment.updated`. Store its secret:

   ```bash
   firebase functions:secrets:set PADDLE_WEBHOOK_SECRET   # the destination's pdl_ntfset_... secret key
   ```

   Keep RevenueCat's own Paddle destination; it is separate. The sandbox destination uses traffic
   source `all` so Paddle simulations (`ntfsimevt_` events) can exercise it; on the **live** account
   use `platform` so only real payments create commissions.
2. **Deploy:** `firebase deploy --only functions,firestore:rules,firestore:indexes` (the indexes
   add the approval query index and the `paddle_events.expireAt` TTL).
3. **Partners join themselves** at `https://kidocoach.app/partners` (`/affiliates` redirects): sign in,
   pick a code (live availability check via `checkAffiliateCode`; brand/route words are reserved),
   name, payout method (`paypal` default | `wise`) + payout email and accept the partner terms (`/terms#partners`). `createAffiliateAccount`
   creates an **active** partner on the default terms (15%, 12 months) with `ownerUid`, one per
   account (`affiliate_owners/{uid}`). The same page is their dashboard: link, clicks
   (`trackAffiliateClick`, one per browser/code/day, `affiliate_clicks/{code}_{day}`), sign-ups,
   paying families, earnings, recent sales (no family identifiers) and payouts
   (`affiliate_payouts`, written by `mark-paid`); they can edit name, payout method and payout email
   (`updateAffiliateSettings`). Rates, coupons and status stay admin-only.
   **Admin** (Application Default Credentials: `gcloud auth application-default login`):

   ```bash
   cd functions
   npm run affiliates -- create dana --name "Dana K" --email dana@example.com \
     [--rate-bps 1500] [--months 12] [--owner-uid <firebase uid>] [--coupon DANA10] [--payout-email ...]
   npm run affiliates -- update dana --rate-bps 2000 --months 6   # future payments only; --coupon/--owner-uid none clears
   npm run affiliates -- set-status dana disabled
   npm run affiliates -- list
   ```

   `--owner-uid` lets an admin-created partner see the dashboard on `/partners` (and `/profile`)
   after signing in with that account. Pause abusive partners with `set-status <code> disabled`. `--coupon` must be an existing Paddle discount code.
4. **Monthly payout:** `npm run affiliates -- report` (or `-- report --csv payouts.csv`) lists what each partner
   is owed per currency with their `payout_method` and `payout_email`. Send it from your PayPal or Wise business
   account to that email; the partner doesn't need an account beforehand (PayPal: claim within 30 days, Wise:
   within 7 days, or the money returns to you). Amounts are, net of refunds (a refund after a payout shows as a negative clawback).
   Pay that amount manually (PayPal/Wise), then `npm run affiliates -- mark-paid dana --currency USD --amount <owed_minor>`. It settles in one transaction and refuses if the owed total changed since the report (re-run `report`).

Only web (Paddle) purchases earn commission. App Store / Google Play purchases are not visible to
the program. Account deletion removes the attribution and pauses any partner code the account owns
(never reused); commission and payout records stay for accounting.

### Customer questionnaire and mobile sync

A customer with no saved child profile completes the same seven questionnaire steps as the app
before plans are displayed: child name/gender/birth date (ages 2–12), stuck points, motivation,
mastered tasks, help level, morning pace, and wake-up/bedtime. Choices, exclusive multi-select
behavior and tone mapping are shared with native in `utils/questionnaire.ts`. The web reuses
the native catalog parser, composer, schedule, and profile normalizer; no activity list is bundled.

Setup is committed atomically to `users/{uid}.childProfile` (Firestore-safe wrapped steps) and
missing `routines/{morning|evening}` metadata plus `activities/step_*` subcollection documents.
Existing routines and concurrently saved profiles are never replaced. Other user fields are
preserved. The mobile app recovers that setup after sign-in and handles local notifications and
offline media itself. Web setup requires a connection; failed saves display an error and retry.

### Release acceptance

Test in the Paddle sandbox with a RevenueCat sandbox: web purchase -> iOS/Android access;
native purchase -> web shows active status and blocks checkout; closing the tab during checkout,
then Refresh status; Paddle customer-portal cancellation vs expiration; refund; renewal; valid / invalid /
expired coupons; a `?ref=` partner link creates an attribution and, after the webhook, a pending commission (a refund reverses it); account deletion
cancels the Paddle subscription; and an offline mobile launch.
