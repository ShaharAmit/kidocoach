const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.dirname(require.resolve('../package.json'));

function loadParentalLock({ uid = 'family', remote = null, remoteError = null } = {}) {
  const secure = new Map();
  const state = { remote, remoteError, writes: [], reads: 0 };
  const auth = { currentUser: uid ? { uid } : null, authStateReady: async () => {} };
  const mocks = {
    'expo-secure-store': {
      getItemAsync: async (key) => secure.get(key) ?? null,
      setItemAsync: async (key, value) => { secure.set(key, value); },
      deleteItemAsync: async (key) => { secure.delete(key); },
    },
    'expo-crypto': {
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      digestStringAsync: async (_alg, value) => crypto.createHash('sha256').update(value).digest('hex'),
      randomUUID: () => crypto.randomUUID(),
    },
    'firebase/firestore': {
      doc: (_db, ...segments) => segments.join('/'),
      getDoc: async () => {
        state.reads += 1;
        if (state.remoteError) throw state.remoteError;
        return { exists: () => state.remote !== null, data: () => state.remote };
      },
      setDoc: async (ref, data, options) => {
        if (state.writeError) throw state.writeError;
        state.writes.push({ ref, data, options });
      },
    },
    './firebase': { auth, db: {} },
  };
  const filename = path.join(root, 'services/parentalLock.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`Unexpected dependency: ${id}`);
  };
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return { lock: module.exports, secure, state, auth };
}

test('defaults to math and caches the "not set" answer so later gates stay offline', async () => {
  const { lock, state } = loadParentalLock();
  assert.equal(await lock.getParentalLockMethod(), 'math');
  assert.equal(await lock.getParentalLockMethod(), 'math');
  assert.equal(state.reads, 1);
});

test('PIN is stored hashed on-device and mirrored to the user doc without the uid', async () => {
  const { lock, secure, state } = loadParentalLock();
  assert.deepEqual(await lock.setParentalLock('pin', '4821'), { backedUp: true });
  const stored = secure.get('parental_lock_v1');
  assert.ok(!stored.includes('4821'), 'raw PIN never persisted');
  assert.equal(JSON.parse(stored).method, 'pin');
  const [write] = state.writes;
  assert.equal(write.ref, 'users/family');
  assert.deepEqual(write.options, { mergeFields: ['parentalLock'] });
  assert.equal(write.data.parentalLock.userId, undefined);
  assert.ok(!JSON.stringify(write.data).includes('4821'));
  assert.deepEqual(await lock.verifyParentalPin('4821'), { status: 'ok' });
  await assert.rejects(lock.setParentalLock('pin', '12'), /4 digits/);
});

test('repeated wrong PINs lock entry, even for the right PIN, until the lockout passes', async () => {
  const { lock, secure } = loadParentalLock();
  await lock.setParentalLock('pin', '4821');
  for (let left = 4; left >= 1; left -= 1) {
    assert.deepEqual(await lock.verifyParentalPin('0000'), { status: 'wrong', attemptsLeft: left });
  }
  assert.equal((await lock.verifyParentalPin('0000')).status, 'locked');
  assert.equal((await lock.verifyParentalPin('4821')).status, 'locked');
  assert.ok((await lock.getPinLockoutRemainingMs()) > 0);
  secure.set('parental_lock_lockout_v1', JSON.stringify({ failures: 0, lockedUntil: Date.now() - 1 }));
  assert.deepEqual(await lock.verifyParentalPin('4821'), { status: 'ok' });
});

test('restores the PIN from Firestore when this device has no local copy', async () => {
  const first = loadParentalLock();
  await first.lock.setParentalLock('pin', '7305');
  const remote = first.state.writes[0].data.parentalLock;

  const reinstalled = loadParentalLock({ remote: { parentalLock: remote } });
  assert.equal(await reinstalled.lock.getParentalLockMethod(), 'pin');
  assert.deepEqual(await reinstalled.lock.verifyParentalPin('7305'), { status: 'ok' });
  assert.ok(reinstalled.secure.has('parental_lock_v1'), 'cloud copy cached locally');
});

test('offline with no local copy falls back to math and backs off further lookups', async () => {
  const { lock, state } = loadParentalLock({ remoteError: new Error('offline') });
  assert.equal(await lock.getParentalLockMethod(), 'math');
  assert.equal(await lock.getParentalLockMethod(), 'math');
  assert.equal(state.reads, 1, 'offline lookups back off instead of stalling every gate');
});

test('a failed cloud backup still saves the lock on this device', async () => {
  const { lock, state } = loadParentalLock();
  state.writeError = new Error('offline');
  assert.deepEqual(await lock.setParentalLock('pin', '1357'), { backedUp: false });
  assert.equal(await lock.getParentalLockMethod(), 'pin');
  assert.deepEqual(await lock.verifyParentalPin('1357'), { status: 'ok' });
});

test('another family on the same device never inherits the lock', async () => {
  const { lock, auth } = loadParentalLock();
  await lock.setParentalLock('pin', '4821');
  assert.equal(await lock.getParentalLockMethod(), 'pin');
  auth.currentUser = { uid: 'other' };
  assert.equal(await lock.getParentalLockMethod(), 'math');
});

test('clearing removes the local lock and lockout state', async () => {
  const { lock, secure } = loadParentalLock();
  await lock.setParentalLock('pin', '4821');
  await lock.verifyParentalPin('0000');
  await lock.clearLocalParentalLock();
  assert.equal(secure.size, 0);
});

test('setup is "unset" until the parent explicitly chooses, even after the math default is cached', async () => {
  const { lock } = loadParentalLock();
  assert.equal(await lock.getParentalLockMethod(), 'math');
  assert.equal(await lock.getParentalLockSetupState(), 'unset');
  await lock.setParentalLock('math');
  assert.equal(await lock.getParentalLockSetupState(), 'configured');
});

test('a cached "not set" placeholder is re-checked so a lock chosen on another device is not asked again', async () => {
  const { lock, state } = loadParentalLock();
  assert.equal(await lock.getParentalLockMethod(), 'math');
  state.remote = { parentalLock: { method: 'pin', pinHash: 'h', pinSalt: 's', updatedAt: 1_700_000_000_000 } };
  assert.equal(await lock.getParentalLockSetupState(), 'configured');
  assert.equal(await lock.getParentalLockMethod(), 'pin');
});

test('setup state is "unknown" offline so the chooser never overwrites an unseen cloud lock', async () => {
  const { lock } = loadParentalLock({ remoteError: new Error('offline') });
  assert.equal(await lock.getParentalLockSetupState(), 'unknown');
});

for (const retired of ['biometric', 'none']) {
  test(`a saved "${retired}" lock (no longer offered) uses math and asks the parent to choose again`, async () => {
    const { lock, secure } = loadParentalLock({
      remote: { parentalLock: { method: retired, updatedAt: 1_700_000_000_000 } },
    });
    secure.set('parental_lock_v1', JSON.stringify({ userId: 'family', method: retired, updatedAt: 1_700_000_000_000 }));
    assert.equal(await lock.getParentalLockMethod(), 'math');
    assert.equal(await lock.getParentalLockSetupState(), 'unset');
    await lock.setParentalLock('pin', '2468');
    assert.equal(await lock.getParentalLockSetupState(), 'configured');
  });
}

test('resetting the PIN replaces the old one and clears an active lockout', async () => {
  const { lock } = loadParentalLock();
  await lock.setParentalLock('pin', '4821');
  for (let i = 0; i < 5; i += 1) await lock.verifyParentalPin('0000');
  assert.ok((await lock.getPinLockoutRemainingMs()) > 0);
  await lock.setParentalLock('pin', '1357');
  assert.equal(await lock.getPinLockoutRemainingMs(), 0);
  assert.equal((await lock.verifyParentalPin('4821')).status, 'wrong');
  assert.deepEqual(await lock.verifyParentalPin('1357'), { status: 'ok' });
});

function loadChallenges() {
  const filename = path.join(root, 'utils/parentalChallenge.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(() => { throw new Error('no deps'); }, module, module.exports);
  return module.exports;
}

const WORD_VALUES = Object.fromEntries([
  ...'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'
    .split(' ').map((word, i) => [word, i]),
  ...'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ').map((word, i) => [word, (i + 2) * 10]),
]);
const wordsToNumber = (words) => words.split('-').reduce((sum, part) => sum + WORD_VALUES[part], 0);

function parseQuestion(question) {
  const match = /^What is ([a-z-]+) times ([a-z-]+)\?$/.exec(question);
  assert.ok(match, `unexpected question: ${question}`);
  assert.ok(!/\d/.test(question), 'questions never show digits');
  return [wordsToNumber(match[1]), wordsToNumber(match[2])];
}

test('number words cover 0-99', () => {
  const { numberToWords } = loadChallenges();
  assert.equal(numberToWords(0), 'zero');
  assert.equal(numberToWords(13), 'thirteen');
  assert.equal(numberToWords(40), 'forty');
  assert.equal(numberToWords(47), 'forty-seven');
  assert.equal(numberToWords(99), 'ninety-nine');
  assert.throws(() => numberToWords(100), RangeError);
  for (let n = 0; n <= 99; n += 1) assert.equal(wordsToNumber(numberToWords(n)), n);
});

test('PIN recovery questions are harder than the everyday gate and answers match the words', () => {
  const { newGateChallenge, newRecoveryChallenge } = loadChallenges();
  for (let i = 0; i < 300; i += 1) {
    const gate = newGateChallenge();
    const [ga, gb] = parseQuestion(gate.question);
    assert.equal(gate.answer, ga * gb);
    assert.ok(ga <= 9 && gb <= 9);

    const recovery = newRecoveryChallenge();
    const [ra, rb] = parseQuestion(recovery.question);
    assert.equal(recovery.answer, ra * rb);
    assert.ok(ra >= 21 && ra <= 49 && ra % 10 !== 0, `two-digit, non-round operand: ${ra}`);
    assert.ok(rb >= 6 && rb <= 9);
    assert.ok(recovery.answer >= 100 && recovery.answer <= 999, 'fits the 3-digit answer field');
  }
});
