const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function loadSource(filename, mocks = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, filename), 'utf8'), {
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

const model = loadSource('functions/src/earlyAccessModel.ts');
const SERVER_TIME = { serverTimestamp: true };
const DELETE = { deleteField: true };

function harness() {
  const docs = new Map();
  const apply = (pathname, data, merge) => {
    const next = { ...(merge ? docs.get(pathname) : {}), ...data };
    for (const [key, value] of Object.entries(next)) {
      if (value === DELETE) delete next[key];
      else if (value === SERVER_TIME) next[key] = 'now';
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        next[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v === SERVER_TIME ? 'now' : v]));
      }
    }
    docs.set(pathname, next);
  };
  const db = {
    collection: (name) => ({ doc: (id) => ({ id, path: `${name}/${id}` }) }),
    runTransaction: async (fn) => {
      const writes = [];
      const result = await fn({
        get: async (ref) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        create: (ref, data) => writes.push(() => {
          if (docs.has(ref.path)) throw new Error('already exists');
          apply(ref.path, data, false);
        }),
        set: (ref, data) => writes.push(() => apply(ref.path, data, false)),
        update: (ref, data) => writes.push(() => apply(ref.path, data, true)),
        delete: (ref) => writes.push(() => docs.delete(ref.path)),
      });
      writes.forEach((write) => write());
      return result;
    },
  };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const server = loadSource('functions/src/earlyAccess.ts', {
    './earlyAccessModel': model,
    'firebase-admin': { firestore: () => db },
    'firebase-admin/firestore': { FieldValue: { serverTimestamp: () => SERVER_TIME, delete: () => DELETE } },
    'firebase-functions/v2/https': { onCall: (_options, handler) => handler, HttpsError },
  });
  const submit = (email, consentVersion) => server.submitEarlyAccessLead({ data: { email, consentVersion } });
  const prefs = (data) => server.updateEarlyAccessPreference({ data });
  return { docs, submit, prefs };
}

const idOf = (email) => crypto.createHash('sha256').update(email).digest('hex');

test('a sign-up stores proof of consent and a preference token, never twice', async () => {
  const h = harness();
  assert.deepEqual(await h.submit(' Parent@Example.com ', 'early_access_v1'), { status: 'created' });
  const lead = h.docs.get(`early_access/${idOf('parent@example.com')}`);
  assert.equal(lead.email, 'parent@example.com');
  assert.deepEqual(lead.consent, { version: 'early_access_v1', purpose: 'launch_updates', method: 'signup_form', grantedAt: 'now' });
  assert.match(lead.unsubscribeToken, /^[a-f0-9]{32}$/);
  assert.deepEqual(await h.submit('parent@example.com', 'early_access_v1'), { status: 'exists' });
  assert.equal(h.docs.get(`early_access/${idOf('parent@example.com')}`).unsubscribeToken, lead.unsubscribeToken);
  await assert.rejects(h.submit('not-an-email', 'early_access_v1'), { code: 'invalid-argument' });
  await h.submit('old@example.com', 'bad version!');
  assert.equal(h.docs.get(`early_access/${idOf('old@example.com')}`).consent, undefined, 'unknown wording is not consent');
});

test('unsubscribe deletes the address, keeps a suppression hash and answers the same for bad links', async () => {
  const h = harness();
  await h.submit('parent@example.com', 'early_access_v1');
  const id = idOf('parent@example.com');
  const token = h.docs.get(`early_access/${id}`).unsubscribeToken;

  assert.deepEqual(await h.prefs({ id, token: '0'.repeat(32), action: 'unsubscribe' }), { status: 'invalid' });
  assert.deepEqual(await h.prefs({ id: idOf('nobody@example.com'), token, action: 'unsubscribe' }), { status: 'invalid' });
  assert.deepEqual(await h.prefs({ id: 'x', token, action: 'unsubscribe' }), { status: 'invalid' });
  assert.ok(h.docs.get(`early_access/${id}`).email, 'bad links change nothing');

  assert.deepEqual(await h.prefs({ id, token, action: 'unsubscribe' }), { status: 'unsubscribed' });
  assert.deepEqual(h.docs.get(`early_access/${id}`), { emailHash: id, unsubscribeToken: token, unsubscribedAt: 'now' });
  assert.deepEqual(await h.prefs({ id, token, action: 'unsubscribe' }), { status: 'unsubscribed' }, 'idempotent');
  assert.deepEqual(await h.prefs({ id, token, action: 'confirm' }), { status: 'unsubscribed' }, 'cannot confirm after opting out');
  assert.equal(model.exportRow(id, h.docs.get(`early_access/${id}`)), null);

  // Signing up again with the consent notice is a fresh opt-in.
  await h.submit('parent@example.com', 'early_access_v1');
  const back = h.docs.get(`early_access/${id}`);
  assert.equal(back.email, 'parent@example.com');
  assert.equal(back.unsubscribedAt, undefined);
  assert.equal(back.consent.method, 'signup_form');
});

test('confirm links give double opt-in and re-confirm leads collected before the notice', async () => {
  const h = harness();
  const id = idOf('legacy@example.com');
  h.docs.set(`early_access/${id}`, { email: 'legacy@example.com', emailHash: id, unsubscribeToken: 'a'.repeat(32) });
  assert.equal(model.isMailable(h.docs.get(`early_access/${id}`)), false, 'legacy leads are not mailable');
  assert.equal(model.exportRow(id, h.docs.get(`early_access/${id}`)).needs_reconfirm, 'yes');

  assert.deepEqual(await h.prefs({ id, token: 'a'.repeat(32), action: 'confirm', consentVersion: 'early_access_confirm_v1' }),
    { status: 'confirmed' });
  const lead = h.docs.get(`early_access/${id}`);
  assert.equal(lead.confirmedAt, 'now');
  assert.deepEqual(lead.consent, { version: 'early_access_confirm_v1', purpose: 'launch_updates', method: 'email_link', grantedAt: 'now' });
  assert.equal(model.isMailable(lead), true);

  // A legacy lead that signs up again through the form gets the form consent and a token.
  const other = idOf('other@example.com');
  h.docs.set(`early_access/${other}`, { email: 'other@example.com', emailHash: other });
  await h.submit('other@example.com', 'early_access_v1');
  assert.equal(h.docs.get(`early_access/${other}`).consent.version, 'early_access_v1');
  assert.match(h.docs.get(`early_access/${other}`).unsubscribeToken, /^[a-f0-9]{32}$/);
});

test('exports carry preference links and are safe to open in a spreadsheet', () => {
  const id = idOf('parent@example.com');
  const row = model.exportRow(id, {
    email: 'parent@example.com', unsubscribeToken: 'b'.repeat(32), consent: { version: 'early_access_v1' }, confirmedAt: 'now',
  });
  assert.equal(row.unsubscribe_url, `https://kidocoach.app/email-preferences?id=${id}&t=${'b'.repeat(32)}&action=unsubscribe`);
  assert.equal(row.confirmed, 'yes');
  assert.equal(model.toCsv([{ email: '=HYPERLINK("x")', n: 'a,b' }]), 'email,n\n"\'=HYPERLINK(""x"")","a,b"\n');
});
