#!/bin/bash
set -e

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
xcrun altool --upload-app \
  -f build/KidoCoach.ipa \
  -t ios \
  --apiKey "$APPLE_KEY_ID" \
  --apiIssuer "$APPLE_ISSUER_ID"

echo "🎉 Deployment complete! Apple will process the build shortly."
