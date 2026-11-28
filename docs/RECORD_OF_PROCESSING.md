# Record of processing activities (GDPR / UK GDPR Art. 30)

Internal record, not published. Update it in the same change whenever a new provider, data field or
purpose is added. Last reviewed: 2026-11-11. Not legal advice.

**Controller:** Liron David (sole proprietor, brand Kidocoach), Gai 5, Be'er Ya'akov, Israel; privacy@kidocoach.app (Cloudflare Email Routing → Worker `privacy-mail-fanout`, which forwards to both founders). No EU/UK establishment; EU/UK representative
not yet appointed (see `docs/WEB_ANALYTICS.md` §5, *International transfers*). No DPO (not required: no
large-scale special-category processing or systematic monitoring as a core activity).

## Processing activities

| # | Activity | Data subjects | Personal data | Purpose / legal basis (GDPR Art. 6) | Where stored | Retention |
|---|---|---|---|---|---|---|
| 1 | Parent account | Parents | Firebase UID, email, sign-in provider (Apple/Google/password) | Provide the service; contract (6(1)(b)) | Firebase Auth, Firestore `users/{uid}` | Until account deletion (`deleteAccount`) |
| 2 | Child profile and routines | Children (via parent) | First name, birth date/age, questionnaire answers, wake-up/bedtime, routines, stars, trophies | Build and personalize routines; contract with the parent (6(1)(b)); parent consent for the child (Art. 8) | Firestore `users/{uid}` + subcollections, device AsyncStorage | Until account deletion |
| 3 | Spoken greeting (TTS) | Children | First name only (not linked to an account) | Personalized greeting; contract (6(1)(b)) | Google Vertex AI (Gemini TTS) → Cloud Storage `audio/`, Firestore `audio_cache` (shared by name) | Cache TTL |
| 4 | Subscriptions and payments | Parents | UID, Paddle customer/transaction ids, subscription status; card data held by Paddle only | Sell and unlock subscriptions; contract (6(1)(b)), legal obligation for tax records (6(1)(c)) | Paddle, RevenueCat, Firestore `billing_customers` | Account deletion: our copy, plus the RevenueCat customer (`deleteAccount` → `deleteRevenueCatCustomer`, best effort, failures logged for manual deletion). Paddle keeps its own records as merchant of record (independent controller for tax) |
| 5 | Website analytics | Website visitors | Firebase UID (signed-in), GA cookie id, pages, entry source, funnel events, coarse geo/device | Measure the funnel; consent (6(1)(a)) via opt-in banner | GA4, BigQuery `analytics_539565663`, `web_reporting` views | GA 2 months; BigQuery tables expire after 26 months; erased ~5 days after account deletion (`processAnalyticsDeletions`) |
| 6 | Early-access email list | Prospective customers | Email, consent record, unsubscribe token | Launch updates; consent (6(1)(a)) | Firestore `early_access` | Until unsubscribe (then only a hash for suppression) |
| 7 | Partner (affiliate) program | Partners; referred families | Partner name, account email, payout method/email, clicks; family UID ↔ partner code; commission ledger | Run the program and pay commissions; contract (6(1)(b)), legal obligation for accounting (6(1)(c)) | Firestore `affiliates`, `affiliate_*` | Attribution: until account deletion; ledger/payouts: as required for accounting |
| 8 | Parent lock | Parents | PIN as salted SHA-256, lock method | Keep children out of purchases/settings; contract (6(1)(b)) | Device SecureStore, Firestore `users/{uid}.parentalLock` | Until account deletion |
| 9 | Security and abuse prevention | All users | Paddle webhook event ids, function logs | Legitimate interest (6(1)(f)) | Firestore `paddle_events`, Cloud Logging | `paddle_events` 90 days; logs per Cloud Logging retention |

## Processors and independent controllers

| Provider | Role | Data | Country | Transfer mechanism | Terms to accept/keep |
|---|---|---|---|---|---|
| Google (Firebase, Cloud Functions, Firestore, Storage, Vertex AI, BigQuery) | Processor | 1–9 | US | EU-U.S. DPF (+ UK/Swiss) and SCCs | Cloud Data Processing Addendum ✅ accepted 2026-11-27 (EU/UK/Swiss law applies certified) |
| Google Analytics 4 | Processor | 5 | US | DPF and SCCs | GA Data Processing Terms ✅ accepted 2026-11-27 |
| RevenueCat | Processor | 4 (UID, entitlement, receipts) | US | SCCs in DPA (check DPF listing) | [RevenueCat DPA](https://www.revenuecat.com/dpa) ✅ incorporated in RevenueCat's terms (no signature); PDF saved 2026-11-27 |
| Paddle | Merchant of record (independent controller for payments) | 4 | UK (adequate for the EU) | UK adequacy; SCCs/UK IDTA for onward transfers | Paddle terms + [Data Sharing Addendum](https://www.paddle.com/legal/data-sharing-addendum) (controller-to-controller, SCCs/UK Addendum in Annexes 2–3) ✅ incorporated in Paddle's terms (no signature); PDF saved 2026-11-27 |
| Apple App Store, Google Play | Independent controllers | 4 (store purchases), sign-in | US | Their own terms | — |
| Email provider (not chosen) | Processor | 6 | — | — | Add a row before the first email |

HeyGen and the offline Gemini renders process only scripted narration (no personal data), so they aren't listed.

## Security measures (summary)

Firebase Auth on every callable; Firestore/Storage rules deny clients on server-only collections
(`billing_customers`, `affiliate_*`, `early_access`, `paddle_events`); no secrets in clients (Secret Manager);
PIN stored only as a salted hash; analytics never receives names, emails or child birth date/gender;
account deletion removes `users/{uid}` recursively, revokes Apple sign-in, cancels Paddle billing and
queues the account's GA4 and BigQuery analytics for erasure (`analytics_deletions/{uid}`).
Website: fonts and store badges are self-hosted, so no third party receives a visitor's IP before consent
(Paddle.js loads only when a parent opens checkout). DPIA: `docs/DPIA.md`.

## Personal data breach procedure (Art. 33/34)

1. **Contain** (revoke keys in Secret Manager, tighten rules, disable the function) and note the time you became aware.
2. **Assess** what data, whose (children?), how many, and the risk to them. Log every breach in a private
   incident note, even ones that don't need reporting.
3. **Notify the regulator within 72 hours** of awareness unless the risk is unlikely: an EU/UK lead
   authority (or the representative, once appointed) for EU/UK users; the Israeli Privacy Protection
   Authority as required by Israeli law.
4. **Tell affected parents without undue delay** if the risk is high (e.g. child data exposed), in plain language.
5. Processors (Google, RevenueCat, Paddle) must notify us without undue delay under their DPAs.
