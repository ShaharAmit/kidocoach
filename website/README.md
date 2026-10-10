# Kidocoach Website

Landing website for kidocoach.app.

## Features

- Centered autoplay welcome avatar video (URL loaded from Firestore)
- Top-right hamburger menu with Terms and Conditions + Privacy Policy
- Bottom-right App Store and Play Store links (loaded from Firestore)
- Static legal pages

## Local Run

1. Copy env vars:

```bash
cp .env.example .env
```

2. Fill in Firebase web config values in `.env`.
  Add GA4 measurement ID as well:

```bash
VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX
```

3. Install and run:

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Firestore Document

Document path:

`public_site/config`

Example payload:

```json
{
  "welcomeVideoUrl": "https://storage.googleapis.com/<bucket>/public/welcome.mp4",
  "appStoreUrl": "https://apps.apple.com/app/id6774532766",
  "playStoreUrl": "https://play.google.com/store/apps/details?id=com.kidocoach.app"
}
```

### Seed Command (Recommended)

You can seed this document using Firebase Admin SDK:

```bash
cd functions
npm run seed:public-site
```

Optional overrides:

```bash
WEBSITE_WELCOME_VIDEO_URL="https://storage.googleapis.com/<bucket>/public/welcome.mp4" \
WEBSITE_APP_STORE_URL="https://apps.apple.com/app/id6774532766" \
WEBSITE_PLAY_STORE_URL="https://play.google.com/store/apps/details?id=com.kidocoach.app" \
npm run seed:public-site
```

## Firebase Hosting

1. Build website:

```bash
cd website
npm run build
cd ..
```

2. Set hosting target (one-time):

```bash
firebase target:apply hosting website <your-hosting-site-id>
```

3. Deploy website target:

```bash
firebase deploy --only hosting:website
```

## Domain

Connect `kidocoach.app` to the Hosting site in Firebase Console and configure DNS records from your domain provider.
