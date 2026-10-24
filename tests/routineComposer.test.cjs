const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.dirname(require.resolve('../package.json'));

function createLoader() {
  const cache = new Map();
  function load(absolute) {
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const localRequire = (id) => {
      if (id === '@/theme/colors') return { colors: {} };
      if (!id.startsWith('.')) throw new Error(`Unexpected dependency: ${id}`);
      const base = path.resolve(path.dirname(absolute), id);
      if (base === path.join(root, 'theme')) return { colors: { primary: '#000' } };
      const resolved = [base + '.ts', base + '.tsx', path.join(base, 'index.ts')].find((f) => fs.existsSync(f));
      if (!resolved) throw new Error(`Cannot resolve ${id}`);
      return load(resolved);
    };
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
    return module.exports;
  }
  return (file) => load(path.resolve(root, file));
}

const seed = JSON.parse(fs.readFileSync(path.join(root, 'functions/scripts/activity-catalog.seed.json'), 'utf8'));

/** The catalog seed parsed like the live catalog; entries with a greeting get Becky media. */
function seedDefinitions(load) {
  const { parseActivityCatalog } = load('utils/activityCatalogModel.ts');
  const assets = { becky: { p1: { path: 'p1', generation: '1' }, p2: { path: 'p2', generation: '2' } } };
  const activities = Object.fromEntries(Object.entries(seed).map(([key, entry]) => [key, { ...entry, assets }]));
  return parseActivityCatalog({ activities }, { appVersion: '1.0.0' }).definitions;
}

/** Every catalog activity, as if all of them had complete media. */
function setup() {
  const load = createLoader();
  const composer = load('utils/routineComposer.ts');
  const all = seedDefinitions(load).map((def) => ({ ...def, selectable: true }));
  const compose = (segment, age, answers = {}) => composer.composeRoutine(all, segment, age, answers);
  return { composer, compose, all };
}

const set = (list) => [...list].sort();

test('morning bundles reproduce the POC smart-bundles table', () => {
  const { composer, compose } = setup();
  const survival = { stuckPoints: ['everything_negotiation'] };
  const table = {
    2: {
      1: ['wake_up', 'get_dressed', 'eat_breakfast'],
      2: ['wake_up', 'drink_water', 'get_dressed', 'put_shoes_on', 'brush_teeth', 'eat_breakfast'],
      3: ['wake_up', 'drink_water', 'get_dressed', 'put_shoes_on', 'brush_teeth', 'tidy_room', 'eat_breakfast'],
    },
    4: {
      1: ['wake_up', 'get_dressed', 'brush_teeth', 'eat_breakfast'],
      2: ['wake_up', 'wash_face', 'get_dressed', 'put_shoes_on', 'brush_teeth', 'pack_backpack', 'eat_breakfast'],
      3: ['wake_up', 'wash_face', 'brush_teeth', 'comb_hair', 'get_dressed', 'put_shoes_on', 'pack_backpack', 'tidy_room', 'eat_breakfast'],
    },
    6: {
      1: ['wake_up', 'wash_face', 'get_dressed', 'brush_teeth', 'eat_breakfast', 'pack_backpack'],
      2: ['wake_up', 'wash_face', 'brush_teeth', 'get_dressed', 'put_shoes_on', 'pack_backpack', 'eat_breakfast'],
      3: ['wake_up', 'make_bed', 'wash_face', 'brush_teeth', 'comb_hair', 'get_dressed', 'put_shoes_on', 'pack_backpack', 'eat_breakfast'],
    },
  };
  const triggers = {
    2: { 1: survival, 2: { helpLevel: 'little_push' }, 3: { motivationStyle: 'race_game' } },
    4: { 1: survival, 2: { helpLevel: 'little_push' }, 3: { motivationStyle: 'autonomy_choose' } },
    6: { 1: { morningSpeed: 'easily_distracted' }, 2: { helpLevel: 'little_push' }, 3: { helpLevel: 'independent' } },
  };
  for (const [age, tiers] of Object.entries(table)) {
    for (const [tier, expected] of Object.entries(tiers)) {
      const answers = triggers[age][tier];
      assert.equal(composer.pickMorningTier(Number(age), answers), Number(tier), `age ${age} tier ${tier}`);
      const routine = compose('morning', Number(age), answers);
      assert.deepEqual(set(routine), set(expected), `age ${age} tier ${tier}`);
      assert.equal(routine[0], 'wake_up');
    }
  }
  // Age 5 still uses the kindergarten bundle and 12 the school one.
  assert.deepEqual(set(compose('morning', 5)), set(table[4][2]));
  assert.deepEqual(set(compose('morning', 12)), set(table[6][2]));
});

test('evening keeps the previous age templates (bedtime_story is the only reading activity)', () => {
  const { compose } = setup();
  assert.deepEqual(compose('evening', 3), ['tidy_room', 'eat_dinner', 'put_on_pajamas', 'bedtime_story', 'go_to_sleep']);
  assert.deepEqual(compose('evening', 8), ['homework', 'tidy_room', 'eat_dinner', 'put_on_pajamas', 'bedtime_story', 'go_to_sleep']);
});

test('the app bundles no activities: without the catalog nothing is auto-composed', () => {
  const load = createLoader();
  const { getSelectableActivityDefinitions } = load('constants/activities.ts');
  const { composeRoutine } = load('utils/routineComposer.ts');
  assert.deepEqual(getSelectableActivityDefinitions(), []);
  assert.deepEqual(composeRoutine(getSelectableActivityDefinitions(), 'morning', 6, {}), []);
});

test('stuck points pull activities in; mastered tasks leave optional ones out', () => {
  const { compose } = setup();
  // Survival toddler bundle, but brushing is where the morning gets stuck.
  assert.ok(compose('morning', 2, { stuckPoints: ['brushing_washing'], helpLevel: 'little_push' }).includes('brush_teeth'));
  const survival = compose('morning', 2, { stuckPoints: ['everything_negotiation'] });
  assert.ok(!survival.includes('brush_teeth'));
  // Stuck points apply to the evening too (brush teeth is only added there on request).
  assert.ok(!compose('evening', 6).includes('brush_teeth'));
  const evening = compose('evening', 6, { stuckPoints: ['brushing_washing'] });
  assert.deepEqual(evening.slice(2, 5), ['eat_dinner', 'put_on_pajamas', 'brush_teeth']);
  // Shoes are optional "dressing", so a dressing stuck point keeps them even in survival mode.
  assert.ok(compose('morning', 2, { stuckPoints: ['getting_dressed'] }).includes('put_shoes_on'));

  // Already a pro at tidying: left out of the independence bundle and the evening.
  const pro = { motivationStyle: 'race_game', masteredTasks: ['putting_toys_away'] };
  assert.ok(!compose('morning', 3, pro).includes('tidy_room'));
  assert.ok(!compose('evening', 3, pro).includes('tidy_room'));
  // Core (level 1) activities are never dropped.
  assert.ok(compose('morning', 3, { masteredTasks: ['eating_breakfast'] }).includes('eat_breakfast'));
  // A stuck point beats a mastered tag.
  assert.ok(compose('evening', 3, { ...pro, stuckPoints: ['getting_dressed'], masteredTasks: ['choosing_clothes'] }).includes('put_on_pajamas'));
});

test('only selectable activities with a placement are composed, ordered by position', () => {
  const load = createLoader();
  const { composeRoutine, routineLevelAt } = load('utils/routineComposer.ts');
  const definitions = seedDefinitions(load);
  const feedDog = {
    ...definitions[0],
    key: 'feed_dog',
    tags: ['pets'],
    routine: { morning: { position: 85, levels: { 5: 2 } } },
  };
  const defs = [...definitions.filter((d) => d.selectable && d.key !== 'wash_face'), feedDog];
  const routine = composeRoutine(defs, 'morning', 7, {});
  assert.deepEqual(routine.slice(-2), ['feed_dog', 'eat_breakfast']);
  assert.ok(!routine.includes('wash_face'), 'not selectable');
  assert.ok(!composeRoutine(defs, 'morning', 4, {}).includes('feed_dog'), 'below its first age');
  assert.equal(routineLevelAt({ position: 0, levels: { 2: 2, 4: 0 } }, 3), 2);
  assert.equal(routineLevelAt({ position: 0, levels: { 2: 2, 4: 0 } }, 9), 0);
  assert.equal(routineLevelAt({ position: 0, levels: { 6: 1 } }, 5), 0);
});

test('catalog tags/routine are validated on client and server', () => {
  const load = createLoader();
  const { parseActivityCatalog } = load('utils/activityCatalogModel.ts');
  const model = load('functions/src/catalogModel.ts');
  const assets = { becky: { p1: { path: 'a', generation: '1' }, p2: { path: 'b', generation: '2' } } };
  const parse = (entry) =>
    parseActivityCatalog({ activities: { wake_up: { label: 'Wake Up', part1: { text: 'Hi {name}!' }, assets, ...entry } } },
      { appVersion: '1.0.0' }).definitions[0];

  assert.deepEqual([parse({}).tags, parse({}).routine], [[], {}]);
  const routine = { evening: { position: 5, levels: { '03': 2 } } };
  assert.deepEqual(parse({ tags: ['x', 'x'], routine }).tags, ['x']);
  assert.deepEqual(parse({ routine }).routine, { evening: { position: 5, levels: { 3: 2 } } });
  const invalid = parse({ tags: ['Bad Tag'], routine: { noon: routine.evening } });
  assert.deepEqual([invalid.tags, invalid.routine], [[], {}]);

  const ok = model.validateCatalogMetadata({ label: 'Feed', tags: ['pets'], routine });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.routine, { evening: { position: 5, levels: { 3: 2 } } });
  for (const bad of [
    { tags: 'pets' },
    { routine: { morning: { position: 1, levels: { 2: 4 } } } },
    { routine: { morning: { position: 1, levels: {} } } },
    { routine: { morning: { levels: { 2: 1 } } } },
    { routine: { noon: { position: 1, levels: { 2: 1 } } } },
  ]) assert.equal(model.validateCatalogMetadata({ label: 'Feed', ...bad }).ok, false, JSON.stringify(bad));

  // Every seeded activity carries valid composition data.
  for (const [key, entry] of Object.entries(seed)) {
    assert.ok(entry.tags?.length && entry.routine, key);
    assert.equal(model.validateCatalogMetadata(entry).ok, true, key);
  }
});

test('questionnaire answers migrate legacy single values and keep exclusive options alone', () => {
  const { normalizeChildProfile } = createLoader()('utils/childProfile.ts');
  const base = {
    userId: 'u1', childName: 'Liam', age: 5, gender: 'boy', voice: 'woman', tone: 'calm',
    avatarId: 'becky', scheduledTime: '08:00', activityStack: [['wake_up']],
  };
  const answers = (raw) => normalizeChildProfile({ ...base, answers: raw })?.answers;
  assert.deepEqual(answers({ morningStuck: 'getting_dressed', masteredTask: 'none_yet' }),
    { stuckPoints: ['getting_dressed'], masteredTasks: ['none_yet'] });
  assert.deepEqual(answers({ stuckPoints: ['brushing_washing', 'getting_dressed', 'brushing_washing'] }),
    { stuckPoints: ['getting_dressed', 'brushing_washing'] });
  assert.deepEqual(answers({ stuckPoints: ['getting_dressed', 'everything_negotiation'] }),
    { stuckPoints: ['everything_negotiation'] });
  assert.deepEqual(answers({ masteredTasks: [] }), {});
  assert.equal(normalizeChildProfile({ ...base, answers: { stuckPoints: ['nope'] } }), null);
  assert.equal(normalizeChildProfile({ ...base, answers: { masteredTasks: 'eating_breakfast' } }), null);
});

test('slow and dreamy caps the morning at the recommended template', () => {
  const { composer } = setup();
  const lia = {
    stuckPoints: ['getting_dressed', 'brushing_washing'],
    motivationStyle: 'autonomy_choose',
    helpLevel: 'little_push',
    morningSpeed: 'slow_dreamy',
    masteredTasks: ['choosing_clothes', 'putting_toys_away'],
  };
  assert.equal(composer.pickMorningTier(5, lia), 2);
  assert.equal(composer.pickMorningTier(3, { motivationStyle: 'race_game', morningSpeed: 'slow_dreamy' }), 2);
  assert.equal(composer.pickMorningTier(8, { helpLevel: 'independent', morningSpeed: 'slow_dreamy' }), 2);
  // Never raised: survival stays survival.
  assert.equal(composer.pickMorningTier(5, { stuckPoints: ['everything_negotiation'], morningSpeed: 'slow_dreamy' }), 1);
});

test('schedule: shared 30-min window, own slots for long activities', () => {
  const load = createLoader();
  const { scheduleFromStart, scheduleToEnd } = load('utils/routineSchedule.ts');
  const slots = { eat_dinner: 60 };
  const slot = (key) => slots[key];

  // Morning: 3 ordinary tasks split 30 min evenly from wake-up.
  assert.deepEqual(scheduleFromStart('07:00', ['a', 'b', 'c'], slot), ['07:00', '07:10', '07:20']);

  // Evening: dinner (60) + 4 ordinary tasks (7.5 each) end at bedtime 20:00 → starts 18:30.
  assert.deepEqual(
    scheduleToEnd('20:00', ['eat_dinner', 'bath', 'pajamas', 'brush', 'story'], slot),
    ['18:30', '19:30', '19:38', '19:45', '19:53']
  );

  // Never starts before the evening segment (16:00), so steps stay on the evening panel.
  assert.equal(scheduleToEnd('17:00', ['eat_dinner', 'x'], slot)[0], '16:00');

  // Seed gives dinner its own 1-hour slot through the real parser.
  const dinner = seedDefinitions(load).find((def) => def.key === 'eat_dinner');
  assert.equal(dinner.scheduleMinutes, 60);
});
