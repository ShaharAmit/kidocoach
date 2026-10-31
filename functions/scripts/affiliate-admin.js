/* eslint-disable no-console */
/**
 * Affiliate program admin (ADR-019). Uses Application Default Credentials
 * (`gcloud auth application-default login`) against the Firebase project.
 *
 *   npm run affiliates -- create <code> --name "Jane Blog" --email jane@example.com \
 *       [--rate-bps 1500] [--months 12] [--owner-uid <firebaseUid>] [--coupon JANE10] [--payout-email paypal@x.com] [--payout-method paypal|wise]
 *   npm run affiliates -- update <code> [--rate-bps 2000] [--months 6] [--coupon NEW10|none] [--owner-uid <uid>|none] [--payout-email ...] [--payout-method paypal|wise]
 *   npm run affiliates -- set-status <code> active|disabled
 *   npm run affiliates -- list                           # partners also join themselves at /partners (source self_serve)
 *   npm run affiliates -- report [--csv payouts.csv]       # what each partner is owed now (approved, net of clawbacks) + how to pay them
 *   npm run affiliates -- mark-paid <code> --currency USD --amount <owed_minor>   # after paying the reported amount
 *
 * Amounts are minor units (cents). Commissions become "approved" 30 days after payment
 * (approveAffiliateCommissions); refunds after a payout show up as negative owed amounts.
 */
const fs = require('node:fs');
const admin = require('firebase-admin');
const {
  DEFAULT_COMMISSION_RATE_BPS, DEFAULT_PAYOUT_METHOD, DEFAULT_RECURRING_MONTHS, normalizeAffiliateCode,
  normalizeCouponCode, normalizeEmail, normalizePayoutMethod, owedAmount, parseAffiliate, payoutLines,
} = require('../lib/affiliateModel');

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'kids-routine-coach-app';
if (!admin.apps.length) admin.initializeApp({ projectId });
const db = admin.firestore();

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

function fail(message) {
  throw new Error(message);
}

function requireCode(raw) {
  return normalizeAffiliateCode(raw) || fail(`Invalid code "${raw}" (3-32 chars: a-z, 0-9, _ or -).`);
}

function toCommission(doc) {
  const data = doc.data();
  return {
    ...data,
    transactionId: doc.id,
    billedAt: data.billedAt.toMillis(),
    holdUntil: data.holdUntil.toMillis(),
  };
}

async function create(rawCode, flags) {
  const code = requireCode(rawCode);
  const email = normalizeEmail(flags.email) || fail('--email is required.');
  const coupon = flags.coupon === undefined ? null : (normalizeCouponCode(flags.coupon) || fail('Invalid --coupon.'));
  const doc = {
    name: (flags.name || '').trim() || fail('--name is required.'),
    email,
    status: 'active',
    commissionRateBps: flags['rate-bps'] === undefined ? DEFAULT_COMMISSION_RATE_BPS : Number(flags['rate-bps']),
    recurringMonths: flags.months === undefined ? DEFAULT_RECURRING_MONTHS : Number(flags.months),
    ownerUid: flags['owner-uid'] || null,
    discountCode: coupon,
    payoutEmail: normalizeEmail(flags['payout-email']) || email,
    payoutMethod: flags['payout-method'] === undefined ? DEFAULT_PAYOUT_METHOD
      : (normalizePayoutMethod(flags['payout-method']) || fail('--payout-method must be paypal or wise.')),
    createdAt: admin.firestore.Timestamp.now(),
  };
  if (!parseAffiliate(code, doc)) fail('Invalid partner fields (rate-bps 1-5000, months 0-120).');
  if (coupon) {
    const taken = await db.collection('affiliates').where('discountCode', '==', coupon).limit(1).get();
    if (!taken.empty) fail(`Coupon ${coupon} already belongs to ${taken.docs[0].id}.`);
    console.log(`Remember to create the Paddle discount "${coupon}" (Catalog > Discounts) if it doesn't exist.`);
  }
  await db.collection('affiliates').doc(code).create(doc);
  console.log(`Created partner ${code}: https://kidocoach.app/?ref=${code}`);
}

async function update(rawCode, flags) {
  const code = requireCode(rawCode);
  const ref = db.collection('affiliates').doc(code);
  const changes = {};
  if (flags.name !== undefined) changes.name = flags.name.trim() || fail('Invalid --name.');
  if (flags.email !== undefined) changes.email = normalizeEmail(flags.email) || fail('Invalid --email.');
  if (flags['payout-email'] !== undefined) changes.payoutEmail = normalizeEmail(flags['payout-email']) || fail('Invalid --payout-email.');
  if (flags['payout-method'] !== undefined) {
    changes.payoutMethod = normalizePayoutMethod(flags['payout-method']) || fail('--payout-method must be paypal or wise.');
  }
  if (flags['rate-bps'] !== undefined) changes.commissionRateBps = Number(flags['rate-bps']);
  if (flags.months !== undefined) changes.recurringMonths = Number(flags.months);
  if (flags['owner-uid'] !== undefined) changes.ownerUid = flags['owner-uid'] === 'none' ? null : flags['owner-uid'];
  if (flags.coupon !== undefined) {
    changes.discountCode = flags.coupon === 'none' ? null : (normalizeCouponCode(flags.coupon) || fail('Invalid --coupon.'));
  }
  if (!Object.keys(changes).length) fail('Nothing to update.');
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail(`No partner ${code}.`);
    const next = { ...snap.data(), ...changes };
    if (!parseAffiliate(code, next)) fail('Invalid partner fields (rate-bps 1-5000, months 0-120).');
    if (changes.discountCode) {
      const taken = await tx.get(db.collection('affiliates').where('discountCode', '==', changes.discountCode).limit(2));
      const owner = taken.docs.find((doc) => doc.id !== code);
      if (owner) fail(`Coupon ${changes.discountCode} already belongs to ${owner.id}.`);
    }
    tx.update(ref, { ...changes, updatedAt: admin.firestore.Timestamp.now() });
  });
  console.log(`Updated ${code}: ${Object.keys(changes).join(', ')}. Rate/months apply to future payments only.`);
}

async function setStatus(rawCode, status) {
  if (status !== 'active' && status !== 'disabled') fail('Status must be active or disabled.');
  await db.collection('affiliates').doc(requireCode(rawCode)).update({ status });
  console.log(`${rawCode} is now ${status}.`);
}

async function list() {
  const snap = await db.collection('affiliates').get();
  for (const doc of snap.docs) {
    const a = doc.data();
    console.log([doc.id, a.status, a.name, a.email, `${a.commissionRateBps / 100}%`, `${a.recurringMonths}mo`,
      a.discountCode || '-', a.ownerUid || '-', a.source || 'admin'].join('\t'));
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function report(flags) {
  const snap = await db.collection('affiliate_commissions').where('status', 'in', ['approved', 'paid']).get();
  const lines = payoutLines(snap.docs.map(toCommission));
  const partners = new Map();
  for (const line of lines) {
    if (!partners.has(line.code)) partners.set(line.code, (await db.collection('affiliates').doc(line.code).get()).data());
  }
  const rows = [['code', 'name', 'payout_method', 'payout_email', 'currency', 'commissions', 'owed_minor', 'owed']];
  for (const line of lines) {
    const partner = partners.get(line.code) || {};
    rows.push([line.code, partner.name, normalizePayoutMethod(partner.payoutMethod) || DEFAULT_PAYOUT_METHOD,
      partner.payoutEmail || partner.email, line.currency, line.commissions,
      line.owed, (line.owed / 100).toFixed(2)]);
  }
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
  if (flags.csv) {
    fs.writeFileSync(flags.csv, `${csv}\n`);
    console.log(`Wrote ${lines.length} payout lines to ${flags.csv}.`);
  } else {
    console.log(csv);
  }
}

async function markPaid(rawCode, flags) {
  const code = requireCode(rawCode);
  const currency = (flags.currency || '').toUpperCase() || fail('--currency is required.');
  const expected = Number(flags.amount);
  if (!Number.isSafeInteger(expected) || expected <= 0) {
    fail('--amount is required: the owed_minor value from `report` that you paid (a positive integer).');
  }
  // One transaction over the same commissions `report` reads: if anything was approved, refunded
  // or settled since the report, the total no longer matches and nothing is written.
  const query = db.collection('affiliate_commissions')
    .where('code', '==', code).where('status', 'in', ['approved', 'paid']);
  const { settled, total } = await db.runTransaction(async (tx) => {
    const snap = await tx.get(query);
    const due = snap.docs
      .map((doc) => ({ doc, commission: toCommission(doc) }))
      .filter(({ commission }) => commission.currency === currency && owedAmount(commission) !== 0);
    const sum = due.reduce((acc, { commission }) => acc + owedAmount(commission), 0);
    if (sum !== expected) {
      fail(`${code} is owed ${sum} ${currency} minor units now, not ${expected}. Re-run \`report\`; nothing was changed.`);
    }
    const now = admin.firestore.Timestamp.now();
    // Shown to the partner as payout history on their dashboard.
    tx.create(db.collection('affiliate_payouts').doc(`${code}_${currency}_${now.toMillis()}`), {
      code, currency, amount: sum, commissions: due.length, paidAt: now,
    });
    for (const { doc, commission } of due) {
      tx.update(doc.ref, {
        status: 'paid',
        paidAmount: commission.paidAmount + owedAmount(commission),
        paidAt: now,
        updatedAt: now,
      });
    }
    return { settled: due.length, total: sum };
  });
  console.log(`Marked ${settled} commissions paid for ${code}: ${(total / 100).toFixed(2)} ${currency}.`);
}

async function run() {
  const { positional: [command, ...rest], flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'create': return create(rest[0], flags);
    case 'update': return update(rest[0], flags);
    case 'set-status': return setStatus(rest[0], rest[1]);
    case 'list': return list();
    case 'report': return report(flags);
    case 'mark-paid': return markPaid(rest[0], flags);
    default: fail('Usage: affiliate-admin.js create|update|set-status|list|report|mark-paid (see file header).');
  }
  return undefined;
}

run().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
