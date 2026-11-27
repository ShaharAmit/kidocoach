# Data protection impact assessment (GDPR / UK GDPR Art. 35, UK Children's Code)

Internal. Required because the app is used by children (ICO: services likely to be accessed by children).
Review it whenever a new data field, provider or feature that touches child data is added. Last reviewed:
2026-11-11. Not legal advice. Processing details: `docs/RECORD_OF_PROCESSING.md`.

## 1. What and why

A parent sets up routines for a child aged 2–12. The child watches pre-rendered avatar videos that greet them
by first name. The parent holds the account; the child never signs in, types or uploads anything.

- **Child data:** first name, birth date/age, questionnaire answers, wake-up/bedtime, routines, stars.
- **Necessity:** the first name is the product's personalization; age picks age-appropriate activities;
  the schedule drives reminders. Nothing else is collected about the child.
- **Gender** is not collected (removed under data minimisation, Art. 5(1)(c)). The profile parser ignores a
  `gender` field left by older builds; it is dropped the next time the profile is saved.

## 2. Risks and measures

| Risk | Likelihood / severity | Measures | Residual |
|---|---|---|---|
| Child data exposed through a breach | Low / medium | Firestore rules scope `users/{uid}` to its owner; server-only collections deny clients; no secrets in clients; Firebase Auth on every callable | Low |
| A child changes settings, buys or leaves the app | Medium / medium | Parental gate (PIN or math, no bypass) on settings, purchases, restores and outside links (ADR-011) | Low |
| Child data used for profiling or ads | Low / high | No ads, no ad SDKs, no analytics in the app; website analytics is opt-in, parent-only and never receives names, birth date or gender (age band only) | Low |
| The first name leaves our systems for TTS | Certain / low | Sent only to Google Vertex AI (processor, DPA); the audio is keyed by name, not account, shared across children and deleted after a year without use | Low |
| Data kept longer than needed | Medium / low | Account deletion removes `users/{uid}` recursively; TTLs on `audio_cache`, `paddle_events`, `rate_limits`; BigQuery tables expire after 26 months; GA 2 months | Low |
| International transfer to the US | Certain / low | DPF + SCCs (Google), SCCs (RevenueCat), UK adequacy (Paddle) | Low |
| Nudging the child to share more or stay longer | Low / medium | No social features, chat, location, camera or microphone; rewards are stars for finishing routines, not for time in the app | Low |
| Parent not informed | Low / medium | Privacy policy covers child data, legal bases, retention and a kids' section; linked from the paywall and Settings | Low |

## 3. UK Children's Code standards (summary)

Best interests ✅ (routines, no ads) · DPIA ✅ (this file) · Age-appropriate application ✅ (parent-run, ages 2–12) ·
Transparency ✅ (policy + kids' section) · Detrimental use ✅ (no engagement loops beyond routine stars) ·
Policies ✅ · Default settings ✅ (no tracking in the app) · Data minimisation ✅ · Data sharing ✅ (processors only) ·
Geolocation ✅ (none) · Parental controls ✅ (parent sets up; child isn't monitored beyond routine completion) ·
Profiling ✅ (routine composition only, core service, parent can change) · Nudge techniques ✅ ·
Connected toys/devices n/a · Online tools ✅ (account deletion in Profile, email for other rights).

## 4. Conclusion

Residual risk is low; no prior consultation with a regulator is needed. Re-run this assessment before adding
in-app analytics, voice/camera input, social features, or new third parties that receive child data.
