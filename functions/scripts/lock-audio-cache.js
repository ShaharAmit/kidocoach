#!/usr/bin/env node
/**
 * One-off migration for the private-audio + TTL rollout.
 *
 *   node scripts/lock-audio-cache.js                 # dry run (default)
 *   node scripts/lock-audio-cache.js --apply         # make audio private, backfill TTL, strip names
 *   node scripts/lock-audio-cache.js --apply --purge-legacy
 *                                                    # also delete non-Part-1 entries (old
 *                                                    # generateRoutineAudio / generateNameAudio)
 *
 * Uses Application Default Credentials (`gcloud auth application-default login`).
 */
const admin = require('firebase-admin');

const projectId = process.env.GCLOUD_PROJECT || 'kids-routine-coach-app';
const bucketName = process.env.STORAGE_BUCKET || `${projectId}.firebasestorage.app`;
const apply = process.argv.includes('--apply');
const purgeLegacy = process.argv.includes('--purge-legacy');
const TTL_MS = 365 * 24 * 60 * 60 * 1000;

admin.initializeApp({ projectId, storageBucket: bucketName });
const db = admin.firestore();
const bucket = admin.storage().bucket();

async function lockStorageObjects() {
  const [files] = await bucket.getFiles({ prefix: 'audio/' });
  let locked = 0;
  for (const file of files) {
    if (apply) await file.makePrivate();
    locked += 1;
  }
  console.log(`${apply ? 'Made private' : 'Would make private'}: ${locked} audio objects`);
}

async function migrateCacheDocs() {
  const snap = await db.collection('audio_cache').get();
  const expireAt = admin.firestore.Timestamp.fromMillis(Date.now() + TTL_MS);
  const deleteField = admin.firestore.FieldValue.delete();
  let updated = 0;
  let purged = 0;

  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (ops > 0 && apply) await batch.commit();
    batch = db.batch();
    ops = 0;
  };

  for (const doc of snap.docs) {
    if (purgeLegacy && !doc.id.startsWith('p1_')) {
      // onAudioCacheDocDeleted removes the matching Storage object.
      batch.delete(doc.ref);
      purged += 1;
    } else {
      const data = doc.data();
      batch.set(
        doc.ref,
        {
          storagePath: `audio/${doc.id}.wav`,
          expireAt: data.expireAt ?? expireAt,
          audioUrl: deleteField,
          childName: deleteField,
          text: deleteField,
        },
        { merge: true }
      );
      updated += 1;
    }
    ops += 1;
    if (ops >= 400) await flush();
  }
  await flush();

  console.log(`${apply ? 'Updated' : 'Would update'}: ${updated} audio_cache docs (TTL backfill, names stripped)`);
  if (purgeLegacy) console.log(`${apply ? 'Purged' : 'Would purge'}: ${purged} legacy audio_cache docs`);
}

(async () => {
  console.log(`Project ${projectId}, bucket ${bucketName}${apply ? '' : ' (dry run)'}`);
  await lockStorageObjects();
  await migrateCacheDocs();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
