#!/usr/bin/env bash
# Registers the website's GA4 custom dimensions (docs/WEB_ANALYTICS.md §3). Idempotent: existing
# parameters are skipped. Impersonates the Cloud Functions runtime service account, which needs the
# GA4 Editor role (also used by processAnalyticsDeletions). Override with GA_ADMIN_SERVICE_ACCOUNT or GA_ACCESS_TOKEN.
set -euo pipefail

PROPERTY="${GA4_PROPERTY_ID:-539565663}"
SA="${GA_ADMIN_SERVICE_ACCOUNT:-855034430252-compute@developer.gserviceaccount.com}"
API="https://analyticsadmin.googleapis.com/v1beta/properties/$PROPERTY/customDimensions"

EVENT_PARAMS=(entry_type affiliate_code coupon_code method via_partner_link status step_name
  child_age_band motivation_style help_level morning_speed)
USER_PROPS=(first_partner_code has_child_profile subscriber subscription_store signup_method)

TOKEN="${GA_ACCESS_TOKEN:-$(gcloud auth print-access-token --impersonate-service-account="$SA" \
  --scopes=https://www.googleapis.com/auth/analytics.edit 2>/dev/null)}"
AUTH=(-H "Authorization: Bearer $TOKEN")

if ! list="$(curl -fsS "${AUTH[@]}" "$API?pageSize=200")"; then
  echo "No GA4 access. In GA4 Admin → Property access management, add $SA as Editor, then rerun." >&2
  exit 1
fi
existing="$(python3 -c '
import json, sys
for d in json.load(sys.stdin).get("customDimensions", []):
    print(d["scope"] + ":" + d["parameterName"])' <<<"$list")"

create() { # scope parameterName
  if grep -qx "$1:$2" <<<"$existing"; then echo "exists   $1 $2"; return; fi
  curl -fsS "${AUTH[@]}" -H 'Content-Type: application/json' -X POST "$API" \
    -d "{\"parameterName\":\"$2\",\"displayName\":\"$2\",\"scope\":\"$1\"}" >/dev/null
  echo "created  $1 $2"
}

for p in "${EVENT_PARAMS[@]}"; do create EVENT "$p"; done
for p in "${USER_PROPS[@]}"; do create USER "$p"; done
