const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function loadSource(filename, mocks = {}, storage = {}, windowObject = { location: { origin: 'https://kidocoach.app' } }) {
  const source = fs.readFileSync(path.join(root, filename), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'localStorage', 'window', compiled)(
    (id) => {
      if (id in mocks) return mocks[id];
      if (id === 'crypto') return require('node:crypto');
      throw new Error(`Unexpected dependency ${id}`);
    }, module, module.exports, storage, windowObject,
  );
  return module.exports;
}

const model = loadSource('functions/src/billingModel.ts');
const affiliateModel = loadSource('functions/src/affiliateModel.ts');
const DAY = 24 * 60 * 60 * 1000;

test('coupon links are validated, expire after 30 days, and the latest coupon wins', () => {
  const entries = new Map();
  const storage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  const service = loadSource('website/src/services/campaign.ts', {}, storage);
  assert.deepEqual(service.parseCampaign('?coupon=SAVE20', 100), { discountCode: 'SAVE20', capturedAt: 100 });
  assert.equal(service.parseCampaign('?ref=partner&via=partner'), null);
  assert.throws(() => service.parseCampaign('?discount_code=%3Cscript%3E'), /invalid/);
  const campaign = service.parseCampaign('?discount_code=SAVE', 100);
  assert.equal(service.validCampaign(campaign, 99), false);
  assert.equal(service.validCampaign(campaign, 100 + 30 * DAY), false);
  service.captureCampaign('?coupon=OLD');
  service.captureCampaign('?discount_code=NEW');
  assert.equal(service.readCampaign().discountCode, 'NEW');
  entries.set('kidocoach_campaign_v1', JSON.stringify({ affiliate: 'legacy', discountCode: null, capturedAt: 1 }));
  assert.equal(service.readCampaign(), null);
});

test('billing inputs are strictly validated before reaching Paddle', () => {
  assert.equal(model.discountCode(' SAVE20 '), 'SAVE20');
  for (const value of ['../x', 'SAVE-20', 'X'.repeat(33), 7]) assert.equal(model.discountCode(value), null);
  assert.deepEqual(model.parsePriceIds(' pri_01monthly00, pri_01yearly000,,pri_01monthly00 '),
    ['pri_01monthly00', 'pri_01yearly000']);
  assert.throws(() => model.parsePriceIds('pri_01monthly00,price_stripe'), /price_stripe/);
  assert.equal(model.transactionId('txn_01abcdefghij'), 'txn_01abcdefghij');
  assert.equal(model.transactionId('txn_../x'), null);
  assert.equal(model.paddleApiBase('pdl_sdbx_apikey_1'), 'https://sandbox-api.paddle.com');
  assert.equal(model.paddleApiBase('pdl_live_apikey_1'), 'https://api.paddle.com');
  assert.equal(model.isLiveSubscription('canceled'), false);
  assert.equal(model.isLiveSubscription('past_due'), true);
});

test('RevenueCat access is shared across stores, honours grace periods and lifetime grants', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  const payload = (entitlement, store = 'app_store') => ({ subscriber: {
    management_url: 'https://apps.apple.com/account/subscriptions',
    entitlements: { premium: { product_identifier: 'monthly', ...entitlement } },
    subscriptions: { monthly: { store } },
  } });
  assert.deepEqual(model.parseRevenueCatAccess(payload({ expires_date: '2026-11-30T00:00:00Z' }), now), {
    active: true, store: 'app_store', expiresAt: '2026-11-30T00:00:00Z',
    managementUrl: 'https://apps.apple.com/account/subscriptions',
  });
  assert.equal(model.parseRevenueCatAccess(payload({ expires_date: '2026-10-01T00:00:00Z' }), now).active, false);
  assert.equal(model.parseRevenueCatAccess(payload({
    expires_date: '2026-10-29T00:00:00Z', grace_period_expires_date: '2026-11-05T00:00:00Z',
  }, 'play_store'), now).store, 'play_store');
  assert.equal(model.parseRevenueCatAccess(payload({ expires_date: null }, 'promotional'), now).expiresAt, null);
  assert.equal(model.parseRevenueCatAccess(payload({ expires_date: '2026-11-30T00:00:00Z' }, 'weird'), now).store,
    'unknown');
  assert.deepEqual(model.parseRevenueCatAccess(null), model.NO_ACCESS);
});

test('RevenueCat v2 access reads active entitlements and the store of the subscription giving access', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  const customer = (...expires) => ({ active_entitlements: { items: expires.map((e) => ({ entitlement_id: 'e', expires_at: e })) } });
  const subs = { items: [
    { store: 'app_store', gives_access: false, current_period_ends_at: Date.parse('2027-01-01T00:00:00Z') },
    { store: 'paddle', gives_access: true, current_period_ends_at: Date.parse('2026-11-30T00:00:00Z'),
      management_url: 'https://customer-portal.paddle.com/x' },
  ] };
  assert.deepEqual(model.parseRevenueCatV2Access(customer(Date.parse('2026-11-30T00:00:00Z')), subs, now), {
    active: true, store: 'paddle', expiresAt: '2026-11-30T00:00:00.000Z',
    managementUrl: 'https://customer-portal.paddle.com/x',
  });
  assert.equal(model.parseRevenueCatV2Access(customer(Date.parse('2026-10-01T00:00:00Z')), subs, now).active, false);
  assert.deepEqual(model.parseRevenueCatV2Access(customer(null), null, now),
    { active: true, store: 'unknown', expiresAt: null, managementUrl: null });
  assert.deepEqual(model.parseRevenueCatV2Access(customer(), subs, now), model.NO_ACCESS);
  assert.deepEqual(model.parseRevenueCatV2Access(null, null), model.NO_ACCESS);
});

const PRICE = 'pri_01monthly00';
const TXN = 'txn_01abcdefghij';

function backendHarness() {
  const docs = new Map();
  const calls = { transactions: [], receipts: [], cancelled: [], discounts: [], portals: [], affiliates: [] };
  const state = { rcStore: null, subscriptions: [], discount: { id: 'dsc_1' }, transaction: null, affiliateCode: null };
  const docRef = (path) => ({
    path,
    get: async () => ({ exists: docs.has(path), get: (key) => docs.get(path)?.[key] }),
    set: async (value, options) => { docs.set(path, options?.merge ? { ...docs.get(path), ...value } : value); },
    delete: async () => { docs.delete(path); },
  });
  const db = { collection: (name) => ({ doc: (id) => docRef(`${name}/${id}`) }) };
  const rcPayload = (store) => ({ subscriber: store ? {
    entitlements: { premium: { product_identifier: 'p', expires_date: '2999-01-01T00:00:00Z' } },
    subscriptions: { p: { store } },
  } : { entitlements: {} } });
  const ok = (data) => ({ ok: true, json: async () => data });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    if (url.startsWith('https://api.revenuecat.com/v1/receipts')) {
      calls.receipts.push({ headers: init.headers, body: JSON.parse(init.body) });
      return ok(rcPayload('paddle'));
    }
    if (url.startsWith('https://api.revenuecat.com/v2/projects/proj_rc/customers/')) {
      assert.equal(init.headers.Authorization, 'Bearer sk_rc');
      if (!state.rcStore) return { ok: false, status: 404, text: async () => 'not found' };
      if (url.endsWith('/subscriptions')) {
        return ok({ items: [{ store: state.rcStore, gives_access: true, current_period_ends_at: 32503680000000 }] });
      }
      return ok({ active_entitlements: { items: [{ entitlement_id: 'entl', expires_at: 32503680000000 }] } });
    }
    assert.ok(url.startsWith('https://sandbox-api.paddle.com/'), url);
    assert.equal(init.headers.Authorization, 'Bearer pdl_sdbx_apikey_1');
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/prices') {
      return ok({ data: searchParams.get('id').split(',').map((id) => ({
        id, status: 'active', unit_price: { amount: '3999', currency_code: 'USD' },
        billing_cycle: { interval: 'year', frequency: 1 }, trial_period: { interval: 'day', frequency: 7 },
        product: { name: 'KidoCoach Yearly', status: 'active' },
      })) });
    }
    if (pathname === '/subscriptions') {
      return ok({ data: searchParams.get('customer_id') === 'ctm_1' ? state.subscriptions : [] });
    }
    if (pathname === '/discounts') {
      calls.discounts.push(searchParams.get('code'));
      return ok({ data: state.discount ? [state.discount] : [] });
    }
    if (pathname === '/transactions' && method === 'POST') {
      calls.transactions.push(JSON.parse(init.body));
      return ok({ data: { id: TXN } });
    }
    if (pathname.startsWith('/transactions/')) return ok({ data: state.transaction });
    if (pathname.endsWith('/portal-sessions')) {
      calls.portals.push({ pathname, body: JSON.parse(init.body) });
      return ok({ data: { urls: { general: { overview: 'https://customer-portal.paddle.com/1' } } } });
    }
    if (pathname.endsWith('/cancel')) {
      calls.cancelled.push(pathname.split('/')[2]);
      return ok({ data: {} });
    }
    throw new Error(`Unexpected Paddle call ${method} ${url}`);
  };
  const params = {
    PADDLE_SANDBOX_API_KEY: 'pdl_sdbx_apikey_1', REVENUECAT_SECRET_API_KEY: 'sk_rc',
    REVENUECAT_PADDLE_PUBLIC_API_KEY: 'rc_paddle_public', PADDLE_PRICE_IDS: PRICE,
    REVENUECAT_PROJECT_ID: 'proj_rc',
  };
  const handlers = loadSource('functions/src/billing.ts', {
    './billingModel': model,
    './affiliateModel': affiliateModel,
    './affiliates': { resolveCheckoutAffiliate: async (...args) => {
      calls.affiliates.push(args);
      return state.affiliateCode;
    } },
    'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'now' } },
    'firebase-functions/params': {
      defineSecret: (name) => ({ value: () => params[name] }),
      defineString: (name) => ({ value: () => params[name] }),
    },
    'firebase-functions/v2/https': {
      onCall: (_options, handler) => handler,
      HttpsError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    },
  });
  const request = (data = {}, uid = 'family', provider = 'password') => ({
    auth: { uid, token: { email: 'parent@example.test', firebase: { sign_in_provider: provider } } }, data,
  });
  return { handlers, docs, calls, state, request };
}

test('plans come from Paddle prices with product names and trial length', async () => {
  const h = backendHarness();
  const { plans } = await h.handlers.getWebBilling(h.request());
  assert.deepEqual(plans, [{
    priceId: PRICE, name: 'KidoCoach Yearly', amount: 3999, currency: 'usd',
    interval: 'year', intervalCount: 1, trialDays: 7,
  }]);
});

test('checkout is parent-only, sells configured prices, and stamps UID + server-attributed partner code', async () => {
  const h = backendHarness();
  await assert.rejects(h.handlers.createPaddleCheckout({ data: {} }), { code: 'unauthenticated' });
  await assert.rejects(h.handlers.createPaddleCheckout(h.request({}, 'guest', 'anonymous')), { code: 'unauthenticated' });
  await assert.rejects(h.handlers.createPaddleCheckout(h.request({ priceId: 'pri_01otherprice' })),
    { code: 'invalid-argument' });
  h.state.affiliateCode = 'partner_1';
  assert.deepEqual(await h.handlers.createPaddleCheckout(h.request({ priceId: PRICE, referral: 'Partner_1' })),
    { transactionId: TXN });
  assert.deepEqual(h.calls.transactions[0], {
    items: [{ price_id: PRICE, quantity: 1 }],
    custom_data: { app_user_id: 'family', affiliate_code: 'partner_1' },
  });
  assert.deepEqual(h.calls.affiliates[0], ['family', 'parent@example.test', 'Partner_1', null]);
  // The client's referral is only a claim hint: without a server attribution nothing is stamped.
  h.state.affiliateCode = null;
  await h.handlers.createPaddleCheckout(h.request({ priceId: PRICE, referral: 'partner_1' }));
  assert.deepEqual(h.calls.transactions[1].custom_data, { app_user_id: 'family' });
});

test('coupon codes resolve to Paddle discounts; unknown coupons fail before checkout', async () => {
  const h = backendHarness();
  await h.handlers.createPaddleCheckout(h.request({ priceId: PRICE, discountCode: ' SAVE20 ' }));
  assert.deepEqual(h.calls.discounts, ['SAVE20']);
  assert.equal(h.calls.transactions[0].discount_id, 'dsc_1');
  h.state.discount = null;
  await assert.rejects(h.handlers.createPaddleCheckout(h.request({ priceId: PRICE, discountCode: 'GONE' })),
    { code: 'invalid-argument' });
  await assert.rejects(h.handlers.createPaddleCheckout(h.request({ priceId: PRICE, discountCode: '<x>' })),
    { code: 'invalid-argument' });
  assert.equal(h.calls.transactions.length, 1);
});

test('one paying family: any active store subscription blocks a second web purchase', async () => {
  for (const store of ['app_store', 'play_store', 'paddle']) {
    const h = backendHarness();
    h.state.rcStore = store;
    await assert.rejects(h.handlers.createPaddleCheckout(h.request({ priceId: PRICE })), { code: 'already-exists' });
    assert.equal(h.calls.transactions.length, 0);
  }
  const h = backendHarness();
  h.docs.set('billing_customers/family', { paddleCustomerId: 'ctm_1' });
  h.state.subscriptions = [{ id: 'sub_live', status: 'active', custom_data: { app_user_id: 'family' } }];
  await assert.rejects(h.handlers.createPaddleCheckout(h.request({ priceId: PRICE })), { code: 'already-exists' });
  assert.deepEqual(h.calls.receipts[0].body, { app_user_id: 'family', fetch_token: 'sub_live' });
  assert.equal(h.calls.transactions.length, 0);
});

test('a paid checkout is imported into RevenueCat for the same UID only and links the Paddle customer', async () => {
  const h = backendHarness();
  h.state.transaction = { id: TXN, status: 'completed', customer_id: 'ctm_1', subscription_id: 'sub_new',
    custom_data: { app_user_id: 'family' } };
  const { access } = await h.handlers.syncPaddlePurchases(h.request({ transactionId: TXN }));
  assert.equal(access.active, true);
  assert.deepEqual(h.calls.receipts[0].body, { app_user_id: 'family', fetch_token: 'sub_new' });
  assert.equal(h.calls.receipts[0].headers['X-Platform'], 'paddle');
  assert.equal(h.calls.receipts[0].headers.Authorization, 'Bearer rc_paddle_public');
  assert.equal(h.docs.get('billing_customers/family').paddleCustomerId, 'ctm_1');
  h.state.transaction = { ...h.state.transaction, custom_data: { app_user_id: 'other' } };
  await assert.rejects(h.handlers.syncPaddlePurchases(h.request({ transactionId: TXN })), { code: 'permission-denied' });
  await assert.rejects(h.handlers.syncPaddlePurchases(h.request({ transactionId: '../x' })), { code: 'invalid-argument' });
  const stranger = backendHarness();
  assert.equal((await stranger.handlers.syncPaddlePurchases(stranger.request())).access.active, false);
  await assert.rejects(stranger.handlers.createPaddlePortal(stranger.request()), { code: 'failed-precondition' });
});

test('portal and deletion only touch this family\'s subscriptions on a shared Paddle customer', async () => {
  const h = backendHarness();
  await h.handlers.cancelPaddleBilling('family');
  assert.deepEqual(h.calls.cancelled, []);
  h.docs.set('billing_customers/family', { paddleCustomerId: 'ctm_1' });
  h.state.subscriptions = [
    { id: 'sub_mine', status: 'active', custom_data: { app_user_id: 'family' } },
    { id: 'sub_paused', status: 'paused', custom_data: { app_user_id: 'family' } },
    { id: 'sub_other_family', status: 'active', custom_data: { app_user_id: 'other' } },
    { id: 'sub_done', status: 'canceled', custom_data: { app_user_id: 'family' } },
  ];
  assert.deepEqual(await h.handlers.createPaddlePortal(h.request()), { url: 'https://customer-portal.paddle.com/1' });
  assert.deepEqual(h.calls.portals[0].body, { subscription_ids: ['sub_mine', 'sub_paused'] });
  await h.handlers.cancelPaddleBilling('family');
  assert.deepEqual(h.calls.cancelled, ['sub_mine', 'sub_paused']);
  assert.equal(h.docs.has('billing_customers/family'), false);
});

test('website checkout sends the saved referral and trimmed coupon, opens Paddle, never for guests', async () => {
  const calls = [];
  const opened = [];
  const auth = { currentUser: { uid: 'family', isAnonymous: false, email: 'parent@example.test' } };
  const service = loadSource('website/src/services/billing.ts', {
    'firebase/functions': { httpsCallable: (_functions, name) => async (data) => {
      calls.push({ name, data });
      return { data: { transactionId: TXN } };
    } },
    './firebase': { auth, functions: {} },
    './paddle': { openPaddleCheckout: async (id, email) => { opened.push({ id, email }); return id; } },
    './referral': { readReferral: () => ({ code: 'partner_1', capturedAt: 1 }) },
  });
  assert.equal(await service.startCheckout('family', PRICE, ' SAVE20 '), TXN);
  assert.deepEqual(calls[0], { name: 'createPaddleCheckout', data: {
    priceId: PRICE, discountCode: 'SAVE20', referral: 'partner_1',
  } });
  assert.deepEqual(opened, [{ id: TXN, email: 'parent@example.test' }]);
  assert.equal(service.formatPlanPrice({ amount: 3999, currency: 'usd', interval: 'year', intervalCount: 1 }, 'en-US'),
    '$39.99 / year');
  auth.currentUser.isAnonymous = true;
  await assert.rejects(service.startCheckout('family', PRICE, ''), /Sign in/);
  assert.equal(calls.length, 1);
});

test('native access refreshes on foreground, retains paid access offline, and removes listeners', async () => {
  const auth = { currentUser: { uid: 'family' } };
  const values = new Map();
  let foreground;
  let calls = 0;
  let remote = true;
  let removed = false;
  const service = loadSource('services/subscription.ts', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value); },
    } },
    'firebase/auth': { onAuthStateChanged: (_auth, callback) => {
      callback(auth.currentUser);
      return () => {};
    } },
    'react-native': { AppState: { addEventListener: (_event, callback) => {
      foreground = callback; return { remove: () => { removed = true; } };
    } } },
    './firebase': { auth },
    './purchases': {
      initPurchases: async () => {},
      addPremiumEntitlementListener: () => () => {},
      refreshEntitlementFromRevenueCat: async () => { calls++; return remote; },
    },
  });
  const stop = service.startPaidStatusSync();
  assert.equal(service.startPaidStatusSync(), stop);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await service.getPaidStatus(), true);
  remote = null;
  foreground('background');
  assert.equal(calls, 1);
  foreground('active');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await service.getPaidStatus(), true);
  remote = false;
  foreground('active');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await service.getPaidStatus(), false);
  stop();
  assert.equal(removed, true);
});

test('native refresh invalidates positive cached access to pick up cross-platform refunds', async () => {
  let invalidated = false;
  let offline = false;
  const sdk = {
    LOG_LEVEL: { WARN: 'warn' },
    setLogLevel: async () => {},
    configure: () => {},
    getAppUserID: async () => 'family',
    invalidateCustomerInfoCache: async () => { invalidated = true; },
    getCustomerInfo: async () => {
      if (offline) throw new Error('offline');
      return { entitlements: { active: invalidated ? {} : { premium: {} }, all: {} } };
    },
  };
  const auth = { currentUser: { uid: 'family' } };
  const service = loadSource('services/purchases.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    'react-native-purchases': { __esModule: true, default: sdk },
    './firebase': { auth, ensureAuth: async () => auth.currentUser },
  });
  assert.equal(await service.refreshEntitlementFromRevenueCat(), false);
  assert.equal(invalidated, true);
  offline = true;
  assert.equal(await service.refreshEntitlementFromRevenueCat(), null);
});
