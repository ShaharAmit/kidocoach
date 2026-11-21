/* eslint-disable no-console */
/**
 * Early-access email list admin (docs/WEB_ANALYTICS.md §6). Uses Application Default Credentials
 * (`gcloud auth application-default login`) against the Firebase project.
 *
 *   npm run early-access -- stats
 *   npm run early-access -- export --csv leads.csv     # mailable leads + confirm/unsubscribe links for your email provider
 *   npm run early-access -- export-reconfirm --csv old.csv   # leads from before the consent notice: send ONE re-confirm email
 *   npm run early-access -- unsubscribe <email>        # opt-outs that arrive by reply or from the email provider
 *   npm run early-access -- purge-unconfirmed --before 2027-01-31 [--yes]   # delete legacy leads that never re-confirmed
 *
 * Never commit exported CSVs. On export, leads without a token get one and pre-hash documents are migrated.
 */
const fs = require('node:fs');
const { initializeApp, getApps } = require('firebase-admin/app');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const {
  exportRow, isMailable, isValidLeadEmail, leadId, newUnsubscribeToken, normalizeLeadEmail, toCsv,
} = require('../lib/earlyAccessModel');

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'kids-routine-coach-app';
if (!getApps().length) initializeApp({ projectId });
const db = getFirestore();
const leads = db.collection('early_access');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--yes') flags.yes = true;
    else if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}

async function allLeads() {
  const snapshot = await leads.get();
  // Pre-hash documents (id = the email) are moved by migratePreHash() on export.
  return snapshot.docs.filter((doc) => /^[a-f0-9]{64}$/.test(doc.id));
}

// Moves pre-hash documents (id = the email) to `early_access/{sha256}` so they get preference links.
async function migratePreHash() {
  const old = (await leads.get()).docs.filter((doc) => !/^[a-f0-9]{64}$/.test(doc.id));
  for (const doc of old) {
    const email = normalizeLeadEmail(doc.get('email') ?? doc.id);
    if (!isValidLeadEmail(email)) continue;
    const ref = leads.doc(leadId(email));
    await db.runTransaction(async (transaction) => {
      if (!(await transaction.get(ref)).exists) {
        transaction.create(ref, {
          ...doc.data(), email, emailLower: email, emailHash: ref.id,
          migratedAt: FieldValue.serverTimestamp(),
        });
      }
      transaction.delete(doc.ref);
    });
  }
}

async function ensureTokens(docs) {
  const missing = docs.filter((doc) => typeof doc.get('unsubscribeToken') !== 'string' && typeof doc.get('email') === 'string');
  for (let i = 0; i < missing.length; i += 400) {
    const batch = db.batch();
    missing.slice(i, i + 400).forEach((doc) => batch.update(doc.ref, { unsubscribeToken: newUnsubscribeToken() }));
    await batch.commit();
  }
  return missing.length ? allLeads() : docs;
}

async function exportCsv(flags, wantLegacy) {
  if (!flags.csv) throw new Error('--csv <file> is required (emails are never printed).');
  await migratePreHash();
  const docs = await ensureTokens(await allLeads());
  const rows = docs
    .filter((doc) => (wantLegacy ? !doc.get('consent') : isMailable(doc.data())))
    .map((doc) => exportRow(doc.id, doc.data()))
    .filter(Boolean);
  fs.writeFileSync(flags.csv, toCsv(rows), { mode: 0o600 });
  console.log(`Wrote ${rows.length} ${wantLegacy ? 're-confirm' : 'mailable'} leads to ${flags.csv}.`);
}

async function main() {
  const { positional: [command, arg], flags } = parseArgs(process.argv.slice(2));
  if (command === 'stats') {
    const docs = await allLeads();
    const data = docs.map((doc) => doc.data());
    const legacyIds = (await leads.get()).size - docs.length;
    console.table({
      total: docs.length,
      mailable: data.filter(isMailable).length,
      double_opt_in_confirmed: data.filter((d) => d.confirmedAt && !d.unsubscribedAt).length,
      needs_reconfirm: data.filter((d) => d.email && !d.consent && !d.unsubscribedAt).length,
      unsubscribed: data.filter((d) => d.unsubscribedAt).length,
      pre_hash_docs: legacyIds,
    });
  } else if (command === 'export') {
    await exportCsv(flags, false);
  } else if (command === 'export-reconfirm') {
    await exportCsv(flags, true);
  } else if (command === 'unsubscribe') {
    const email = normalizeLeadEmail(arg);
    if (!isValidLeadEmail(email)) throw new Error('Usage: unsubscribe <email>');
    const id = leadId(email);
    await leads.doc(id).set({ emailHash: id, unsubscribedAt: FieldValue.serverTimestamp() });
    await leads.doc(email).delete();
    console.log('Unsubscribed; the address was deleted and only its hash is kept as a suppression record.');
  } else if (command === 'purge-unconfirmed') {
    const before = Date.parse(flags.before ?? '');
    if (!Number.isFinite(before)) throw new Error('--before YYYY-MM-DD is required.');
    const stale = (await leads.get()).docs.filter((doc) => {
      const created = doc.get('createdAt')?.toMillis?.() ?? doc.get('migratedAt')?.toMillis?.() ?? 0;
      return doc.get('email') && !doc.get('consent') && created < before;
    });
    if (!flags.yes) {
      console.log(`${stale.length} leads without consent created before ${flags.before}. Re-run with --yes to delete them.`);
      return;
    }
    for (let i = 0; i < stale.length; i += 400) {
      const batch = db.batch();
      stale.slice(i, i + 400).forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
    console.log(`Deleted ${stale.length} unconfirmed legacy leads.`);
  } else {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
