#!/usr/bin/env bash
# Creates/updates the website funnel views (analytics/bigquery/views.sql) in dataset `web_reporting`.
set -euo pipefail

PROJECT="kids-routine-coach-app"
DATASET="web_reporting"
SQL_FILE="$(cd "$(dirname "$0")/.." && pwd)/analytics/bigquery/views.sql"

if ! bq --project_id="$PROJECT" show --dataset "$PROJECT:$DATASET" >/dev/null 2>&1; then
  bq --project_id="$PROJECT" --location=US mk --dataset \
    --description "Saved website funnel views over the GA4 export (docs/WEB_ANALYTICS.md §3)" \
    "$PROJECT:$DATASET"
fi

bq --project_id="$PROJECT" --location=US query --use_legacy_sql=false --quiet < "$SQL_FILE"
echo "Views in $PROJECT:$DATASET:"
bq --project_id="$PROJECT" ls "$PROJECT:$DATASET"
