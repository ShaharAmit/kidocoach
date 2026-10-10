/* eslint-disable no-console */
const admin = require('firebase-admin');

async function run() {
  const projectId =
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ||
    'kids-routine-coach-app';

  if (!admin.apps.length) {
    admin.initializeApp({ projectId });
  }

  const db = admin.firestore();

  const data = {
    welcomeVideoUrl:
      process.env.WEBSITE_WELCOME_VIDEO_URL ||
      'https://storage.googleapis.com/your-bucket/public/welcome.mp4',
    appStoreUrl:
      process.env.WEBSITE_APP_STORE_URL ||
      'https://apps.apple.com/app/id6774532766',
    playStoreUrl:
      process.env.WEBSITE_PLAY_STORE_URL ||
      'https://play.google.com/store/apps/details?id=com.kidocoach.app',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: 'seed-public-site-config-script',
  };

  await db.collection('public_site').doc('config').set(data, { merge: true });
  console.log('Seeded public_site/config in project:', projectId);
  console.log(JSON.stringify({ ...data, updatedAt: 'serverTimestamp()' }, null, 2));
}

run().catch((err) => {
  console.error('Failed to seed public_site/config:', err);
  process.exitCode = 1;
});
