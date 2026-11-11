# Launch rules: must-know business and privacy protocol

A short checklist of rules to remember before and after launch. The details live in `docs/DPIA.md`, `docs/RECORD_OF_PROCESSING.md`, `docs/WEB_ANALYTICS.md` and ADR-016 to ADR-023 (`.github/instructions/architecture-decisions.instructions.md`). Not legal advice; have a lawyer review it once.

## Who we are

- **Controller:** the business owner, an Israeli sole proprietor (עוסק) with no registered trade name. "Kidocoach" is the brand.
- The privacy policy must name the owner (full name) plus a contact email. Marketing emails to US addresses must also include a postal address (CAN-SPAM).
- Payments: Paddle is merchant of record on the web (it handles VAT and sales tax). Apple and Google handle tax for in-app purchases. Neither covers GDPR duties.

## Before launch (blocking)

- [ ] Add the owner's full name to the privacy policy (`website/src/pages/Privacy.tsx`, intro and Contact).
- [ ] Add a postal address to the footer of marketing emails (a PO box or virtual address is fine).
- [ ] Accept Google Cloud's data processing terms (Cloud console → IAM & Admin → Settings / Privacy & Security).
- [ ] Sign or accept the Paddle and RevenueCat DPAs. Record the dates in `docs/RECORD_OF_PROCESSING.md`.
- [ ] GA4 admin: set data retention to 14 months, turn off Google signals and ads personalization, and add no ad links.
- [ ] Deploy the website (`cd website && npm run build && firebase deploy --only hosting:website`), then check in a fresh browser that **nothing** loads from a third party (fonts, images, analytics) before you click Accept.
- [ ] Ship an app build with the current profile shape. Older TestFlight builds reject profiles saved without `gender`.
- [ ] Privacy policy and terms are linked from the paywall, Settings (behind the parental gate), the website footer and both store listings.
- [ ] App Store / Play: privacy labels and Data Safety form match reality (no tracking, no ads, the child data listed below). Kids Category or Designed for Families rules: no third-party analytics or ads in the app, and purchases and external links behind the parental gate.
- [ ] Turn on Firestore backups (none exist yet). Keep them for no more than 35 days so deletions take effect.
- [ ] Have a lawyer read the privacy policy and terms once.

## Rules that never change (ADR-024)

1. **Collect only what a feature uses.** Child data is limited to first name, birth date/age, questionnaire answers, wake-up/bedtime, routines, stars and trophies. No gender, photos, voice, location or free text. A new child field requires updating the DPIA, the record of processing and the privacy policy **in the same change**.
2. **No ads and no tracking of children.** The app has no analytics SDK. Website analytics is opt-in, only for parents, and sends no names, emails, birth dates or gender (age band only). User ID = Firebase UID.
3. **No third-party requests before consent on the website.** Self-host fonts, images and scripts. Firebase and Paddle calls needed to run the service are fine.
4. **The parent is the user.** Kids never see purchases, sign-in, outside links or settings without the parental gate (PIN or math question).
5. **AI runs on the server only.** Only the child's first name goes to Gemini TTS, to make the greeting. No API keys in the app.
6. **Retention must match the privacy policy:** account data until deletion; greetings 1 year without use (TTL); GA 14 months; BigQuery GA export 26 months; `paddle_events` 90 days; unsubscribed emails keep only a hash.
7. **Account deletion actually deletes** the Firestore user data, Auth account, attribution and the Paddle subscription (cancelled). Commission and payment records stay for accounting.

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
