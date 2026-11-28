# Launch rules: must-know business and privacy protocol

A short checklist of rules to remember before and after launch. The details live in `docs/DPIA.md`, `docs/RECORD_OF_PROCESSING.md`, `docs/WEB_ANALYTICS.md` and ADR-016 to ADR-023 (`.github/instructions/architecture-decisions.instructions.md`). Not legal advice; have a lawyer review it once.

## Who we are

- **Controller:** Liron David, an Israeli sole proprietor (עוסק) with no registered trade name; contact privacy@kidocoach.app, Gai 5, Be'er Ya'akov, Israel. "Kidocoach" is the brand.
- The privacy policy must name the owner (full name) plus a contact email. Marketing emails to US addresses must also include a postal address (CAN-SPAM).
- Payments: Paddle is merchant of record on the web (it handles VAT and sales tax). Apple and Google handle tax for in-app purchases. Neither covers GDPR duties.

## Before launch (blocking)

- [x] Add the owner's full name to the privacy policy (`website/src/pages/Privacy.tsx`, intro and Contact) (2026-11-27).
- [x] Add a postal address to the footer of marketing emails: footer text in `docs/WEB_ANALYTICS.md` §6 step 4; paste it into the email provider's template when one is chosen.
- [x] Accept Google Cloud's data processing terms (Cloud console → IAM & Admin → Settings / Privacy & Security) (2026-11-27).
- [x] Sign or accept the Paddle and RevenueCat DPAs. Record the dates in `docs/RECORD_OF_PROCESSING.md`. (Both are incorporated in the providers' terms; PDFs saved 2026-11-27.)
- [x] GA4 admin: set event data retention to 2 months, turn off Google signals and ads personalization, and add no ad links. (Verified 2026-11-27.)
- [x] RevenueCat secret key (`REVENUECAT_SECRET_API_KEY`) has **Customer information: Read & write**, so `deleteAccount` erases the RevenueCat customer (verified 2026-11-27).
- [x] GA4 Admin → Data retention: event and user data 2 months, "Reset user data on new activity" off (verified 2026-11-27).
- [x] GA4 data sharing: only "Technical support" on (products/services, modelling, business recommendations off); granular location/device data off; ads personalisation allowed in no region (verified 2026-11-27).
- [x] Deploy the website (`cd website && npm run build && firebase deploy --only hosting:website`), then check in a fresh browser that **nothing** loads from a third party (fonts, images, analytics) before you click Accept. (2026-11-27: only Firestore/Storage, no cookies, on `/`, `/privacy`, `/subscribe`, `/profile`.)
- [x] Ship an app build with the current profile shape. Older TestFlight builds reject profiles saved without `gender`. (TestFlight build 12, 2026-11-21, includes it; testers must update.)
- [ ] Privacy policy and terms are linked from the paywall, Settings (behind the parental gate), the website footer (✓ verified 2026-11-27) and App Store Connect privacy policy URL (✓ set via API 2026-11-27) and the Play Console privacy policy (App content → Privacy policy, still to set).
- [ ] App Store / Play: enter the answers from **Store privacy answers** below (App Store labels ✓ published 2026-11-27; Play Data safety still to do). Privacy labels and Data Safety form must match reality (no tracking, no ads, the child data listed below). Kids Category or Designed for Families rules: no third-party analytics or ads in the app, and purchases and external links behind the parental gate.
- [x] Turn on Firestore backups. Keep them for no more than 35 days so deletions take effect. (Daily schedule, 35-day retention, 2026-11-27.)
- [ ] Have a lawyer read the privacy policy and terms once.

## Store privacy answers (App Store labels / Play Data Safety)

Fill these in exactly; update them in the same change as any new data field or SDK. The app has no analytics, ads, crash-reporting or attribution SDK.

**App Store Connect → App Privacy**
- Tracking: **No** (no data is used to track across apps/websites; no IDFA, no ATT prompt).
- Data collected, all **Linked to the user**, **Not used for tracking**, purpose **App Functionality** only:
  - Contact Info → **Name** (child's first name; Apple/Google sign-in name if the parent links one) and **Email Address** (only if the parent links an account).
  - Identifiers → **User ID** (Firebase UID, also the RevenueCat App User ID).
  - Purchases → **Purchase History** (RevenueCat entitlement/receipts).
  - User Content → **Other User Content** (birth date, questionnaire answers, wake-up/bedtime, routines, stars, trophies).
- Not collected: location, health, financial info, contacts, browsing/search history, diagnostics, usage data, sensitive info, photos/audio.
- Privacy policy URL: `https://kidocoach.app/privacy`.

**Google Play Console → Data safety**
- Collected (all *required for app functionality*, *processed ephemerally: no*, *users can request deletion: yes*):
  - Personal info → **Name**, **Email address** (optional), **User IDs**, **Other info** (birth date).
  - Financial info → **Purchase history**.
  - App activity → **Other user-generated content** (questionnaire answers, routines, stars, trophies).
- Shared with third parties: **No** (Google Cloud, RevenueCat and Paddle are processors / service providers, which Play excludes from "sharing").
- Encrypted in transit: **Yes**. Account deletion: **in the app** and URL `https://kidocoach.app/privacy#delete-account`.
- Target audience includes children → Families policy: no ads SDKs, parental gate on purchases/links ✓.

## Rules that never change (ADR-024)

1. **Collect only what a feature uses.** Child data is limited to first name, birth date/age, questionnaire answers, wake-up/bedtime, routines, stars and trophies. No gender, photos, voice, location or free text. A new child field requires updating the DPIA, the record of processing and the privacy policy **in the same change**.
2. **No ads and no tracking of children.** The app has no analytics SDK. Website analytics is opt-in, only for parents, and sends no names, emails, birth dates or gender (age band only). User ID = Firebase UID.
3. **No third-party requests before consent on the website.** Self-host fonts, images and scripts. Firebase and Paddle calls needed to run the service are fine.
4. **The parent is the user.** Kids never see purchases, sign-in, outside links or settings without the parental gate (PIN or math question).
5. **AI runs on the server only.** Only the child's first name goes to Gemini TTS, to make the greeting. No API keys in the app.
6. **Retention must match the privacy policy:** account data until deletion; greetings 1 year without use (TTL); GA 2 months (aggregated reports are unaffected); BigQuery GA export 26 months; `paddle_events` 90 days; unsubscribed emails keep only a hash.
7. **Account deletion actually deletes** the Firestore user data, Auth account, attribution, RevenueCat customer and website analytics (GA4 + BigQuery, ~5 days later), and cancels the Paddle subscription. Commission and payment records stay for accounting.

## After launch (recurring)

| When | What |
|---|---|
| Any data request (access, delete, correct, export) | Reply within **30 days** (target: 7). Verify it comes from the account's email. Log the date and what you did. |
| Data breach | Within **72 h**: assess the risk and notify the relevant authority if there's risk to people (EU: lead authority of the affected users; UK: ICO). Tell affected parents without delay if the risk is high. Follow the procedure in `docs/RECORD_OF_PROCESSING.md`. |
| New provider, SDK or data field | Update the DPIA, record of processing and privacy policy before shipping. Sign the provider's DPA. |
| Monthly | Run the affiliate payout report (`npm run affiliates -- report`), pay, then `mark-paid`. Check Paddle for refunds and chargebacks. |
| Quarterly | Check GA4 settings and BigQuery expiry are unchanged. Check the website still makes no third-party requests before consent. Remove unused test accounts. |
| Yearly | Review the privacy policy, DPIA and terms; update the "last updated" date. Review who has access to Firebase, GCP, Paddle, RevenueCat and the stores; remove anyone who no longer needs it. |

## EU/UK representative (GDPR Art. 27)

- **Not appointed yet.** That's acceptable while EU/UK users are occasional. Storing data on EU servers doesn't change this; only where the business is established matters.
- **Trigger to appoint:** EU/UK families start subscribing regularly (e.g. more than a few per month), or you start marketing there. A representative service costs about €100–300/year each for the EU and UK. Add its address to the privacy policy.
- **Until then:** answer every privacy request quickly and politely. Regulators act on complaints, and unanswered requests are what lead to fines (max €10M or 2% of turnover; UK £8.7M).
- Alternative: block EU/UK sales in Paddle and the stores.

## US (COPPA and state laws)

- The app is directed to children, so COPPA applies: the parent sets everything up, nothing is collected from the child directly, and there are no behavioural ads. Verifiable parental consent comes from the parent creating the account and paying behind the parental gate.
- Honour Global Privacy Control (already done). Never sell or share data for advertising.

## Money and partners

- Commissions: 15% of pre-tax sales for 12 months, held 30 days, then paid manually (Wise or PayPal). Refunds reverse them. See ADR-019.
- The partner program stays closed (`npm run affiliates -- program closed`) until the terms and payouts are ready. Invite partners by email.
- Report income to the Israeli tax authority (מס הכנסה and VAT as an עוסק). Paddle and store payouts are foreign income; keep invoices and payout statements.
