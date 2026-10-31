const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function loader(mocks) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'module', 'exports', compiled)((id) => {
      if (id in mocks) return mocks[id];
      if (!id.startsWith('.')) throw new Error(`Unexpected dependency: ${id}`);
      const base = path.resolve(path.dirname(file), id);
      if (base.endsWith('.json')) return JSON.parse(fs.readFileSync(base, 'utf8'));
      const found = [base + '.ts', path.join(base, 'index.ts')].find((candidate) => fs.existsSync(candidate));
      if (!found) throw new Error(`Cannot resolve ${id}`);
      return load(found);
    }, module, module.exports);
    return module.exports;
  }
  return (file) => load(path.join(root, file));
}

const seed = JSON.parse(fs.readFileSync(path.join(root, 'functions/scripts/activity-catalog.seed.json'), 'utf8'));
function catalog() {
  const assets = { becky: { p1: { path: 'p1', generation: '1' }, p2: { path: 'p2', generation: '2' } } };
  return { activities: Object.fromEntries(Object.entries(seed).map(([key, value]) => [key, { ...value, assets }])) };
}

function harness() {
  const auth = { currentUser: { uid: 'family', isAnonymous: false } };
  const docs = new Map([['catalog/activities', catalog()]]);
  const state = { offline: false, failCommit: false, changeUserOnRead: false, writes: [] };
  const snapshot = (ref) => ({ exists: () => docs.has(ref), data: () => docs.get(ref) });
  const load = loader({
    './firebase': { auth, db: {} },
    'firebase/firestore': {
      doc: (_db, ...segments) => segments.join('/'),
      getDocFromServer: async (ref) => {
        if (state.offline) throw new Error('offline');
        return snapshot(ref);
      },
      runTransaction: async (_db, action) => {
        const writes = [];
        const result = await action({
          get: async (ref) => {
            if (state.changeUserOnRead) auth.currentUser = { uid: 'other', isAnonymous: false };
            return snapshot(ref);
          },
          set: (ref, value, options) => writes.push({ ref, value, options }),
        });
        if (state.failCommit) throw new Error('commit failed');
        for (const { ref, value, options } of writes) {
          docs.set(ref, options ? { ...docs.get(ref), ...value } : value);
        }
        state.writes.push(...writes);
        return result;
      },
    },
  });
  const { isoDateYearsAgo } = load('utils/date.ts');
  return {
    auth, docs, state, load,
    registration: load('website/src/services/registration.ts'),
    input: {
      childName: 'Liam', gender: 'boy', birthDate: isoDateYearsAgo(6),
      wakeTime: '07:00', bedtime: '20:00',
      answers: {
        stuckPoints: ['getting_dressed'], motivationStyle: 'autonomy_choose',
        masteredTasks: ['none_yet'], helpLevel: 'little_push', morningSpeed: 'fast_energetic',
      },
    },
  };
}

test('web registration uses native catalog composer, schedule, tone, and recoverable profile schema', () => {
  const h = harness();
  const { profile, segments } = h.registration.buildRegistration('family', h.input, catalog());
  const definitions = h.load('utils/activityCatalogModel.ts').parseActivityCatalog(catalog(), { appVersion: '1.0.0' }).definitions
    .filter((d) => d.selectable);
  const { composeRoutine } = h.load('utils/routineComposer.ts');
  const { scheduleFromStart, scheduleToEnd } = h.load('utils/routineSchedule.ts');
  for (const segment of segments) {
    const keys = composeRoutine(definitions, segment.id, profile.age, h.input.answers);
    assert.deepEqual(segment.activities.map((a) => a.activityKey), keys);
    const slots = (key) => definitions.find((d) => d.key === key).scheduleMinutes;
    assert.deepEqual(segment.activities.map((a) => a.time), segment.id === 'morning'
      ? scheduleFromStart(h.input.wakeTime, keys, slots) : scheduleToEnd(h.input.bedtime, keys, slots));
  }
  assert.equal(profile.tone, 'encouraging');
  assert.equal(profile.birthDate, h.input.birthDate);
  assert.equal(profile.age, 6);
});

test('web setup saves native subcollection steps and preserves unrelated user fields atomically', async () => {
  const h = harness();
  h.docs.set('users/family', { parentalLock: { method: 'math' } });
  const profile = await h.registration.saveRegistration('family', h.input);
  const raw = h.docs.get('users/family');
  assert.deepEqual(raw.parentalLock, { method: 'math' });
  assert.deepEqual(raw.childProfile.activityStack[0], { activities: profile.activityStack[0] });
  const recovered = h.load('utils/childProfile.ts').normalizeChildProfile(raw.childProfile, 'family');
  assert.deepEqual(recovered, profile);
  for (const segment of ['morning', 'evening']) {
    const meta = h.docs.get(`users/family/routines/${segment}`);
    const step = h.docs.get(`users/family/routines/${segment}/activities/step_0`);
    assert.equal(meta.scheduledTime, step.time);
    assert.equal(step.order, 0);
    assert.equal(typeof step.activityKey, 'string');
    assert.equal(step.durationMinutes > 0, true);
    assert.equal('notificationId' in meta, false);
  }
  assert.deepEqual(await h.registration.loadChildProfile('family'), profile);
});

test('existing mobile routines and profiles are never overwritten by stale web registration', async () => {
  const h = harness();
  h.docs.set('users/family/routines/morning', { scheduledTime: '09:45' });
  h.docs.set('users/family/routines/morning/activities/custom', { activityKey: 'custom' });
  const first = await h.registration.saveRegistration('family', h.input);
  assert.deepEqual(h.docs.get('users/family/routines/morning'), { scheduledTime: '09:45' });
  assert.equal(h.docs.has('users/family/routines/morning/activities/step_0'), false);
  const writes = h.state.writes.length;
  const second = await h.registration.saveRegistration('family', { ...h.input, childName: 'Other' });
  assert.deepEqual(second, first);
  assert.equal(h.state.writes.length, writes);
});

test('missing catalog, invalid answers, invalid dates, and wrong time segments do not create profiles', async () => {
  const h = harness();
  assert.throws(() => h.registration.buildRegistration('family', h.input, {}), /load activities/);
  for (const input of [
    { ...h.input, birthDate: '2020-02-31' },
    { ...h.input, wakeTime: '22:00' },
    { ...h.input, bedtime: '10:00' },
    { ...h.input, wakeTime: '99:99' },
    { ...h.input, childName: '<script>' },
    { ...h.input, answers: {} },
    { ...h.input, answers: { ...h.input.answers, motivationStyle: 'invalid' } },
  ]) {
    assert.throws(() => h.registration.buildRegistration('family', input, catalog()));
  }
  h.docs.delete('catalog/activities');
  await assert.rejects(h.registration.saveRegistration('family', h.input), /load activities/);
  assert.equal(h.state.writes.length, 0);
});

test('offline/failed commits and account switches fail explicitly without partial setup', async () => {
  const h = harness();
  h.state.offline = true;
  await assert.rejects(h.registration.saveRegistration('family', h.input), /offline/);
  h.state.offline = false;
  h.state.failCommit = true;
  await assert.rejects(h.registration.saveRegistration('family', h.input), /commit failed/);
  assert.equal(h.docs.has('users/family'), false);
  h.state.failCommit = false;
  h.state.changeUserOnRead = true;
  await assert.rejects(h.registration.saveRegistration('family', h.input), /account changed/);
  assert.equal(h.state.writes.length, 0);
  await assert.rejects(h.registration.loadChildProfile('family'), /account changed/);
});

test('shared questionnaire choices preserve exclusive options and native tone mapping', () => {
  const h = harness();
  const shared = h.load('utils/questionnaire.ts');
  assert.deepEqual(shared.toggleMulti(['getting_dressed'], 'everything_negotiation', 'everything_negotiation'),
    ['everything_negotiation']);
  assert.deepEqual(shared.toggleMulti(['everything_negotiation'], 'getting_dressed', 'everything_negotiation'),
    ['getting_dressed']);
  assert.equal(shared.toneFromMotivation('race_game'), 'cheerful');
  assert.equal(shared.toneFromMotivation('hug_connection'), 'calm');
  assert.equal(shared.MORNING_STUCK_OPTIONS.length, 5);
  assert.equal(shared.MASTERED_OPTIONS.length, 4);
});
