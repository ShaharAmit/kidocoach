/* eslint-disable no-console */
/**
 * Seeds / repairs Firestore `catalog/activities` from what is actually in Cloud Storage.
 *
 *   npm run build && node scripts/seed-activity-catalog.js [--dry-run] [--force-metadata]
 *
 * - Media + artwork refs (path, generation, md5, size) are rebuilt from a bucket listing, so this
 *   also repairs drift if a Storage trigger was missed.
 * - Metadata from scripts/activity-catalog.seed.json is applied only to entries that have none
 *   yet (cloud edits win); pass --force-metadata to overwrite.
 * - Uses the same pure model as the onCatalogAsset* triggers (lib/catalogModel.js).
 */
const path = require('node:path');
const admin = require('firebase-admin');
const {
  applyAssetUpload,
  applyImageUpload,
  applyMetadata,
  parseCatalogObjectPath,
  validateCatalogMetadata,
} = require('../lib/catalogModel');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_METADATA = process.argv.includes('--force-metadata');

async function run() {
  const projectId =
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ||
    'kids-routine-coach-app';
  const bucketName = process.env.STORAGE_BUCKET || `${projectId}.firebasestorage.app`;

  if (!admin.apps.length) admin.initializeApp({ projectId, storageBucket: bucketName });
  const db = admin.firestore();
  const bucket = admin.storage().bucket();
  const docRef = db.doc('catalog/activities');

  const snap = await docRef.get();
  const activities = (snap.exists && snap.get('activities')) || {};

  // Fresh media refs from the bucket; metadata/part1 history of existing entries is preserved.
  for (const entry of Object.values(activities)) {
    delete entry.assets;
    delete entry.image;
  }

  const [files] = await bucket.getFiles({ prefix: 'avatars/' });
  const [catalogFiles] = await bucket.getFiles({ prefix: 'catalog/activities/' });
  // `{key}.mp4` must win over its `_p2.mp4` alias regardless of listing order.
  const ordered = [...files, ...catalogFiles].sort((a, b) => Number(a.name.endsWith('_p2.mp4')) - Number(b.name.endsWith('_p2.mp4')));

  for (const file of ordered) {
    const parsed = parseCatalogObjectPath(file.name);
    if (!parsed || parsed.type === 'metadata') continue;
    const ref = {
      path: file.name,
      generation: String(file.metadata.generation),
      ...(file.metadata.md5Hash ? { md5: file.metadata.md5Hash } : {}),
      ...(file.metadata.size !== undefined ? { size: Number(file.metadata.size) } : {}),
    };
    const current = activities[parsed.activityKey];
    const next =
      parsed.type === 'image'
        ? applyImageUpload(current, parsed.activityKey, ref)
        : applyAssetUpload(current, parsed.activityKey, parsed.avatarId, parsed.kind, ref, parsed.isAlias);
    if (next) activities[parsed.activityKey] = next;
  }

  // Uploaded metadata files are authoritative over the bundled seed.
  for (const file of catalogFiles) {
    const parsed = parseCatalogObjectPath(file.name);
    if (!parsed || parsed.type !== 'metadata') continue;
    const [contents] = await file.download();
    const result = validateCatalogMetadata(JSON.parse(contents.toString('utf8')));
    if (!result.ok) {
      console.warn(`Skipping ${file.name}: ${result.errors.join('; ')}`);
      continue;
    }
    activities[parsed.activityKey] = applyMetadata(activities[parsed.activityKey], parsed.activityKey, result.value);
  }

  const seed = require(path.join(__dirname, 'activity-catalog.seed.json'));
  for (const [key, raw] of Object.entries(seed)) {
    const existing = activities[key];
    if (existing && existing.label && !FORCE_METADATA) continue;
    const result = validateCatalogMetadata(raw);
    if (!result.ok) throw new Error(`Invalid seed entry ${key}: ${result.errors.join('; ')}`);
    activities[key] = applyMetadata(existing, key, result.value);
  }

  const summary = Object.values(activities).map((entry) => {
    const media = (entry.assets && entry.assets.becky) || {};
    return {
      key: entry.key,
      label: entry.label || '(no metadata)',
      p1: Boolean(media.p1),
      p2: Boolean(media.p2),
      captions: Boolean(media.captions),
      part1: entry.part1 ? `v${entry.part1.version}` : '-',
      enabled: entry.enabled !== false,
    };
  });
  console.table(summary);

  if (DRY_RUN) {
    console.log('Dry run — nothing written.');
    return;
  }
  await docRef.set({
    schemaVersion: 1,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    activities,
  });
  console.log(`Wrote catalog/activities (${Object.keys(activities).length} activities) in ${projectId}.`);
}

run().catch((err) => {
  console.error('Failed to seed catalog/activities:', err);
  process.exitCode = 1;
});
