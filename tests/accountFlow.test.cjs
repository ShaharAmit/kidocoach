const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.dirname(require.resolve('../package.json'));

// Exercise the actual TypeScript services without loading native modules in Node.
function loader(mocks = {}) {
  const cache = new Map();
  function load(filename) {
    const absolute = path.resolve(root, filename);
    if (absolute in mocks) return mocks[absolute];
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const localRequire = (id) => {
      if (id in mocks) return mocks[id];
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(absolute), id);
        if (base === path.join(root, 'theme')) return { colors: load('theme/colors.ts').colors };
        const resolved = [base + '.ts', base + '.tsx', path.join(base, 'index.ts')]
          .find((candidate) => fs.existsSync(candidate));
        if (!resolved) throw new Error(`Cannot resolve ${id} from ${filename}`);
        return load(resolved);
      }
      throw new Error(`Unexpected dependency: ${id}`);
    };
    new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
    return module.exports;
  }
  return load;
}

function family(userId = 'guest') {
  return {
    userId, childName: 'Liam', age: 7, gender: 'boy', avatarId: 'becky',
    voice: 'woman', tone: 'calm', scheduledTime: '08:00',
    activityStack: [['brush_teeth'], ['get_dressed']], stepTimes: ['08:00', '08:05'],
    answers: { motivationStyle: 'autonomy_choose', helpLevel: 'little_push' },
    totalStarsEarned: 12, updatedAt: 123, showCaptions: true, birthDate: '2019-01-01',
  };
}

function harness(extraMocks = {}) {
  const items = new Map();
  const auth = { currentUser: { uid: 'guest', isAnonymous: true }, authStateReady: async () => {} };
  const state = { remote: null, remoteError: null, writes: [], cancelled: [], scheduled: [], links: [], calls: [] };
  const storage = {
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => { items.set(key, value); },
    removeItem: async (key) => { items.delete(key); },
    getAllKeys: async () => [...items.keys()],
    removeMany: async (keys) => { keys.forEach((key) => items.delete(key)); },
  };
  const snapshot = () => {
    if (state.remoteError) throw state.remoteError;
    return { exists: () => state.remote !== null, data: () => state.remote };
  };
  const mocks = {
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
    [path.join(root, 'services/firebase.ts')]: {
      auth, db: {}, functions: {}, ensureAuth: async () => auth.currentUser,
    },
    'firebase/functions': {
      httpsCallable: (_functions, name) => async (data) => {
        state.calls.push({ name, data });
        const error = state.callableErrors?.[name]?.shift();
        if (error) throw error;
        return { data: {} };
      },
    },
    'firebase/firestore': {
      doc: (_db, ...segments) => segments.join('/'),
      getDoc: async () => snapshot(), getDocFromServer: async () => snapshot(),
      setDoc: async (ref, data, options) => {
        state.writes.push({ ref, data, options });
        state.remote = data;
      },
    },
    'expo-notifications': {
      getAllScheduledNotificationsAsync: async () => [
        { identifier: 'routine-old', content: { data: { routineId: 'morning' } } },
        { identifier: 'trial', content: { data: {} } },
      ],
      cancelScheduledNotificationAsync: async (id) => { state.cancelled.push(id); },
    },
    [path.join(root, 'services/homeBootstrap.ts')]: {
      clearHomeBootstrap: () => { state.bootstrapCleared = true; },
      primeHomeBootstrap: async (uid) => ({
        routines: [{ id: 'morning', userId: uid, notificationId: 'other-device' }],
      }),
    },
    [path.join(root, 'services/notifications.ts')]: {
      scheduleRoutineNotification: async (routine) => { state.scheduled.push(routine); return 'new-device'; },
    },
    'react-native': { Platform: { OS: 'android' }, TurboModuleRegistry: { get: () => null } },
    'expo-constants': { __esModule: true, default: {}, ExecutionEnvironment: { StoreClient: 'storeClient' } },
    'expo-apple-authentication': { isAvailableAsync: async () => false },
    'expo-crypto': {},
    'firebase/auth': {
      EmailAuthProvider: { credential: (email, password) => ({ email, password }) },
      linkWithCredential: async (user, credential) => {
        if (state.linkError) throw state.linkError;
        state.links.push(credential);
        user.isAnonymous = false;
        return { user };
      },
      signInWithEmailAndPassword: async (_auth, email) => {
        auth.currentUser = { uid: 'linked', isAnonymous: false, email };
        return { user: auth.currentUser };
      },
      signOut: async () => { auth.currentUser = null; },
      sendPasswordResetEmail: async (_auth, email) => { state.resetEmail = email; },
    },
    ...extraMocks,
  };
  return { auth, items, state, load: loader(mocks) };
}

test('access matrix keeps purchase access independent of child setup', () => {
  const { getAccessRoute } = loader()('utils/accessRoute.ts');
  assert.equal(getAccessRoute(false, false), '/onboarding/welcome');
  assert.equal(getAccessRoute(false, true), '/paywall');
  assert.equal(getAccessRoute(true, true), '/');
  assert.equal(getAccessRoute(true, false), '/onboarding/questionnaire');
});

test('complete profiles round-trip and reject invalid or foreign cloud data', () => {
  const { normalizeChildProfile } = loader()('utils/childProfile.ts');
  const profile = family();
  assert.deepEqual(normalizeChildProfile(profile), profile);
  assert.deepEqual(normalizeChildProfile({
    ...profile, activityStack: profile.activityStack.map((activities) => ({ activities })),
  }, 'guest'), profile);
  for (const invalid of [
    { ...profile, userId: 'someone-else' }, { ...profile, age: NaN },
    { ...profile, scheduledTime: '25:00' }, { ...profile, stepTimes: ['bad'] },
    { ...profile, activityStack: [['unknown']] }, { ...profile, activityStack: [] },
    { ...profile, answers: { helpLevel: 'bad' } }, { ...profile, gender: undefined },
  ]) assert.equal(normalizeChildProfile(invalid, 'guest'), null);
});

test('backup stores every setup field using Firestore-compatible activity maps', async () => {
  const { load, state } = harness();
  const profiles = load('services/profile.ts');
  await profiles.saveUserProfileDoc(family());
  const saved = state.writes[0];
  assert.equal(saved.ref, 'users/guest');
  assert.deepEqual(saved.data.childProfile.activityStack, [
    { activities: ['brush_teeth'] }, { activities: ['get_dressed'] },
  ]);
  assert.deepEqual(saved.data.childProfile.answers, family().answers);
  assert.ok(saved.options.mergeFields.includes('childProfile'));
  assert.deepEqual(await profiles.recoverChildProfile('guest'), family());
});

test('local setup is hidden after switching Firebase users or signing out', async () => {
  const { load, auth } = harness();
  const profiles = load('services/profile.ts');
  await profiles.saveChildProfile(family());
  assert.equal((await profiles.getChildProfile()).userId, 'guest');
  auth.currentUser = { uid: 'linked', isAnonymous: false };
  assert.equal(await profiles.getChildProfile(), null);
  await assert.rejects(profiles.saveChildProfile(family()), /family account changed/);
  await assert.rejects(profiles.saveUserProfileDoc(family()), /family account/);
  auth.currentUser = null;
  assert.equal(await profiles.getChildProfile(), null);
});

test('missing legacy profile requires setup, but network failures propagate', async () => {
  const { load, state } = harness();
  const profiles = load('services/profile.ts');
  state.remote = { childName: 'Liam', age: 7 };
  assert.equal(await profiles.recoverChildProfile('guest'), null);
  state.remoteError = new Error('offline');
  await assert.rejects(profiles.recoverChildProfile('guest'), /offline/);
});

test('account recovery clears shared completions and recreates device-local reminders only', async () => {
  const { load, auth, items, state } = harness();
  auth.currentUser = { uid: 'linked', isAnonymous: false };
  state.remote = { childProfile: {
    ...family('linked'), activityStack: family().activityStack.map((activities) => ({ activities })),
  } };
  items.set('child_profile_v1', JSON.stringify(family()));
  items.set('daily_completion_morning', 'old family progress');
  items.set('paid_status_v2', '1');
  const session = load('services/accountSession.ts');
  assert.equal(await session.recoverSignedInFamily(), true);
  assert.deepEqual(state.cancelled, ['routine-old']);
  assert.equal(items.has('daily_completion_morning'), false);
  assert.equal(items.get('paid_status_v2'), '1');
  assert.equal(JSON.parse(items.get('child_profile_v1')).userId, 'linked');
  assert.equal(state.scheduled[0].notificationId, undefined);
  assert.equal(state.writes.length, 0);
});

test('offline same-account recovery preserves the usable local setup and reminders', async () => {
  const { load, auth, items, state } = harness();
  auth.currentUser.isAnonymous = false;
  items.set('child_profile_v1', JSON.stringify(family()));
  items.set('daily_completion_morning', 'current progress');
  state.remoteError = new Error('offline');
  await assert.rejects(load('services/accountSession.ts').recoverSignedInFamily(), /offline/);
  assert.deepEqual(JSON.parse(items.get('child_profile_v1')), family());
  assert.equal(items.get('daily_completion_morning'), 'current progress');
  assert.deepEqual(state.cancelled, []);
});

test('failed cross-account recovery isolates the previous family without clearing paid access', async () => {
  const { load, auth, items, state } = harness();
  auth.currentUser = { uid: 'linked', isAnonymous: false };
  items.set('child_profile_v1', JSON.stringify(family()));
  items.set('daily_completion_morning', 'old family progress');
  items.set('paid_status_v2', '1');
  state.remoteError = new Error('offline');
  await assert.rejects(load('services/accountSession.ts').recoverSignedInFamily(), /offline/);
  assert.equal(items.has('child_profile_v1'), false);
  assert.equal(items.has('daily_completion_morning'), false);
  assert.equal(items.get('paid_status_v2'), '1');
  assert.deepEqual(state.cancelled, ['routine-old']);
});

test('reminder replacement cancels device-local IDs, not cloud IDs or another family', async () => {
  let notifications = [
    { identifier: 'local-old', content: { data: { routineId: 'morning', userId: 'guest' } } },
    { identifier: 'foreign-id', content: { data: { routineId: 'morning', userId: 'other' } } },
    { identifier: 'trial', content: { data: {} } },
  ];
  const cancelled = [];
  let sequence = 0;
  const load = loader({
    'react-native': { Platform: { OS: 'ios' } },
    'expo-device': { isDevice: false },
    'expo-notifications': {
      setNotificationHandler: () => {},
      SchedulableTriggerInputTypes: { DAILY: 'daily' },
      getAllScheduledNotificationsAsync: async () => [...notifications],
      cancelScheduledNotificationAsync: async (id) => {
        cancelled.push(id);
        notifications = notifications.filter((entry) => entry.identifier !== id);
      },
      scheduleNotificationAsync: async ({ content }) => {
        const identifier = `new-${++sequence}`;
        notifications.push({ identifier, content });
        return identifier;
      },
    },
  });
  const service = load('services/notifications.ts');
  const routine = {
    id: 'morning', userId: 'guest', childName: 'Liam', scheduledTime: '08:00',
    activityStack: [['wake_up']], notificationId: 'foreign-id',
  };
  assert.equal(await service.scheduleRoutineNotification(routine), 'new-1');
  assert.equal(await service.scheduleRoutineNotification({ ...routine, scheduledTime: '09:00' }), 'new-2');
  assert.deepEqual(cancelled, ['local-old', 'new-1']);
  assert.deepEqual(notifications.map((entry) => entry.identifier), ['foreign-id', 'trial', 'new-2']);
  assert.equal(notifications[2].content.data.userId, 'guest');
});

test('registration links the guest UID; conflicts never switch accounts', async () => {
  const { load, auth, state } = harness();
  const accounts = load('services/accountAuth.ts');
  const user = await accounts.registerParentWithEmail(' parent@example.com ', ' secret ');
  assert.equal(user.uid, 'guest');
  assert.deepEqual(state.links[0], { email: 'parent@example.com', password: ' secret ' });
  await assert.rejects(accounts.registerParentWithEmail('again@example.com', 'secret'));
  auth.currentUser = { uid: 'guest-2', isAnonymous: true };
  state.linkError = { code: 'auth/email-already-in-use' };
  await assert.rejects(accounts.registerParentWithEmail('used@example.com', 'secret'));
  assert.equal(auth.currentUser.uid, 'guest-2');
  assert.equal(auth.currentUser.isAnonymous, true);
  assert.match(accounts.getAccountErrorMessage(state.linkError), /has not been moved/);
});

test('explicit login switches identity and password reset normalizes email', async () => {
  const { load, auth, state } = harness();
  const accounts = load('services/accountAuth.ts');
  await accounts.loginParentWithEmail(' parent@example.com ', 'secret');
  assert.equal(auth.currentUser.uid, 'linked');
  await accounts.resetParentPassword(' parent@example.com ');
  assert.equal(state.resetEmail, 'parent@example.com');
  await accounts.signOutParent();
  assert.equal(auth.currentUser, null);
  assert.deepEqual(await accounts.getAvailableAccountProviders(), []);
});

function appleMocks(state, auth, { authorizationCode = 'apple-code' } = {}) {
  return {
    'react-native': { Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } },
    'expo-apple-authentication': {
      isAvailableAsync: async () => true,
      AppleAuthenticationScope: { EMAIL: 1 },
      signInAsync: async (options) => {
        state.appleSheets = (state.appleSheets ?? 0) + 1;
        return { identityToken: 'id-token', authorizationCode, options };
      },
    },
    'expo-crypto': {
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      getRandomBytesAsync: async (count) => new Uint8Array(count),
      digestStringAsync: async (_algorithm, value) => `hash(${value})`,
    },
    'firebase/auth': {
      OAuthProvider: class { credential(value) { return value; } },
      signInWithCredential: async () => {
        auth.currentUser = { uid: 'apple-parent', isAnonymous: false, providerData: [{ providerId: 'apple.com' }] };
        return { user: auth.currentUser };
      },
      revokeAccessToken: async (_auth, code) => { state.revokedCodes = [...(state.revokedCodes ?? []), code]; },
      signOut: async () => { auth.currentUser = null; },
    },
  };
}

test('Apple sign-in hands the one-time authorization code to the backend for later revocation', async () => {
  const state = { calls: [] };
  const auth = { currentUser: { uid: 'guest', isAnonymous: true } };
  const { load, state: harnessState } = harness(appleMocks(state, auth));
  const accounts = load('services/accountAuth.ts');
  const user = await accounts.loginParentProvider('apple');
  assert.equal(user.uid, 'apple-parent');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harnessState.calls, [
    { name: 'registerAppleAuthorization', data: { authorizationCode: 'apple-code' } },
  ]);
});

function deletionHarness() {
  const appleState = {};
  const auth = {
    currentUser: { uid: 'apple-parent', isAnonymous: false, providerData: [{ providerId: 'apple.com' }] },
  };
  const h = harness({
    ...appleMocks(appleState, auth),
    [path.join(root, 'services/firebase.ts')]: { auth, functions: {}, ensureAuth: async () => auth.currentUser },
    '@react-native-async-storage/async-storage': { __esModule: true, default: { clear: async () => {} } },
    'expo-notifications': { cancelAllScheduledNotificationsAsync: async () => {} },
    [path.join(root, 'services/accountSession.ts')]: { clearLocalFamilySession: async () => {} },
    [path.join(root, 'services/assetCacheService.ts')]: { clearAllLocalCachedAssets: async () => {} },
    [path.join(root, 'services/purchases.ts')]: { logOutPurchasesUser: async () => {} },
    [path.join(root, 'services/subscription.ts')]: { setPaidStatus: async () => {} },
  });
  h.appleState = appleState;
  return h;
}

test('account deletion relies on server-side Apple revocation without prompting', async () => {
  const { load, state, appleState } = deletionHarness();
  await load('services/accountDeletion.ts').deleteFamilyAccount();
  assert.deepEqual(state.calls, [{ name: 'deleteAccount', data: {} }]);
  assert.equal(appleState.appleSheets, undefined);
});

test('account deletion falls back to one Apple prompt only when the server cannot revoke', async () => {
  const { load, state, appleState } = deletionHarness();
  state.callableErrors = {
    deleteAccount: [{ code: 'functions/failed-precondition', details: { reason: 'apple-reauth-required' } }],
  };
  await load('services/accountDeletion.ts').deleteFamilyAccount();
  assert.equal(appleState.appleSheets, 1);
  assert.deepEqual(appleState.revokedCodes, ['apple-code']);
  assert.deepEqual(state.calls, [
    { name: 'deleteAccount', data: {} },
    { name: 'deleteAccount', data: { appleTokenRevoked: true } },
  ]);

  const other = deletionHarness();
  other.state.callableErrors = { deleteAccount: [{ code: 'functions/unavailable' }] };
  await assert.rejects(other.load('services/accountDeletion.ts').deleteFamilyAccount());
  assert.equal(other.appleState.appleSheets, undefined);
});

test('anonymous auth initialization is single-flight and preserves a restored parent identity', async () => {
  let signIns = 0;
  const auth = { currentUser: null, authStateReady: async () => {} };
  const app = {};
  const load = loader({
    'firebase/app': { getApps: () => [], initializeApp: () => app },
    'firebase/firestore': { getFirestore: () => ({}) },
    'firebase/storage': { getStorage: () => ({}) },
    'firebase/functions': { getFunctions: () => ({}) },
    '@react-native-async-storage/async-storage': { createAsyncStorage: () => ({}) },
    'firebase/auth': {
      initializeAuth: () => auth,
      signInAnonymously: async () => {
        signIns += 1;
        await Promise.resolve();
        auth.currentUser = { uid: 'guest', isAnonymous: true };
        return { user: auth.currentUser };
      },
    },
  });
  const { ensureAuth } = load('services/firebase.ts');
  const users = await Promise.all([ensureAuth(), ensureAuth(), ensureAuth()]);
  assert.equal(signIns, 1);
  assert.ok(users.every((user) => user.uid === 'guest'));
  auth.currentUser = { uid: 'parent', isAnonymous: false };
  assert.equal((await ensureAuth()).uid, 'parent');
  assert.equal(signIns, 1);
});
