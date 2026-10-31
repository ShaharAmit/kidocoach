const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { createElement } = require('../website/node_modules/react');
const { renderToStaticMarkup } = require('../website/node_modules/react-dom/server');

function load(relativePath, mocks) {
  const file = path.resolve(__dirname, '..', relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`Unexpected dependency: ${id}`);
  }, module, module.exports);
  return module.exports;
}

function harness() {
  const auth = { currentUser: null };
  const calls = [];
  class Provider {
    constructor(id) {
      this.providerId = id;
      this.scopes = [];
    }
    addScope(scope) { this.scopes.push(scope); }
    setCustomParameters(parameters) { this.parameters = parameters; }
  }
  class GoogleProvider extends Provider {
    constructor() { super('google.com'); }
  }
  let failure;
  const user = { uid: 'same-parent-as-mobile' };
  const service = load('website/src/services/accountAuth.ts', {
    './firebase': { auth },
    'firebase/auth': {
      GoogleAuthProvider: GoogleProvider,
      OAuthProvider: Provider,
      signInWithPopup: async (instance, provider) => {
        calls.push({ instance, provider });
        if (failure) throw failure;
        return { user };
      },
    },
  });
  return { service, auth, calls, user, fail: (error) => { failure = error; } };
}

test('Google sign-in uses the shared Firebase auth and lets parents choose an account', async () => {
  const h = harness();
  assert.equal((await h.service.signInWithProvider('google')).user, h.user);
  assert.equal(h.calls[0].instance, h.auth);
  assert.equal(h.calls[0].provider.providerId, 'google.com');
  assert.deepEqual(h.calls[0].provider.parameters, { prompt: 'select_account' });
});

test('Apple sign-in requests email and name through the shared Firebase auth', async () => {
  const h = harness();
  assert.equal((await h.service.signInWithProvider('apple')).user, h.user);
  assert.equal(h.calls[0].instance, h.auth);
  assert.equal(h.calls[0].provider.providerId, 'apple.com');
  assert.deepEqual(h.calls[0].provider.scopes, ['email', 'name']);
});

test('provider failures reach the UI without falling back to a different account', async () => {
  const h = harness();
  const failure = Object.assign(new Error('cancelled'), { code: 'auth/popup-closed-by-user' });
  h.fail(failure);
  await assert.rejects(h.service.signInWithProvider('apple'), (error) => error === failure);
  assert.equal(h.calls.length, 1);
});

test('auth errors explain setup, cancellation, network and credential problems without raw errors', () => {
  const { service } = harness();
  for (const code of [
    'auth/invalid-credential', 'auth/email-already-in-use',
    'auth/account-exists-with-different-credential', 'auth/popup-blocked',
    'auth/popup-closed-by-user', 'auth/unauthorized-domain', 'auth/operation-not-allowed',
    'auth/network-request-failed', 'auth/weak-password', 'auth/unknown-error',
  ]) {
    const message = service.getAuthErrorMessage({ code });
    assert.equal(typeof message, 'string', code);
    assert.ok(message.length > 15, code);
    assert.ok(!message.includes('auth/'), code);
  }
  assert.match(service.getAuthErrorMessage({ code: 'auth/account-exists-with-different-credential' }),
    /original method.*not automatically merged/);
  assert.equal(service.getAuthErrorMessage(new Error('billing error')), null);
  assert.equal(service.getAuthErrorMessage(null), null);
});

test('provider buttons contain local decorative logos, labels, and busy-state protection', () => {
  const Button = load('website/src/components/ProviderSignInButton.tsx', {
    'react/jsx-runtime': require('../website/node_modules/react/jsx-runtime'),
  }).default;
  for (const provider of ['google', 'apple']) {
    const html = renderToStaticMarkup(createElement(Button, { provider, disabled: true, onClick() {} }));
    assert.match(html, /type="button"/);
    assert.match(html, /disabled=""/);
    assert.match(html, /<svg[^>]+aria-hidden="true"/);
    assert.match(html, new RegExp(`Continue with ${provider === 'google' ? 'Google' : 'Apple'}`));
    assert.ok(!html.includes('<img'), 'Logos do not require third-party image requests');
    if (provider === 'google') {
      for (const color of ['#EA4335', '#4285F4', '#FBBC05', '#34A853']) assert.ok(html.includes(color));
    }
  }
});

function profileHarness() {
  const slots = [];
  let cursor = 0;
  let resolveSignIn;
  let rejectSignIn;
  let reloads = 0;
  let providerCalls = 0;
  const pending = new Promise((resolve, reject) => {
    resolveSignIn = resolve;
    rejectSignIn = reject;
  });
  // Profile and Partners share this sign-in card.
  const Page = load('website/src/components/SignInCard.tsx', {
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], (value) => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        }];
      },
      useRef(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      },
      useEffect() {},
    },
    'react/jsx-runtime': require('../website/node_modules/react/jsx-runtime'),
    'firebase/auth': {},
    '../services/firebase': { auth: { currentUser: null } },
    './ProviderSignInButton': { default: 'provider-button' },
    '../services/accountAuth': {
      getAuthErrorMessage: harness().service.getAuthErrorMessage,
      signInWithProvider: () => { providerCalls++; return pending; },
    },
  }).default;
  function render() {
    cursor = 0;
    const tree = Page({});
    const elements = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object' || !node.props) return;
      elements.push(node);
      visit(node.props.children);
    }
    visit(tree);
    return elements;
  }
  return {
    render, resolve: resolveSignIn, reject: rejectSignIn,
    reload: () => { reloads++; },
    reloads: () => reloads, providerCalls: () => providerCalls,
  };
}

test('a stuck Apple popup offers enabled cancellation while other actions remain locked', (t) => {
  const h = profileHarness();
  const originalWindow = globalThis.window;
  globalThis.window = { location: { reload: h.reload } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    h.resolve();
  });
  h.render().find((node) => node.props.provider === 'apple').props.onClick();
  const pending = h.render();
  const providers = pending.filter((node) => node.props.provider);
  assert.ok(providers.every((node) => node.props.disabled));
  assert.ok(pending.some((node) => node.props.role === 'status'));
  const cancel = pending.find((node) => node.type === 'button' && node.props.children === 'Cancel sign-in');
  assert.ok(cancel);
  assert.ok(!cancel.props.disabled);
  providers[0].props.onClick();
  assert.equal(h.providerCalls(), 1, 'No overlapping Firebase popup requests');
  cancel.props.onClick();
  assert.equal(h.reloads(), 1, 'Reload discards the pending operation instead of allowing stale retries');
});

test('reported Apple cancellation unlocks the form and removes the recovery button', async () => {
  const h = profileHarness();
  h.render().find((node) => node.props.provider === 'apple').props.onClick();
  h.reject({ code: 'auth/popup-closed-by-user' });
  await new Promise((resolve) => setImmediate(resolve));
  const elements = h.render();
  assert.ok(elements.filter((node) => node.props.provider).every((node) => !node.props.disabled));
  assert.ok(!elements.some((node) => node.props.children === 'Cancel sign-in'));
  assert.ok(elements.some((node) => typeof node.props.children === 'string' &&
    node.props.children.includes('Sign-in was cancelled')));
});
