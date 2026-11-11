-- Saved BigQuery views for the website funnel (docs/WEB_ANALYTICS.md §3).
-- Apply with: scripts/bigquery-views.sh   (dataset `web_reporting`, location US, same as the GA4 export)
-- Views cost nothing until queried. Every view reads at most the last 400 days of `events_*`, and
-- `web_events.table_suffix` lets callers prune further (WHERE table_suffix >= '20261101').
-- GA only sees visitors who accepted analytics; use Firestore for absolute counts.

-- One row per event, with the documented parameters flattened.
CREATE OR REPLACE VIEW `kids-routine-coach-app.web_reporting.web_events` AS
WITH src AS (
  SELECT _TABLE_SUFFIX AS table_suffix, *
  FROM `kids-routine-coach-app.analytics_539565663.events_*`
  WHERE _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 400 DAY))
)
SELECT
  table_suffix,
  PARSE_DATE('%Y%m%d', event_date) AS event_date,
  TIMESTAMP_MICROS(event_timestamp) AS event_time,
  event_name,
  user_id,
  user_pseudo_id,
  geo.country AS country,
  device.category AS device_category,
  (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS ga_session_id,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_path') AS page_path,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'entry_type') AS entry_type,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'landing_path') AS landing_path,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'affiliate_code') AS affiliate_code,
  (SELECT value.string_value FROM UNNEST(event_params)
     WHERE key IN ('coupon_code', 'coupon') AND value.string_value IS NOT NULL LIMIT 1) AS coupon_code,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'utm_source') AS utm_source,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'utm_medium') AS utm_medium,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'utm_campaign') AS utm_campaign,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'referrer_host') AS referrer_host,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'method') AS signup_method,
  COALESCE((SELECT LOWER(COALESCE(value.string_value, CAST(value.int_value AS STRING)))
     FROM UNNEST(event_params) WHERE key = 'via_partner_link') IN ('true', '1'), FALSE) AS via_partner_link,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'status') AS status,
  (SELECT COALESCE(value.int_value, SAFE_CAST(value.string_value AS INT64))
     FROM UNNEST(event_params) WHERE key = 'step_number') AS step_number,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'step_name') AS step_name,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'child_age_band') AS child_age_band,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'stuck_points') AS stuck_points,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'motivation_style') AS motivation_style,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'mastered_tasks') AS mastered_tasks,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'help_level') AS help_level,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'morning_speed') AS morning_speed,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'plan_interval') AS plan_interval,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'transaction_id') AS transaction_id,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'currency') AS currency,
  (SELECT COALESCE(value.double_value, CAST(value.int_value AS FLOAT64))
     FROM UNNEST(event_params) WHERE key = 'value') AS value
FROM src;

-- Daily entries by source ("enter", "enter with link").
CREATE OR REPLACE VIEW `kids-routine-coach-app.web_reporting.web_entries_daily` AS
SELECT
  event_date,
  entry_type,
  affiliate_code,
  coupon_code,
  utm_source,
  utm_campaign,
  COUNT(*) AS entries,
  COUNT(DISTINCT user_pseudo_id) AS browsers
FROM `kids-routine-coach-app.web_reporting.web_events`
WHERE event_name = 'site_entry'
GROUP BY 1, 2, 3, 4, 5, 6;

-- Registrations ("registration", "registration with link").
CREATE OR REPLACE VIEW `kids-routine-coach-app.web_reporting.web_registrations` AS
SELECT
  event_date,
  event_time,
  user_id,
  user_pseudo_id,
  signup_method,
  via_partner_link,
  affiliate_code
FROM `kids-routine-coach-app.web_reporting.web_events`
WHERE event_name = 'sign_up';

-- Questionnaire completions per user (latest completion wins).
CREATE OR REPLACE VIEW `kids-routine-coach-app.web_reporting.web_questionnaire_completions` AS
SELECT * EXCEPT (rn)
FROM (
  SELECT
    user_id,
    event_time AS completed_at,
    child_age_band,
    stuck_points,
    motivation_style,
    mastered_tasks,
    help_level,
    morning_speed,
    ROW_NUMBER() OVER (PARTITION BY COALESCE(user_id, user_pseudo_id) ORDER BY event_time DESC) AS rn
  FROM `kids-routine-coach-app.web_reporting.web_events`
  WHERE event_name = 'questionnaire_complete'
)
WHERE rn = 1;

-- Per-browser funnel: first entry source → sign-up → questionnaire → checkout → purchase.
CREATE OR REPLACE VIEW `kids-routine-coach-app.web_reporting.web_funnel_browsers` AS
WITH first_entry AS (
  SELECT * EXCEPT (rn)
  FROM (
    SELECT
      user_pseudo_id,
      event_date AS first_entry_date,
      entry_type,
      affiliate_code,
      coupon_code,
      utm_source,
      utm_campaign,
      ROW_NUMBER() OVER (PARTITION BY user_pseudo_id ORDER BY event_time) AS rn
    FROM `kids-routine-coach-app.web_reporting.web_events`
    WHERE event_name = 'site_entry'
  )
  WHERE rn = 1
),
steps AS (
  SELECT
    user_pseudo_id,
    MIN(event_date) AS first_seen_date,
    ANY_VALUE(user_id HAVING MAX IF(user_id IS NULL, 0, UNIX_MICROS(event_time))) AS user_id,
    LOGICAL_OR(event_name = 'sign_up') AS signed_up,
    LOGICAL_OR(event_name = 'sign_up' AND via_partner_link) AS signed_up_with_link,
    LOGICAL_OR(event_name = 'referral_claim' AND status = 'claimed') AS referral_claimed,
    LOGICAL_OR(event_name = 'questionnaire_start') AS questionnaire_started,
    LOGICAL_OR(event_name = 'questionnaire_complete') AS questionnaire_completed,
    LOGICAL_OR(event_name = 'begin_checkout') AS began_checkout,
    LOGICAL_OR(event_name = 'purchase') AS purchased
  FROM `kids-routine-coach-app.web_reporting.web_events`
  GROUP BY user_pseudo_id
)
SELECT
  s.user_pseudo_id,
  s.user_id,
  COALESCE(f.first_entry_date, s.first_seen_date) AS first_entry_date,
  COALESCE(f.entry_type, 'unknown') AS entry_type,
  f.affiliate_code,
  f.coupon_code,
  f.utm_source,
  f.utm_campaign,
  s.signed_up,
  s.signed_up_with_link,
  s.referral_claimed,
  s.questionnaire_started,
  s.questionnaire_completed,
  s.began_checkout,
  s.purchased
FROM steps s
LEFT JOIN first_entry f USING (user_pseudo_id);

-- Funnel totals per week and first-entry source (the Looker Studio main table).
CREATE OR REPLACE VIEW `kids-routine-coach-app.web_reporting.web_funnel_weekly` AS
SELECT
  DATE_TRUNC(first_entry_date, WEEK(MONDAY)) AS week,
  entry_type,
  affiliate_code,
  coupon_code,
  COUNT(*) AS browsers,
  COUNTIF(signed_up) AS signed_up,
  COUNTIF(signed_up_with_link) AS signed_up_with_link,
  COUNTIF(referral_claimed) AS referral_claimed,
  COUNTIF(questionnaire_started) AS questionnaire_started,
  COUNTIF(questionnaire_completed) AS questionnaire_completed,
  COUNTIF(began_checkout) AS began_checkout,
  COUNTIF(purchased) AS purchased
FROM `kids-routine-coach-app.web_reporting.web_funnel_browsers`
GROUP BY 1, 2, 3, 4;
