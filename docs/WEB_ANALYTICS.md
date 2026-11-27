# Website analytics (Firebase Analytics / GA4)

What the website (`kidocoach.app`) tracks, why, and the rules that keep it lawful in the
**US, Canada, Australia, the EU/EEA and the UK**. The mobile app is not covered here.

- Code: `website/src/services/analytics.ts` (consent, SDK), `website/src/services/analyticsEvents.ts`
  (pure parameter builders), `website/src/components/ConsentBanner.tsx`.
- Property: Firebase web app `1:855034430252:web:e635b42564857a30276289`, measurement ID
  `G-0FTH9R3J1D` (`VITE_GA_MEASUREMENT_ID`, also passed as Firebase `measurementId`).
- Tests: `tests/webAnalytics.test.cjs`.

**Rule for every new event:** add it to the tables below in the same PR, use only the parameter
types listed under [What we never send](#what-we-never-send), and keep names `snake_case`,
≤ 40 characters, ≤ 25 parameters, values ≤ 100 characters (GA4 limits).

---

## 1. Consent model (how it's legal)

Analytics is **opt-in for every visitor, everywhere**. One global rule, stricter than US/AU require
and equal to what the EU, the UK and Quebec require. We can't reliably detect a visitor's region in
the browser, so we don't try to.

| Situation | Behaviour |
|---|---|
| First visit, no choice yet | Banner shown (Accept / Reject, same size and style). **No GA script, no cookies, no network calls.** Events from this page view are kept **in memory only** (max 50). |
| Accept | Choice saved in `localStorage` (`kidocoach_analytics_consent_v1`). Firebase Analytics loads and the in-memory events are sent. A partner link from this visit is saved for 60 days (§7). |
| Reject, or the tab is closed without a choice | In-memory events are discarded. Nothing was ever sent. A partner link is kept only for this visit. |
| Browser sends **Global Privacy Control** (`navigator.globalPrivacyControl`) | Treated as Reject; no banner. The visitor can still opt in via "Privacy choices". |
| "Privacy choices" (Home menu, Profile/Partners footers) | Reopens the banner. Reject after Accept turns collection off (`setAnalyticsCollectionEnabled(false)`, consent `denied`) and deletes the `_ga*` cookies and the saved partner link. |

Google Consent Mode values set on load: `analytics_storage: granted` (only after Accept);
`ad_storage`, `ad_user_data`, `ad_personalization`, `personalization_storage`: **denied**.
`allow_google_signals: false`, `allow_ad_personalization_signals: false`. We do no advertising,
remarketing or cross-site tracking.

### Per-region status

| Region | Law | What it requires for analytics | Our status |
|---|---|---|---|
| EU/EEA | GDPR + ePrivacy Directive (cookie rules) | Prior, informed, freely given opt-in before non-essential cookies; reject as easy as accept; withdrawable; disclosed in the privacy policy; DPA with the processor | ✅ Opt-in banner, equal Reject, Privacy choices link, privacy policy §4 (`/privacy#analytics`). ⚠️ Admin: accept Google's Data Processing Terms (admin checklist, §5 below). |
| UK | UK GDPR + PECR | Same as EU | ✅ Same as EU. |
| Canada | PIPEDA; **Quebec Law 25** | PIPEDA: meaningful consent and notice. Quebec: tracking/profiling tech **off by default**, opt-in | ✅ Opt-in everywhere covers Quebec. |
| US | CCPA/CPRA (CA) and other state laws (VA, CO, CT, …); COPPA | Notice at collection; honor opt-out incl. **GPC**; no "sale/sharing" for ads without opt-out. COPPA: no data from children under 13 | ✅ Notice in banner + policy, GPC honored, no ads/sharing. ✅ Website is for parents; no child-directed pages. We never send child name, birth date or gender. |
| Australia | Privacy Act 1988 (APPs) | Collection notice, privacy policy, use limited to the stated purpose | ✅ Banner + policy §4. |

### What we never send

- Emails, names (parent or child), phone numbers, payout details, passwords, free text.
- Child **birth date, exact age or gender**: only an age band (`2-3`, `4-5`, `6-8`, `9-12`).
- Full URLs: the page URL sent with every hit (GA `dl`/`page_location`) keeps only `ref`, `coupon`,
  `discount_code` and `utm_*`; the referrer (GA `dr`) keeps only its origin, and `site_entry.referrer_host` only the host.
  Verified in a browser: `?email=` never reaches Google.
- Payment details. `transaction_id` is the Paddle `txn_` id (not personal on its own).

**User ID:** the Firebase Auth UID, set only for signed-in (non-anonymous) parents and only
after consent. It is pseudonymous personal data under GDPR, which is why collection is opt-in. It
lets BigQuery join web events to Firestore `users/{uid}`, `affiliate_attributions/{uid}`, etc.
Google's terms forbid sending PII to GA; the UID is allowed.

### Related (see §6–§8)

- The same banner also covers remembering a partner link on the device (§7). Coupon links don't need consent.
- Early-access emails: consent wording, proof of consent, confirm and unsubscribe links (§6).
- Have a lawyer review the privacy policy before launch. This document is not legal advice.

---

## 2. Events

All events are custom GA4 events unless marked *(GA4 recommended)*. Recommended names light up
GA4's built-in reports (e.g. `sign_up`, `purchase`).

### Acquisition — "enter", "enter with link", "link"

| Event | When | Parameters |
|---|---|---|
| `page_view` *(GA4 recommended)* | Every route change | `page_path` (path + allowed query only), `page_location`, `page_title` |
| `site_entry` | First page of a browser-tab session (deduped with `sessionStorage`) | `entry_type` = `partner_link` \| `coupon_link` \| `campaign` \| `referral_site` \| `direct`; `landing_path`; `affiliate_code`; `coupon_code`; `utm_source`; `utm_medium`; `utm_campaign`; `referrer_host` |
| `partner_link_open` | Any page opened with `?ref=` (every time, not deduped) | `affiliate_code`, `first_touch` (bool: false when another partner is already saved in this browser or remembered in this visit), `landing_path` |
| `coupon_link_open` | Any page opened with `?coupon=` / `?discount_code=` | `coupon_code`, `landing_path` |

"Enter" = `site_entry`. "Enter with link" = `site_entry` where `entry_type = 'partner_link'`.
"Link" = `partner_link_open`. GA4 also records `session_start` / `first_visit` automatically.

### Account — "registration", "registration with link"

| Event | When | Parameters |
|---|---|---|
| `sign_up` *(GA4 recommended)* | A **new** account was created (email, Google or Apple) | `method` = `password` \| `google` \| `apple`; `via_partner_link` (bool); `affiliate_code` |
| `login` *(GA4 recommended)* | Existing account signed in | same as `sign_up` |
| `referral_claim` | Server answered the partner-link claim after sign-in | `status` = `claimed` \| `already_attributed` \| `invalid_code` \| `unknown_code` \| `inactive` \| `self_referral` \| `existing_customer`; `affiliate_code` |

"Registration with link" = `sign_up` where `via_partner_link = true` (the browser had a saved
partner link). The binding answer is the server's: `referral_claim.status = 'claimed'`, or the
Firestore doc `affiliate_attributions/{uid}`.

### Questionnaire — "questionnaire fill-out, and by which user"

| Event | When | Parameters |
|---|---|---|
| `questionnaire_start` | Step 1 shown | `step_number` = 1, `step_name` = `child` |
| `questionnaire_step` | Each later step shown (incl. Back) | `step_number` 2–7, `step_name` = `stuck_points` \| `motivation` \| `mastered_tasks` \| `help_level` \| `morning_speed` \| `schedule` |
| `questionnaire_complete` | Setup saved to Firestore | `child_age_band`, `stuck_points` (sorted, comma-joined), `motivation_style`, `mastered_tasks`, `help_level`, `morning_speed`, `wake_time`, `bedtime` |
| `questionnaire_error` | Saving failed | `step_name` |

"Which user" = the event's `user_id` (Firebase UID), always set because the questionnaire is shown
only to signed-in parents.

### Checkout

| Event | When | Parameters |
|---|---|---|
| `begin_checkout` *(GA4 recommended)* | Parent picks a plan | `currency`, `value` (charged today; 0 on a free trial), `coupon`, `plan_interval`, `trial_days`, `items[{item_id: Paddle price id, item_name, price, quantity}]` |
| `checkout_closed` | Paddle overlay closed without paying | `currency`, `value`, `coupon` |
| `purchase` *(GA4 recommended)* | Paddle reported `checkout.completed` | everything in `begin_checkout` + `transaction_id` (Paddle `txn_`) |

GA revenue is indicative (list price, before tax/discount, consented visitors only). Paddle and
`affiliate_commissions` are the source of truth for money.

### Partners & early access

| Event | When | Parameters |
|---|---|---|
| `partner_join` | Partner sign-up form submitted | `status` (server join status, e.g. `created`) |
| `early_access_modal_open` | Early-access modal opened | `source` |
| `early_access_modal_close` | Modal closed | — |
| `early_access_submit_attempt` / `_success` / `_exists` / `_error` / `_invalid_email` | Early-access form outcomes | — (the email is never sent) |

### User properties (stick to the user on every later event)

| Property | Values | Set when |
|---|---|---|
| `signup_method` | `password` \| `google` \| `apple` | `sign_up` |
| `first_partner_code` | partner code | `referral_claim` with `status = claimed` (server-confirmed first touch) |
| `has_child_profile` | `yes` \| `no` | Profile loads / questionnaire saved |
| `subscriber` | `yes` \| `no` | Billing status loads |
| `subscription_store` | `paddle`, `app_store`, `play_store`, … , `none` | Billing status loads |

Sign-out clears the user ID and these properties.

---

## 3. Will this support dashboards (BigQuery etc.)? Yes — with two caveats

1. **GA only sees visitors who accepted.** Expect EU acceptance well below 100%. Use GA for rates
   and funnels (entry → sign-up → questionnaire → purchase, by `entry_type` / `affiliate_code`),
   and **Firestore for absolute counts**, because it records every account regardless of consent:
   `users/{uid}.childProfile` (questionnaire done), `affiliate_attributions`, `affiliate_clicks`,
   `affiliate_commissions`, `billing_customers`.
2. **Register custom dimensions in GA4** (Admin → Custom definitions) to see custom parameters in the
   GA4 UI: event-scoped `entry_type`, `affiliate_code`, `coupon_code`, `method`, `via_partner_link`,
   `status`, `step_name`, `child_age_band`, `motivation_style`, `help_level`, `morning_speed`;
   user-scoped `first_partner_code`, `has_child_profile`, `subscriber`, `signup_method`.
   **BigQuery doesn't need this**: the export contains every parameter raw.

### One-time setup

1. **GA4 → BigQuery export:** Firebase console → Project settings → Integrations → BigQuery →
   Link, enable *Google Analytics* (or GA4 Admin → BigQuery links). Pick **Daily** (free up to 1M
   events/day) and, if you want same-day dashboards, **Streaming** (paid). Data lands in
   `analytics_<property_id>.events_YYYYMMDD`. Choose an EU or US dataset location once; it can't change.
   Export starts from the day you link, with no backfill, so **link before launch**.
2. **Firestore → BigQuery:** install the *Stream Firestore to BigQuery* extension for `users`,
   `affiliate_attributions`, `affiliate_commissions` (server-side truth, joined by UID).
3. **Dashboards:** Looker Studio (free) on the BigQuery tables, or GA4 Explorations.

### Saved views (`kids-routine-coach-app.web_reporting`, location US)

SQL in `analytics/bigquery/views.sql`; apply or update with `scripts/bigquery-views.sh` (idempotent).
Views read at most the last 400 days of the export; filter `web_events.table_suffix` to scan less.

| View | One row per | Use |
|---|---|---|
| `web_events` | event | Flattened §2 parameters (`entry_type`, `affiliate_code`, `coupon_code`, `signup_method`, `via_partner_link`, questionnaire answers, `value`…) |
| `web_entries_daily` | day × source | Entries and browsers by `entry_type` / partner / coupon / UTM |
| `web_registrations` | `sign_up` event | Registrations with/without a partner link |
| `web_questionnaire_completions` | user | Latest questionnaire answers per `user_id` |
| `web_funnel_browsers` | browser (`user_pseudo_id`) | First entry source + reached sign-up / questionnaire / checkout / purchase |
| `web_funnel_weekly` | week × first-entry source | Funnel counts; the Looker Studio main table |

**Looker Studio:** Create → Data source → BigQuery → `kids-routine-coach-app` → `web_reporting` →
`web_funnel_weekly` (and `web_entries_daily`). Add a table/bar chart of `browsers → signed_up →
questionnaire_completed → purchased` broken down by `entry_type` and `affiliate_code`, with a `week` date range control.

### Example queries

```sql
-- Daily entries by type, and how many came through partner links
SELECT event_date,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'entry_type') AS entry_type,
  COUNT(*) AS entries
FROM `kids-routine-coach-app.analytics_539565663.events_*`
WHERE event_name = 'site_entry'
GROUP BY 1, 2 ORDER BY 1;

-- Registrations with vs without a partner link, by partner
SELECT
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'affiliate_code') AS partner,
  COUNT(*) AS sign_ups
FROM `kids-routine-coach-app.analytics_539565663.events_*`
WHERE event_name = 'sign_up'
GROUP BY 1;

-- Which users completed the questionnaire, and their answers
SELECT user_id, TIMESTAMP_MICROS(event_timestamp) AS completed_at,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'child_age_band') AS age_band,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'stuck_points') AS stuck_points
FROM `kids-routine-coach-app.analytics_539565663.events_*`
WHERE event_name = 'questionnaire_complete';

-- Funnel per user: entered → signed up → questionnaire → purchased
SELECT COUNT(DISTINCT user_pseudo_id) AS visitors,
  COUNT(DISTINCT IF(event_name = 'sign_up', user_pseudo_id, NULL)) AS signed_up,
  COUNT(DISTINCT IF(event_name = 'questionnaire_complete', user_pseudo_id, NULL)) AS questionnaire,
  COUNT(DISTINCT IF(event_name = 'purchase', user_pseudo_id, NULL)) AS purchased
FROM `kids-routine-coach-app.analytics_539565663.events_*`;
```

---

## 4. Known limits

- Events before Accept are kept only for the current page view. Pages visited before a later
  Accept in another visit are not recovered (by design).
- Ad blockers / Safari ITP block or shorten GA; Firestore counts are unaffected.
- `site_entry` is per browser-tab session, not per GA session. Use GA4 `session_start` with
  `session_traffic_source` for GA's own session attribution.
- Native app purchases and app activity are not in web analytics.

## 5. GA4 / Firebase admin checklist (before launch)

- [x] GA4 Admin → Account settings: accept the **Data Processing Terms** (2026-11-27) (GDPR) and fill in DPO / EU representative contacts if applicable.
- [ ] Data collection: **Google signals OFF**; *Granular location and device data* OFF for EU regions (or all).
- [x] Data retention: **2 months** (data minimisation; limits only Explorations, standard aggregated reports keep history; long-range funnels come from BigQuery, 26 months). Verified 2026-11-27.
- [ ] Data sharing settings: turn off everything except "Technical support".
- [x] Do **not** link Google Ads / ad platforms (verified none, 2026-11-27).
- [ ] Register the custom dimensions in §3.
- [x] Link BigQuery (§3) before launch (2026-11-08, daily, region `us`).
- [ ] Data deletion: honor "delete my data" requests with GA4 *Data deletion requests* (by user ID) and BigQuery `DELETE … WHERE user_id = …`.

### International transfers (EU/UK users, US servers)

US hosting is lawful under GDPR Chapter V when a transfer mechanism applies. Firestore, Functions, GA4,
BigQuery, Paddle and RevenueCat are all US-based. Our safeguards:

- **EU-U.S. Data Privacy Framework** (+ UK Extension, Swiss DPF) for certified providers (Google is
  certified). The EU General Court upheld the DPF in *Latombe v Commission* (Sept 2025); an appeal to the
  CJEU is possible.
- **Standard Contractual Clauses** in each provider's data processing terms, which still apply if the DPF falls.
- [x] Accept the Google Cloud/Firebase **Data Processing and Security Terms** (Cloud console → IAM & Admin →
  Legal & compliance) (2026-11-27).
- [x] Accept the GA4 Data Processing Terms (above) (2026-11-27).
- [x] Accept or sign the Paddle and RevenueCat DPAs (incorporated in their terms; PDFs saved 2026-11-27).
- [x] Keep a record of processing listing each processor, its country and its transfer mechanism
  (`docs/RECORD_OF_PROCESSING.md`, 2026-11-11).
- [x] Privacy policy §3 discloses the US transfer and the safeguards (2026-11-01).
- Children: the app stores a child's first name and age. Under GDPR Art. 8 the parent (an adult) gives consent
  and holds the account; keep the child data minimal, as it is today.
- **EU/UK representative (GDPR / UK GDPR Art. 27).** Required for a business with no EU/UK establishment
  that offers its service to people there (Art. 3(2)(a)) or monitors them, e.g. analytics (Art. 3(2)(b)).
  - Server location doesn't matter: EU hosting or an EU processor is not an "establishment" (EDPB
    Guidelines 3/2018), and Israel's adequacy decision covers transfers *to* Israel, not Art. 27. Asking
    for consent makes the analytics lawful; it doesn't remove Art. 27.
  - **Decision (2026-11):** launch without one while EU/UK use is occasional (the Art. 27(2) exemption;
    child data keeps it minimal). Once EU/UK families subscribe regularly, appoint a representative
    service (e.g. Prighter, EDPO, DataRep; no EU company needed) and add its contact to the privacy
    policy and GA4 Account settings, or stop selling to the EU/UK (storefronts + web checkout) and stop
    loading analytics there.
- Record of processing (GDPR Art. 30) and breach procedure: `docs/RECORD_OF_PROCESSING.md`. DPIA (Art. 35,
  UK Children's Code): `docs/DPIA.md`.
- No third-party requests before consent: fonts (`@fontsource`) and store badges (`website/public/badge-*.svg`)
  are self-hosted. Don't add Google Fonts, CDN images or embeds; self-host them or load them only after consent.

---

## 6. Email collection (early access / pre-registration)

**Stored:** Firestore `early_access/{sha256(email)}` (server-only) = `email`, `emailLower`, `emailHash`,
`source`, `createdAt`, `unsubscribeToken` (random, for the links in emails), `consent {version, purpose:
'launch_updates', method: 'signup_form'|'email_link', grantedAt}`, and optionally `confirmedAt`,
`resubscribedAt`, `unsubscribedAt`. Code: `functions/src/earlyAccess.ts` (callables) and
`functions/src/earlyAccessModel.ts` (rules, tested in `tests/earlyAccess.test.cjs`). The email is
**never** sent to analytics; `early_access_*` events carry nothing about the person.

**Consent wording** (under the form, `website/src/pages/Home.tsx`): *"By joining, you agree that KidoCoach
may email you launch updates and the launch-rate offer. Unsubscribe anytime with the link in every email.
Privacy Policy"*. If you change it, bump `EARLY_ACCESS_CONSENT_VERSION` in
`website/src/services/earlyAccess.ts` and add the old wording here. The confirm page has its own version
(`EARLY_ACCESS_CONFIRM_VERSION`).

| Version | Wording | Live from |
|---|---|---|
| (none) | Form without a consent line ("Enter your email to lock in early access updates and the launch-rate offer.") | before 2026-10-31 |
| `early_access_v1` | Form text above | 2026-10-31 (after the functions deploy) |
| `early_access_confirm_v1` | `/email-preferences?action=confirm`: "Yes, KidoCoach may email me launch updates and the launch-rate offer. I can unsubscribe anytime with the link in every email." | 2026-10-31 |
| `email_confirm` | Fallback stored if a confirm request arrives without a known version | — |

### How it works

- **Sign-up** (`submitEarlyAccessLead`): stores the email with the consent record and a token. Signing up
  again with the notice records fresh consent, which also re-subscribes an address that had unsubscribed
  or was collected before the notice.
- **Links in every email** (`/email-preferences?id={hash}&t={token}&action=confirm|unsubscribe`, page
  `website/src/pages/EmailPreferences.tsx`, callable `updateEarlyAccessPreference`). Acting takes one
  button press, so email link scanners can't confirm or unsubscribe by opening the link. The page is `noindex`, and
  the `id`/`t` parameters are stripped from analytics.
  - **confirm**: sets `confirmedAt` (double opt-in). For a lead with no consent record, it stores consent
    (`method: 'email_link'`). This is how legacy leads re-confirm.
  - **unsubscribe**: deletes the address and keeps only `{emailHash, unsubscribeToken, unsubscribedAt}`
    as a suppression record, so it's never imported again. Unknown ids and wrong tokens get the same
    `invalid` answer (no list membership leak).
- **Admin** (`cd functions && npm run early-access -- …`, `functions/scripts/early-access-admin.js`):
  - `stats`: totals, mailable, confirmed, needs re-confirm, unsubscribed.
  - `export --csv leads.csv`: mailable leads (consented, not unsubscribed) with `confirm_url` and
    `unsubscribe_url` columns for the email provider. Adds missing tokens and migrates pre-hash docs.
  - `export-reconfirm --csv old.csv`: leads from before the notice. Send them **one** re-confirm email only.
  - `unsubscribe <email>`: opt-outs that arrive by reply or from the email provider's own unsubscribe list.
  - `purge-unconfirmed --before YYYY-MM-DD [--yes]`: deletes legacy leads that never re-confirmed (dry run without `--yes`).
  - CSVs are written with mode 600, and `functions/*.csv` is git-ignored. Never commit or share them.

| Region | Law | Requirement | Status |
|---|---|---|---|
| EU/EEA, UK | GDPR + ePrivacy / PECR | Freely given, specific opt-in; proof of consent; easy withdrawal | ✅ Wording + stored version/time + confirm (double opt-in) + unsubscribe that deletes the address. |
| Canada | **CASL** (strictest) | Express consent stating purpose **and who is asking** with contact info; proof; unsubscribe honored within 10 business days | ✅ Purpose, proof, unsubscribe. ⚠️ Every email must identify KidoCoach with a **mailing address** and contact. |
| US | CAN-SPAM | Opt-out, no deceptive subject, **physical postal address**, unsubscribe honored within 10 business days | ✅ Unsubscribe. ✅ Postal address in the footer text (§6 step 4). |
| Australia | Spam Act 2003 | Consent, identify sender, functional unsubscribe (5 business days) | ✅ Consent + unsubscribe (instant). ✅ Sender identity in the footer text (§6 step 4). |

**Status (2026-10-31):** 2 leads, both collected before the notice (`needs_reconfirm`).

### Checklist before the first launch email

1. Deploy: `firebase deploy --only functions:submitEarlyAccessLead,functions:updateEarlyAccessPreference`
   and the website (`/email-preferences`).
2. Pick an email provider with a signed DPA (e.g. Resend, Postmark, Brevo, Mailchimp).
3. **Re-confirm legacy leads:** `npm run early-access -- export-reconfirm --csv old.csv` → send one email
   ("Still want KidoCoach launch updates? [Confirm]({confirm_url})", plus the footer below). Later run
   `purge-unconfirmed --before <date ~30 days after sending> --yes`.
4. **Launch emails:** `npm run early-access -- export --csv leads.csv` right before each send (it skips
   new unsubscribes). Footer of every email (sender identity + postal address, required by CAN-SPAM, Israel §30A
   and the Australian Spam Act): "KidoCoach · Liron David · Gai 5, Be'er Ya'akov, Israel ·
   privacy@kidocoach.app · [Unsubscribe]({unsubscribe_url})". Also set the `List-Unsubscribe` header.
5. Opt-outs in the provider (its own unsubscribe link, replies, complaints): run `unsubscribe <email>`
   within 5 business days, the strictest deadline (Australia).
6. Retention: after launch, delete leads that neither confirmed nor converted, e.g. after 12 months
   (`purge-unconfirmed` handles the no-consent ones), and state the period in the privacy policy.

---

## 7. Partner and coupon links: consent

| Storage | Purpose | Needs consent? |
|---|---|---|
| `kidocoach_campaign_v1` (coupon, 30 days, `localStorage`) | Applies the discount the visitor clicked for | **No (defensible).** It's strictly necessary for a service the user explicitly requested (ePrivacy exemption). Keep it disclosed in the privacy policy. |
| `kidocoach_referral_v1` (partner code, 60 days, `localStorage`) | Credits a partner with a commission | **EU/UK: yes.** EDPB Guidelines 2/2023 and CNIL treat affiliate tracking as not strictly necessary (US/CA/AU would only need disclosure). **We save it only after Accept, everywhere.** |
| `kidocoach_referral_click_v1` (click dedupe marker) | Partner click counts | Same as the partner code (in memory without consent). |
| Server-side claim `affiliate_attributions/{uid}` | Commission accounting | No ePrivacy issue (nothing on the device). GDPR basis: legitimate interest, disclosed in the policy. |

ePrivacy covers **storing on the device**. The server-side attribution after sign-in doesn't need the
cookie banner. So attribution works for everyone in the **same visit**, and consent is used only to
**remember** the partner across visits.

### Implemented: one banner, two purposes ("Option A", 2026-10-31)

- The banner says *"…analytics cookies … and we remember which partner link brought you here so the partner
  can be credited if you join later."* Accept covers both, and so does Reject. No extra UI.
- `website/src/services/referral.ts` keeps the link and the click dedupe marker **in memory**.
  `setReferralStorageAllowed()` follows the consent state (wired in `website/src/main.tsx` via
  `subscribeConsent`):
  - **No choice yet / Reject / GPC:** memory only. A saved link from earlier is moved into memory for this
    visit and erased from the device. Sign-in during the visit (popups, no reload) still calls
    `claimAffiliateReferral`, and checkout still sends the code.
  - **Accept** (now or later in the visit): the remembered link is saved for 60 days, first touch as before.
- Cost: a visitor who doesn't accept, leaves, and comes back later isn't credited. Partners are told in
  `/terms#partners`.
- Coupon links are unchanged (strictly necessary).
- Tests: `tests/affiliates.test.cjs` ("the partner link is saved on the device only with consent").

### Alternatives

- **Option B, granular toggles** (Analytics ☐ / Partner credit ☐): the most precise under the GDPR, but more UI
  and lower acceptance. Use it if a lawyer asks for per-purpose consent.
- **Option C, geo-based defaults:** opt-in only for EU/EEA/UK/CH (and Quebec), notice-only elsewhere.
  Needs the visitor's country before rendering (e.g. Cloudflare in front of Hosting with the
  `CF-IPCountry` header, or a tiny geo callable). Quebec can't be told apart from the rest of Canada by country,
  so treat all of Canada as opt-in. More data from the US/AU, but more moving parts and the risk of
  misdetection. The current "opt-in everywhere" is simpler and always compliant.
- **Server-side only:** add `?ref` to the Firebase sign-in flow instead of the device. That isn't possible
  with popup sign-in on a later visit, so it doesn't beat Option A.

---

## 8. BigQuery: does it cost?

At KidoCoach's scale it's **effectively free**, but it needs a billing account (the project is already on
Blaze for Cloud Functions). Without billing, the BigQuery **sandbox** deletes tables after 60 days.

| Item | Free | After that |
|---|---|---|
| GA4 → BigQuery **daily** export | Free (standard GA4: up to 1M events/day; above that the export pauses) | — |
| GA4 → BigQuery **streaming** (same-day) | — | BigQuery streaming inserts, about $0.01 per 200 MB; pennies at this scale |
| BigQuery storage | 10 GiB / month | ~$0.02 per GB-month (active), ~$0.01 (long-term, 90+ days unchanged) |
| BigQuery queries (on-demand) | 1 TiB scanned / month | ~$6.25 per TiB |
| Firestore → BigQuery extension | — | A Cloud Function run per document write + streaming inserts; cents/month at our volume |
| Looker Studio dashboards | Free | — |

**Rough estimate:** 10,000 visitors/month × ~15 events × ~1.5 KB ≈ **0.2 GB/month**. You'd need many years
of data, or a very large launch, to leave the free tier. Queries over a few GB are far below 1 TiB.

**Guardrails (set up 2026-10-31 on `kids-routine-coach-app`):**
1. ✅ Budget **"KidoCoach BigQuery"**: 40 ILS/month (the billing account is in ILS; about $10), BigQuery
   service only, email alerts at 50/90/100% actual and 100% forecasted. Edit in Cloud console →
   Billing → Budgets & alerts.
2. ✅ Custom quota **"Query usage per day" = 100 GiB** (Cloud Quotas preference `bigquery-query-usage-per-day`).
   Worst case is about $0.60/day once the free 1 TiB is used up. Raise it in IAM & Admin → Quotas if a query hits it.
3. Always filter by date in queries (`WHERE _TABLE_SUFFIX BETWEEN '20261101' AND '20261130'`) and
   avoid `SELECT *` on `events_*`.
4. Start with the **daily** export; turn on streaming only if dashboards must be same-day.
5. ✅ Retention: dataset `analytics_539565663` default table expiration **26 months** (set 2026-11-11, and on
   the existing tables), matching the privacy policy. Change both together.
5. Pick the dataset region once; it can't be changed later. We chose **`us`** (BigQuery multi-region) to match
   Firestore (`us-central1`), because BigQuery can't join tables across locations. GA4 already processes EU data
   in the US, and the export holds no names or emails, so EU storage adds little (see §5 *International transfers*).

**Status:**
1. ✅ GA4 → BigQuery linked (daily, region `us`, no streaming or advertising IDs). Dataset `analytics_539565663`
   has data from 2026-11-08.
2. ✅ Saved funnel views in dataset `web_reporting` (§3 *Saved views*).
3. Optional: the "Stream Firestore to BigQuery" extension for `users`, `affiliate_attributions`,
   `affiliate_commissions`. Don't export `early_access` (emails) or child profile fields to a broadly shared dataset.
4. Looker Studio dashboard on `web_reporting.web_funnel_weekly` (§3 *Saved views*).
