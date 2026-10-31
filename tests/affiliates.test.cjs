const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function loadSource(filename, mocks = {}) {
  const source = fs.readFileSync(path.join(root, filename), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((id) => {
    if (id in mocks) return mocks[id];
    if (id === 'crypto') return crypto;
    throw new Error(`Unexpected dependency ${id}`);
  }, module, module.exports);
  return module.exports;
}

const model = loadSource('functions/src/affiliateModel.ts');
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const SECRET = 'pdl_ntfset_secret';

const partner = (overrides = {}) => model.parseAffiliate('jane', {
  name: 'Jane', email: 'jane@example.com', status: 'active', ...overrides,
});
const attribution = (overrides = {}) => ({ code: 'jane', source: 'link', claimedAt: T0, firstPaidAt: null, ...overrides });
const paddleTxn = (overrides = {}) => ({
  id: 'txn_01aaaaaaaaaa', status: 'completed', subscription_id: 'sub_01aaaaaaaaaa', origin: 'web',
  billed_at: new Date(T0 + DAY).toISOString(), currency_code: 'USD',
  custom_data: { app_user_id: 'family', affiliate_code: 'jane' },
  details: { totals: { subtotal: '4999', discount: '0', tax: '850', total: '5849' } },
  ...overrides,
});
const adjustment = (overrides = {}) => ({
  id: 'adj_01aaaaaaaaaa', transaction_id: 'txn_01aaaaaaaaaa', action: 'refund', status: 'approved',
  totals: { subtotal: '4999', tax: '850', total: '5849', currency_code: 'USD' }, ...overrides,
});

function sign(body, at = Date.now(), secret = SECRET) {
  const tsSeconds = Math.floor(at / 1000);
  const h1 = crypto.createHmac('sha256', secret).update(`${tsSeconds}:${body}`).digest('hex');
  return `ts=${tsSeconds};h1=${h1}`;
}

test('self-serve codes and names are validated; conversions carry no family identifiers', () => {
  assert.equal(model.selfServeCodeProblem('dan_blog'), null);
  assert.equal(model.selfServeCodeProblem('x'), 'invalid_code');
  for (const reserved of ['admin', 'Kido_Coach', 'kidocoach-deals', 'partners']) {
    assert.equal(model.selfServeCodeProblem(reserved), 'reserved_code', reserved);
  }
  assert.equal(model.normalizePartnerName('  Dan\n Blog '), 'Dan Blog');
  for (const bad of ['D', 'x'.repeat(61), '<script>', 5]) assert.equal(model.normalizePartnerName(bad), null);
  const base = { code: 'jane', uid: 'family', transactionId: 't', subscriptionId: 's', currency: 'USD', netAmount: 4999,
    rateBps: 1500, amount: 749, reversed: 100, paidAmount: 0, adjustmentIds: [], status: 'pending', holdUntil: 0 };
  assert.deepEqual(model.partnerConversions([
    { ...base, billedAt: 1, origin: 'web' },
    { ...base, billedAt: 3, origin: 'subscription_recurring' },
    { ...base, billedAt: 2 },
  ], 2), [
    { billedAt: 3, kind: 'renewal', currency: 'USD', saleAmount: 4999, commission: 649, status: 'pending' },
    { billedAt: 2, kind: 'first', currency: 'USD', saleAmount: 4999, commission: 649, status: 'pending' },
  ]);
});

test('partner codes, coupons and partner documents are strictly validated', () => {
  assert.equal(model.normalizeAffiliateCode(' Jane_Blog-1 '), 'jane_blog-1');
  for (const bad of ['ab', '-jane', 'a b', 'x'.repeat(33), '<x>', 7, null]) {
    assert.equal(model.normalizeAffiliateCode(bad), null);
  }
  assert.equal(model.normalizeCouponCode(' jane10 '), 'JANE10');
  assert.equal(model.normalizeCouponCode('JANE-10'), null);
  assert.deepEqual(partner(), {
    code: 'jane', name: 'Jane', email: 'jane@example.com', status: 'active', commissionRateBps: 1500,
    recurringMonths: 12, ownerUid: null, discountCode: null,
  });
  assert.equal(partner({ commissionRateBps: 0.15 }), null);
  assert.equal(partner({ commissionRateBps: 9000 }), null);
  assert.equal(partner({ status: 'paused' }), null);
  assert.equal(partner({ email: 'nope' }), null);
  assert.equal(model.parseAffiliate('Jane', { name: 'Jane', email: 'jane@example.com', status: 'active' }), null);
});

test('Paddle signatures are verified over the raw body, with replay protection and secret rotation', () => {
  const body = JSON.stringify({ event_id: 'evt_01aaaaaaaaaa' });
  const now = T0;
  assert.equal(model.verifyPaddleSignature(sign(body, now), Buffer.from(body), SECRET, now), true);
  assert.equal(model.verifyPaddleSignature(sign(body, now), `${body} `, SECRET, now), false);
  assert.equal(model.verifyPaddleSignature(sign(body, now, 'other'), body, SECRET, now), false);
  assert.equal(model.verifyPaddleSignature(sign(body, now - 301_000), body, SECRET, now), false);
  const rotated = `${sign(body, now, 'old')};h1=${sign(body, now).split('h1=')[1]}`;
  assert.equal(model.verifyPaddleSignature(rotated, body, SECRET, now), true);
  for (const header of [undefined, '', 'ts=abc;h1=00', `h1=${'0'.repeat(64)}`, 'ts=1;h1=zz']) {
    assert.equal(model.verifyPaddleSignature(header, body, SECRET, now), false);
  }
  assert.equal(model.verifyPaddleSignature(sign(body, now), body, '', now), false);
});

test('claims refuse unknown or disabled codes, self-referrals and existing web customers', () => {
  const family = { uid: 'family', email: 'parent@example.com', isExistingCustomer: false };
  assert.equal(model.claimRejection(null, family), 'unknown_code');
  assert.equal(model.claimRejection(partner({ status: 'disabled' }), family), 'inactive');
  assert.equal(model.claimRejection(partner({ ownerUid: 'family' }), family), 'self_referral');
  assert.equal(model.claimRejection(partner({ email: 'Parent@Example.com' }), family), 'self_referral');
  assert.equal(model.claimRejection(partner(), { ...family, isExistingCustomer: true }), 'existing_customer');
  assert.equal(model.claimRejection(partner(), family), null);
  assert.equal(model.isAttributionOpen(attribution(), T0 + 60 * DAY), true);
  assert.equal(model.isAttributionOpen(attribution(), T0 + 61 * DAY), false);
  assert.equal(model.isAttributionOpen(attribution({ firstPaidAt: T0 }), T0 + 400 * DAY), true);
});

test('commission is the rate of the pre-tax, post-discount amount; trials and forged codes earn nothing', () => {
  const txn = model.parsePaddleTransaction(paddleTxn({
    details: { totals: { subtotal: '4999', discount: '500', tax: '765', total: '5264' } },
  }));
  assert.equal(txn.netAmount, 4499);
  assert.equal(txn.affiliateCode, 'jane');
  assert.equal(model.commissionIneligibility(attribution(), partner(), txn), null);
  const commission = model.newCommission(partner(), txn);
  assert.equal(commission.amount, 674);
  assert.equal(commission.holdUntil, txn.billedAt + 30 * DAY);
  assert.equal(commission.status, 'pending');

  const trial = model.parsePaddleTransaction(paddleTxn({ details: { totals: { tax: '0', total: '0' } } }));
  assert.equal(model.commissionIneligibility(attribution(), partner(), trial), 'zero_amount');
  assert.equal(model.parsePaddleTransaction(paddleTxn({ custom_data: {} })), null);
  assert.equal(model.parsePaddleTransaction(paddleTxn({ id: '../x' })), null);

  const unstamped = model.parsePaddleTransaction(paddleTxn({ custom_data: { app_user_id: 'family' } }));
  assert.equal(model.commissionIneligibility(attribution(), partner(), unstamped), 'code_mismatch');
  assert.equal(model.commissionIneligibility(attribution({ code: 'other' }), partner(), txn), 'code_mismatch');
  assert.equal(model.commissionIneligibility(null, partner(), txn), 'no_attribution');
  assert.equal(model.commissionIneligibility(attribution(), partner({ status: 'disabled' }), txn), 'affiliate_inactive');
  assert.equal(model.commissionIneligibility(attribution({ claimedAt: T0 + 2 * DAY }), partner(), txn), 'before_claim');
  assert.equal(model.commissionIneligibility(attribution({ claimedAt: T0 - 60 * DAY }), partner(), txn), 'window_expired');
});

test('renewals earn commission only inside the recurring window', () => {
  const renewal = (monthsLater) => model.parsePaddleTransaction(paddleTxn({
    id: 'txn_01bbbbbbbbbb', origin: 'subscription_recurring',
    billed_at: new Date(Date.UTC(2026, 10 + monthsLater, 2)).toISOString(),
  }));
  const paid = attribution({ claimedAt: T0 - 90 * DAY, firstPaidAt: Date.UTC(2026, 10, 2) });
  assert.equal(model.commissionIneligibility(paid, partner(), renewal(11)), null);
  assert.equal(model.commissionIneligibility(paid, partner(), renewal(12)), 'recurring_ended');
  assert.equal(model.commissionIneligibility(paid, partner({ recurringMonths: 0 }), renewal(1)), 'recurring_ended');
});

test('refunds and chargebacks reverse commission proportionally, once, and claw back after payout', () => {
  const base = model.newCommission(partner(), model.parsePaddleTransaction(paddleTxn()));
  assert.equal(base.amount, 749);
  const partial = model.applyAdjustment(base, model.parsePaddleAdjustment(adjustment({
    type: 'partial', totals: { subtotal: '2000', tax: '340', total: '2340', currency_code: 'USD' },
  })), T0);
  assert.deepEqual([partial.reversed, partial.status], [300, 'pending']);
  assert.equal(model.applyAdjustment(partial, model.parsePaddleAdjustment(adjustment({
    totals: { subtotal: '2000', tax: '340', total: '2340', currency_code: 'USD' },
  })), T0), null, 'same adjustment id is applied once');
  assert.equal(model.applyAdjustment(base, model.parsePaddleAdjustment(adjustment({ status: 'pending_approval' }))), null);
  assert.equal(model.applyAdjustment(base, model.parsePaddleAdjustment(adjustment({
    totals: { subtotal: '4999', tax: '0', total: '4999', currency_code: 'EUR' },
  }))), null);
  assert.equal(model.parsePaddleAdjustment(adjustment({ action: 'credit' })), null);

  const full = model.applyAdjustment(base, model.parsePaddleAdjustment(adjustment({ action: 'chargeback' })), T0);
  assert.deepEqual([full.reversed, full.status], [749, 'void']);
  const reinstated = model.applyAdjustment(full, model.parsePaddleAdjustment(adjustment({
    id: 'adj_01bbbbbbbbbb', action: 'chargeback_reverse',
  })), base.holdUntil + 1);
  assert.deepEqual([reinstated.reversed, reinstated.status], [0, 'approved']);

  const paidOut = { ...base, status: 'paid', paidAmount: 749 };
  const clawback = model.applyAdjustment(paidOut, model.parsePaddleAdjustment(adjustment()), T0);
  assert.equal(clawback.status, 'paid');
  assert.equal(model.owedAmount(clawback), -749);
  assert.equal(model.owedAmount(base), 0, 'pending commissions are not payable yet');
});

test('payout lines net clawbacks per partner and currency; partner totals are net of refunds', () => {
  const c = (overrides) => ({ code: 'jane', currency: 'USD', amount: 700, reversed: 0, paidAmount: 0,
    status: 'approved', uid: 'u', ...overrides });
  const commissions = [
    c({}), c({ amount: 300 }), c({ status: 'paid', paidAmount: 500, amount: 500, reversed: 500 }),
    c({ status: 'pending', amount: 999 }), c({ status: 'void', amount: 100, reversed: 100 }),
    c({ code: 'amy', currency: 'EUR', amount: 400 }), c({ status: 'paid', amount: 200, paidAmount: 200 }),
  ];
  assert.deepEqual(model.payoutLines(commissions), [
    { code: 'amy', currency: 'EUR', commissions: 1, owed: 400 },
    { code: 'jane', currency: 'USD', commissions: 3, owed: 500 },
  ]);
  assert.deepEqual(model.summarizeEarnings(commissions.filter((x) => x.code === 'jane')), [
    { currency: 'USD', pending: 999, approved: 1000, paid: 700 },
  ]);
});

/** Minimal in-memory Firestore: docs, transactions (buffered writes), equality/range queries, count, preconditions. */
function fakeFirestore() {
  class Timestamp {
    constructor(ms) { this.ms = ms; }
    static now() { return new Timestamp(Date.now()); }
    static fromMillis(ms) { return new Timestamp(ms); }
    toMillis() { return this.ms; }
  }
  const docs = new Map();
  let version = 0;
  const state = { failTransactions: false };
  const value = (v) => (v instanceof Timestamp ? v.ms : v);
  const snapshot = (ref) => {
    const entry = docs.get(ref.path);
    return { id: ref.id, ref, exists: Boolean(entry), data: () => entry?.data, get: (k) => entry?.data[k],
      updateTime: entry?.version };
  };
  const write = (ref, data, mode, options) => {
    const entry = docs.get(ref.path);
    if (mode === 'create' && entry) throw new Error(`ALREADY_EXISTS ${ref.path}`);
    if (mode === 'update' && !entry) throw new Error(`NOT_FOUND ${ref.path}`);
    if (options?.lastUpdateTime !== undefined && entry?.version !== options.lastUpdateTime) {
      throw new Error('FAILED_PRECONDITION');
    }
    const merged = mode === 'update' || options?.merge ? { ...entry?.data, ...data } : { ...data };
    for (const [key, field] of Object.entries(merged)) {
      if (field && typeof field === 'object' && 'increment' in field) merged[key] = (entry?.data[key] ?? 0) + field.increment;
    }
    docs.set(ref.path, { data: merged, version: ++version });
  };
  const docRef = (name, id) => {
    const ref = { id, path: `${name}/${id}` };
    Object.assign(ref, {
      get: async () => snapshot(ref),
      create: async (data) => write(ref, data, 'create'),
      set: async (data, options) => write(ref, data, 'set', options),
      update: async (data, options) => write(ref, data, 'update', options),
      delete: async () => { docs.delete(ref.path); },
    });
    return ref;
  };
  const query = (name, filters = [], max = Infinity) => {
    const run = () => [...docs.keys()]
      .filter((key) => key.startsWith(`${name}/`) && !key.slice(name.length + 1).includes('/'))
      .map((key) => docRef(name, key.slice(name.length + 1)))
      .filter((ref) => filters.every(([field, op, expected]) => {
        const actual = value(docs.get(ref.path).data[field]);
        return op === '==' ? actual === value(expected) : op === '<=' ? actual <= value(expected)
          : op === 'in' ? expected.includes(actual) : false;
      }))
      .slice(0, max)
      .map(snapshot);
    return {
      where: (field, op, expected) => query(name, [...filters, [field, op, expected]], max),
      limit: (n) => query(name, filters, n),
      get: async () => { const list = run(); return { docs: list, size: list.length, empty: !list.length }; },
      count: () => ({ get: async () => ({ data: () => ({ count: run().length }) }) }),
    };
  };
  const db = {
    collection: (name) => ({ doc: (id) => docRef(name, id), ...query(name) }),
    runTransaction: async (fn) => {
      if (state.failTransactions) throw new Error('firestore down');
      const writes = [];
      const tx = {
        get: async (ref) => snapshot(ref),
        create: (ref, data) => writes.push(() => write(ref, data, 'create')),
        update: (ref, data) => writes.push(() => write(ref, data, 'update')),
      };
      const result = await fn(tx);
      writes.forEach((apply) => apply());
      return result;
    },
  };
  const put = (pathname, data) => write({ path: pathname }, data, 'set');
  const read = (pathname) => docs.get(pathname)?.data;
  return { db, Timestamp, put, read, state, docs };
}

function serverHarness() {
  const fs = fakeFirestore();
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const server = loadSource('functions/src/affiliates.ts', {
    './affiliateModel': model,
    'firebase-admin/firestore': {
      getFirestore: () => fs.db, Timestamp: fs.Timestamp, FieldValue: { increment: (n) => ({ increment: n }) },
    },
    'firebase-functions/params': { defineSecret: () => ({ value: () => SECRET }) },
    'firebase-functions/v2/https': {
      onCall: (_options, handler) => handler, onRequest: (_options, handler) => handler, HttpsError,
    },
    'firebase-functions/v2/scheduler': { onSchedule: (_options, handler) => handler },
  });
  fs.put('affiliates/jane', {
    name: 'Jane', email: 'jane@example.com', status: 'active', commissionRateBps: 1500, recurringMonths: 12,
    ownerUid: 'jane_uid', discountCode: 'JANE10',
  });
  const request = (data = {}, uid = 'family', provider = 'password', email = 'parent@example.com') => ({
    auth: { uid, token: { email, firebase: { sign_in_provider: provider } } }, data,
  });
  const webhook = async (event, { signature, method = 'POST' } = {}) => {
    const body = JSON.stringify(event);
    const response = { code: 0, body: null };
    const res = {
      status(code) { response.code = code; return this; },
      send(body) { response.body = body; return this; },
      json(body) { response.body = body; return this; },
    };
    await server.paddleWebhook({
      method, rawBody: Buffer.from(body), get: (name) => (name === 'paddle-signature' ? signature ?? sign(body) : undefined),
    }, res);
    return response;
  };
  return { server, fs, request, webhook };
}

test('referral claims are parent-only, first-touch and immutable', async () => {
  const h = serverHarness();
  const claim = (data, ...rest) => h.server.claimAffiliateReferral(h.request(data, ...rest));
  await assert.rejects(h.server.claimAffiliateReferral({ data: { code: 'jane' } }), { code: 'unauthenticated' });
  await assert.rejects(claim({ code: 'jane' }, 'guest', 'anonymous'), { code: 'unauthenticated' });
  assert.deepEqual(await claim({ code: '<x>' }), { status: 'invalid_code' });
  assert.deepEqual(await claim({ code: 'nobody' }), { status: 'unknown_code' });
  assert.deepEqual(await claim({ code: 'JANE' }), { status: 'claimed' });
  assert.equal(h.fs.read('affiliate_attributions/family').code, 'jane');
  h.fs.put('affiliates/amy', { name: 'Amy', email: 'amy@example.com', status: 'active' });
  assert.deepEqual(await claim({ code: 'amy' }), { status: 'already_attributed' });
  assert.equal(h.fs.read('affiliate_attributions/family').code, 'jane');
  assert.deepEqual(await claim({ code: 'jane' }, 'jane_uid', 'google', 'other@example.com'), { status: 'self_referral' });
  h.fs.put('billing_customers/returning', { paddleCustomerId: 'ctm_1' });
  assert.deepEqual(await claim({ code: 'jane' }, 'returning'), { status: 'existing_customer' });
  h.fs.state.failTransactions = true;
  await assert.rejects(claim({ code: 'jane' }, 'later'), { code: 'unavailable' });
});

test('checkout attribution comes from the server record: link, partner coupon, window and status', async () => {
  const h = serverHarness();
  const resolve = (uid, referral, coupon) => h.server.resolveCheckoutAffiliate(uid, 'p@example.com', referral, coupon);
  assert.equal(await resolve('a', undefined, undefined), null);
  assert.equal(await resolve('a', 'jane', undefined), 'jane');
  assert.equal(h.fs.read('affiliate_attributions/a').source, 'link');
  assert.equal(await resolve('b', 'unknown', 'jane10'), 'jane');
  assert.equal(h.fs.read('affiliate_attributions/b').source, 'coupon');
  assert.equal(await resolve('c', undefined, 'WEB10'), null);

  h.fs.put('affiliate_attributions/old', { code: 'jane', source: 'link', firstPaidAt: null,
    claimedAt: h.fs.Timestamp.fromMillis(Date.now() - 61 * DAY) });
  assert.equal(await resolve('old', 'jane', undefined), null, 'expired attribution is not refreshed by a new link');

  h.fs.put('affiliates/jane', { ...h.fs.read('affiliates/jane'), status: 'disabled' });
  assert.equal(await resolve('a', undefined, undefined), null);
  h.fs.state.failTransactions = true;
  assert.equal(await resolve('d', 'jane', undefined), null, 'affiliate errors never block checkout');
});

test('the Paddle webhook rejects unsigned calls and records each commission exactly once', async () => {
  const h = serverHarness();
  await h.server.claimAffiliateReferral(h.request({ code: 'jane' }));
  const billedAt = new Date(Date.now() + 1000).toISOString();
  const event = (id, type, data) => ({ event_id: id, event_type: type, data });
  const paid = event('evt_01aaaaaaaaaa', 'transaction.completed', paddleTxn({ billed_at: billedAt }));

  assert.equal((await h.webhook(paid, { method: 'GET' })).code, 405);
  assert.equal((await h.webhook(paid, { signature: sign('{}') })).code, 401);
  assert.equal(h.fs.read('affiliate_commissions/txn_01aaaaaaaaaa'), undefined);
  assert.equal((await h.webhook({ event_type: 'x' })).code, 400);

  assert.deepEqual(await h.webhook(paid), { code: 200, body: { received: true } });
  assert.equal((await h.webhook(paid)).code, 200);
  const commission = h.fs.read('affiliate_commissions/txn_01aaaaaaaaaa');
  assert.deepEqual([commission.code, commission.amount, commission.status, commission.uid], ['jane', 749, 'pending', 'family']);
  assert.equal(commission.holdUntil.toMillis(), Date.parse(billedAt) + 30 * DAY);
  assert.equal(h.fs.read('affiliate_attributions/family').firstPaidAt.toMillis(), Date.parse(billedAt));
  assert.equal(h.fs.read('paddle_events/evt_01aaaaaaaaaa').outcome, 'commission_created');
  assert.equal([...h.fs.docs.keys()].filter((key) => key.startsWith('affiliate_commissions/')).length, 1);

  const renewal = event('evt_01bbbbbbbbbb', 'transaction.completed', paddleTxn({
    id: 'txn_01bbbbbbbbbb', origin: 'subscription_recurring', billed_at: new Date(Date.now() + 2000).toISOString(),
  }));
  await h.webhook(renewal);
  assert.equal(h.fs.read('affiliate_commissions/txn_01bbbbbbbbbb').amount, 749);
  assert.equal(h.fs.read('affiliate_attributions/family').firstPaidAt.toMillis(), Date.parse(billedAt));

  const other = event('ntfsimevt_01cccccccccc', 'transaction.completed', paddleTxn({
    id: 'txn_01cccccccccc', billed_at: billedAt, custom_data: { app_user_id: 'stranger', affiliate_code: 'jane' },
  }));
  await h.webhook(other);
  assert.equal(h.fs.read('paddle_events/ntfsimevt_01cccccccccc').outcome, 'ignored:no_attribution');

  await h.webhook(event('evt_01dddddddddd', 'adjustment.created', adjustment({ status: 'pending_approval' })));
  assert.equal(h.fs.read('affiliate_commissions/txn_01aaaaaaaaaa').status, 'pending');
  await h.webhook(event('evt_01eeeeeeeeee', 'adjustment.updated', adjustment()));
  assert.deepEqual([h.fs.read('affiliate_commissions/txn_01aaaaaaaaaa').status,
    h.fs.read('affiliate_commissions/txn_01aaaaaaaaaa').reversed], ['void', 749]);

  h.fs.state.failTransactions = true;
  assert.equal((await h.webhook(event('evt_01ffffffffff', 'transaction.completed', paddleTxn()))).code, 500);
});

test('commissions are approved after the hold unless they changed concurrently', async () => {
  const h = serverHarness();
  const { Timestamp } = h.fs;
  const base = { code: 'jane', uid: 'family', currency: 'USD', netAmount: 4999, rateBps: 1500, amount: 749,
    reversed: 0, paidAmount: 0, adjustmentIds: [], status: 'pending', billedAt: Timestamp.fromMillis(T0) };
  h.fs.put('affiliate_commissions/txn_due', { ...base, holdUntil: Timestamp.fromMillis(T0 + 30 * DAY) });
  h.fs.put('affiliate_commissions/txn_later', { ...base, holdUntil: Timestamp.fromMillis(T0 + 40 * DAY) });
  h.fs.put('affiliate_commissions/txn_void', { ...base, status: 'void', holdUntil: Timestamp.fromMillis(T0) });
  assert.equal(await h.server.approveDueCommissions(Timestamp.fromMillis(T0 + 31 * DAY)), 1);
  assert.equal(h.fs.read('affiliate_commissions/txn_due').status, 'approved');
  assert.equal(h.fs.read('affiliate_commissions/txn_later').status, 'pending');
  assert.equal(h.fs.read('affiliate_commissions/txn_void').status, 'void');

  // A refund landing between the query and the update wins.
  const original = h.fs.db.collection;
  h.fs.db.collection = (name) => {
    const collection = original(name);
    return { ...collection, where: (...args) => {
      const q = collection.where(...args);
      return { ...q, where: (...more) => { const q2 = q.where(...more); return { ...q2, limit: (n) => {
        const q3 = q2.limit(n);
        return { get: async () => {
          const result = await q3.get();
          h.fs.put('affiliate_commissions/txn_later', { ...h.fs.read('affiliate_commissions/txn_later'), status: 'void' });
          return result;
        } };
      } }; } };
    } };
  };
  assert.equal(await h.server.approveDueCommissions(Timestamp.fromMillis(T0 + 41 * DAY)), 0);
  assert.equal(h.fs.read('affiliate_commissions/txn_later').status, 'void');
});

test('partners see only their own clicks, sales, payouts and totals', async () => {
  const h = serverHarness();
  const { Timestamp } = h.fs;
  assert.deepEqual(await h.server.getAffiliateSummary(h.request({})), { affiliate: null });
  await h.server.claimAffiliateReferral(h.request({ code: 'jane' }, 'f1'));
  await h.server.claimAffiliateReferral(h.request({ code: 'jane' }, 'f2'));
  assert.deepEqual(await h.server.trackAffiliateClick({ data: { code: 'Jane' } }), { counted: true });
  await h.server.trackAffiliateClick({ data: { code: 'jane' } });
  assert.deepEqual(await h.server.trackAffiliateClick({ data: { code: 'nobody' } }), { counted: false });
  h.fs.put('affiliate_clicks/jane_2020-01-01', { code: 'jane', day: '2020-01-01', clicks: 5 });
  h.fs.put('affiliate_commissions/txn_1', { code: 'jane', uid: 'f1', currency: 'USD', netAmount: 4999, rateBps: 1500,
    amount: 749, reversed: 0, paidAmount: 0, adjustmentIds: [], status: 'approved', origin: 'web',
    billedAt: Timestamp.fromMillis(T0), holdUntil: Timestamp.fromMillis(T0) });
  h.fs.put('affiliate_payouts/jane_USD_1', { code: 'jane', currency: 'USD', amount: 1200, commissions: 2,
    paidAt: Timestamp.fromMillis(T0 - DAY) });
  h.fs.put('affiliate_payouts/amy_USD_1', { code: 'amy', currency: 'USD', amount: 99, commissions: 1,
    paidAt: Timestamp.fromMillis(T0) });
  const { affiliate } = await h.server.getAffiliateSummary(h.request({}, 'jane_uid'));
  assert.deepEqual(affiliate, {
    code: 'jane', name: 'Jane', status: 'active', link: 'https://kidocoach.app/?ref=jane', discountCode: 'JANE10',
    payoutEmail: 'jane@example.com', payoutMethod: 'paypal', commissionRateBps: 1500, recurringMonths: 12,
    clicks: 7, clicksLast30Days: 2, signups: 2, payingFamilies: 1,
    earnings: [{ currency: 'USD', pending: 0, approved: 749, paid: 0 }],
    conversions: [{ billedAt: T0, kind: 'first', currency: 'USD', saleAmount: 4999, commission: 749, status: 'approved' }],
    payouts: [{ paidAt: T0 - DAY, currency: 'USD', amount: 1200, commissions: 2 }],
  });
  assert.equal(JSON.stringify(affiliate).includes('f1'), false, 'no family identifiers');
});

test('anyone signed in can pick their own partner code once, on the default terms', async () => {
  const h = serverHarness();
  const join = (data, uid = 'dan_uid', ...rest) => h.server.createAffiliateAccount(h.request(data, uid, 'google', 'dan@example.com', ...rest));
  const ok = { code: 'DanBlog', name: ' Dan  Blog ', acceptTerms: true };
  await assert.rejects(h.server.createAffiliateAccount(h.request(ok, 'guest', 'anonymous')), { code: 'unauthenticated' });
  await assert.rejects(h.server.createAffiliateAccount(h.request(ok, 'x', 'password', null)), { code: 'failed-precondition' });
  assert.deepEqual(await join({ ...ok, code: 'a b' }), { status: 'invalid_code' });
  assert.deepEqual(await join({ ...ok, code: 'KidoCoach-Deals' }), { status: 'reserved_code' });
  assert.deepEqual(await join({ ...ok, code: 'support' }), { status: 'reserved_code' });
  assert.deepEqual(await join({ ...ok, name: '<b>' }), { status: 'invalid_name' });
  assert.deepEqual(await join({ ...ok, payoutEmail: 'nope' }), { status: 'invalid_payout_email' });
  assert.deepEqual(await join({ ...ok, payoutMethod: 'cash' }), { status: 'invalid_payout_method' });
  assert.deepEqual(await join({ ...ok, acceptTerms: 'yes' }), { status: 'terms_required' });
  assert.deepEqual(await join({ ...ok, code: 'jane' }), { status: 'code_taken' });

  assert.deepEqual(await h.server.checkAffiliateCode(h.request({ code: 'DanBlog' }, 'dan_uid')), { available: true, code: 'danblog' });
  assert.deepEqual(await join(ok), { status: 'created', code: 'danblog' });
  assert.deepEqual(await h.server.checkAffiliateCode(h.request({ code: 'danblog' })), { available: false, reason: 'code_taken' });
  const partner = h.fs.read('affiliates/danblog');
  assert.deepEqual(model.parseAffiliate('danblog', partner), {
    code: 'danblog', name: 'Dan Blog', email: 'dan@example.com', status: 'active', commissionRateBps: 1500,
    recurringMonths: 12, ownerUid: 'dan_uid', discountCode: null,
  });
  assert.equal(partner.payoutEmail, 'dan@example.com');
  assert.equal(partner.payoutMethod, 'paypal', 'PayPal unless the partner picks Wise');
  assert.equal(partner.source, 'self_serve');
  assert.deepEqual(await join({ ...ok, code: 'second' }), { status: 'already_partner' });
  assert.equal(h.fs.read('affiliates/second'), undefined);
  assert.deepEqual(await join(ok, 'jane_uid'), { status: 'already_partner' }, 'admin-created owners can not add a second code');

  // The new partner can't refer themselves, but a stranger can be referred right away.
  assert.deepEqual(await h.server.claimAffiliateReferral(h.request({ code: 'danblog' }, 'dan_uid')), { status: 'self_referral' });
  assert.deepEqual(await h.server.claimAffiliateReferral(h.request({ code: 'danblog' }, 'fam')), { status: 'claimed' });

  await h.server.updateAffiliateSettings(h.request({ payoutEmail: 'Bank@Dan.com', name: 'Dan', payoutMethod: 'Wise' }, 'dan_uid'));
  const updated = h.fs.read('affiliates/danblog');
  assert.deepEqual([updated.payoutEmail, updated.name, updated.payoutMethod], ['bank@dan.com', 'Dan', 'wise']);
  assert.equal((await h.server.getAffiliateSummary(h.request({}, 'dan_uid'))).affiliate.payoutMethod, 'wise');
  await assert.rejects(h.server.updateAffiliateSettings(h.request({ payoutMethod: 'cash' }, 'dan_uid')), { code: 'invalid-argument' });
  await assert.rejects(h.server.updateAffiliateSettings(h.request({ payoutEmail: 'x' }, 'dan_uid')), { code: 'invalid-argument' });
  await assert.rejects(h.server.updateAffiliateSettings(h.request({ commissionRateBps: 5000 }, 'dan_uid')), { code: 'invalid-argument' });
  await assert.rejects(h.server.updateAffiliateSettings(h.request({ name: 'Mallory' }, 'fam')), { code: 'permission-denied' });

  await h.server.deleteAffiliateAttribution('dan_uid');
  assert.deepEqual([h.fs.read('affiliates/danblog').status, h.fs.read('affiliates/danblog').ownerUid], ['disabled', null]);
  assert.equal(h.fs.read('affiliate_owners/dan_uid'), undefined);
  assert.deepEqual(await h.server.checkAffiliateCode(h.request({ code: 'danblog' })), { available: false, reason: 'code_taken' });
});

test('website keeps the first unexpired partner link and clears it once the server answers', async () => {
  const entries = new Map();
  const calls = [];
  let reply = { status: 'claimed' };
  const storage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
  const source = fs.readFileSync(path.join(root, 'website/src/services/referral.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'localStorage', compiled)((id) => {
    if (id === 'firebase/functions') {
      return { httpsCallable: (_f, name) => async (data) => {
        calls.push({ name, data });
        if (reply instanceof Error) throw reply;
        return { data: reply };
      } };
    }
    if (id === './firebase') return { functions: {} };
    throw new Error(id);
  }, module, module.exports, storage);
  const referral = module.exports;

  assert.deepEqual(referral.parseReferral('?ref=Jane_Blog', 5), { code: 'jane_blog', capturedAt: 5 });
  assert.equal(referral.parseReferral('?ref=%3Cx%3E'), null);
  assert.equal(referral.parseReferral('?coupon=SAVE'), null);
  referral.captureReferral('?ref=jane');
  referral.captureReferral('?ref=amy');
  assert.equal(referral.readReferral().code, 'jane');
  assert.equal(referral.readReferral(Date.now() + 61 * DAY), null);

  reply = new Error('offline');
  await assert.rejects(referral.claimSavedReferral(), /offline/);
  assert.equal(referral.readReferral().code, 'jane', 'kept for a retry');
  reply = { status: 'already_attributed' };
  assert.equal(await referral.claimSavedReferral(), 'already_attributed');
  assert.deepEqual(calls.at(-1), { name: 'claimAffiliateReferral', data: { code: 'jane' } });
  assert.equal(referral.readReferral(), null);
  assert.equal(await referral.claimSavedReferral(), null);
  assert.equal(calls.length, 2);

  reply = { counted: true };
  referral.trackReferralClick('?ref=Amy', T0);
  referral.trackReferralClick('?ref=amy', T0 + 1000);
  referral.trackReferralClick('?coupon=SAVE', T0);
  referral.trackReferralClick('?ref=amy', T0 + DAY);
  assert.deepEqual(calls.slice(2), [
    { name: 'trackAffiliateClick', data: { code: 'amy' } },
    { name: 'trackAffiliateClick', data: { code: 'amy' } },
  ], 'one click per browser, code and day');
});
