#!/bin/bash
set -eo pipefail

echo "🚀 Starting KidoCoach iOS Build & TestFlight Deploy..."

# Load .env variables
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Verify Apple credentials
if [ -z "$APPLE_KEY_ID" ] || [ -z "$APPLE_ISSUER_ID" ]; then
  echo "❌ Error: APPLE_KEY_ID or APPLE_ISSUER_ID not set in .env"
  exit 1
fi

mkdir -p build

echo "📦 1/3 Archiving iOS project..."
xcodebuild \
  -workspace ios/KidoCoach.xcworkspace \
  -scheme KidoCoach \
  -configuration Release \
  -archivePath build/KidoCoach.xcarchive \
  archive \
  -allowProvisioningUpdates \
  -quiet

echo "📱 2/3 Exporting .ipa package..."
xcodebuild \
  -exportArchive \
  -archivePath build/KidoCoach.xcarchive \
  -exportOptionsPlist ios/exportOptions.plist \
  -exportPath build \
  -allowProvisioningUpdates \
  -quiet

echo "☁️ 3/3 Uploading to TestFlight via Apple CLI..."
UPLOAD_LOG=$(mktemp)
xcrun altool --upload-app \
  -f build/KidoCoach.ipa \
  -t ios \
  --apiKey "$APPLE_KEY_ID" \
  --apiIssuer "$APPLE_ISSUER_ID" 2>&1 | tee "$UPLOAD_LOG"

DELIVERY_ID=$(grep -oE 'Delivery UUID: [0-9a-fA-F-]+' "$UPLOAD_LOG" | awk '{print $3}' | head -1)
rm -f "$UPLOAD_LOG"
if [ -z "$DELIVERY_ID" ]; then
  echo "❌ Upload did not return a Delivery UUID"
  exit 1
fi

# A successful upload can still be rejected during Apple's processing (e.g. ITMS-90683).
echo "⏳ Waiting for App Store Connect processing (delivery $DELIVERY_ID)..."
for _ in $(seq 1 40); do
  STATUS_OUTPUT=$(xcrun altool --build-status --delivery-id "$DELIVERY_ID" \
    --apiKey "$APPLE_KEY_ID" --apiIssuer "$APPLE_ISSUER_ID" 2>&1 || true)
  STATUS=$(echo "$STATUS_OUTPUT" | sed -nE 's/.*BUILD-STATUS: *([A-Z_]+).*/\1/p' | head -1)
  case "$STATUS" in
    FAILED|INVALID)
      echo "$STATUS_OUTPUT"
      echo "❌ App Store Connect rejected the build."
      exit 1
      ;;
    VALID|COMPLETE|COMPLETED|SUCCESS|PROCESSED)
      echo "🎉 Build processed by App Store Connect (status: $STATUS)."
      exit 0
      ;;
  esac
  echo "   status: ${STATUS:-unknown}, retrying in 30s..."
  sleep 30
done

echo "⚠️ Timed out waiting for processing; check App Store Connect (delivery $DELIVERY_ID)."
exit 1
