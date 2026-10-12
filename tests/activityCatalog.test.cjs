const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.dirname(require.resolve('../package.json'));

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

/** Loads TS modules with one shared module cache so tests can reach a module's dependencies. */
function createLoader(mocks = {}) {
  const cache = new Map();
  function load(absolute) {
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const localRequire = (id) => {
      if (id in mocks) return mocks[id];
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(absolute), id);
        if (base === path.join(root, 'theme')) return { colors: { primary: '#000' } };
        const resolved = [base + '.ts', base + '.tsx', path.join(base, 'index.ts')].find((f) => fs.existsSync(f));
        if (!resolved) throw new Error(`Cannot resolve ${id}`);
        return load(resolved);
      }
      throw new Error(`Unexpected dependency: ${id}`);
    };
    new Function('require', 'module', 'exports', transpile(fs.readFileSync(absolute, 'utf8')))(
      localRequire, module, module.exports
    );
    return module.exports;
  }
  return (file) => load(path.resolve(root, file));
}

const serverSource = fs.readFileSync(path.join(root, 'functions/src/index.ts'), 'utf8');

function extract(regex, label) {
  const match = regex.exec(serverSource);
  assert.ok(match, `${label} not found in functions/src/index.ts`);
  return match[0];
}

function serverBuildPart1AudioKey() {
  const fns = [
    extract(/function normalizeNameToken\(childName: string\): string \{[\s\S]*?\n\}\n/, 'normalizeNameToken'),
    extract(/function buildPart1AudioKey\([\s\S]*?\n\}\n/, 'buildPart1AudioKey'),
  ].join('\n');
  return new Function(`${transpile(fns)}; return buildPart1AudioKey;`)();
}

function serverLegacyTemplates() {
  const match = /const PART1_TEMPLATES[^=]*= (\{[\s\S]*?\n\});/.exec(serverSource);
  assert.ok(match, 'PART1_TEMPLATES not found in functions/src/index.ts');
  return new Function(`return ${match[1]};`)();
}

const part1Mocks = {
  'expo-file-system/legacy': { documentDirectory: 'file:///docs/' },
  'firebase/functions': { httpsCallable: () => async () => ({ data: {} }) },
  'firebase/storage': { getDownloadURL: async () => '', ref: () => ({}) },
  './firebase': { functions: {}, storage: {}, ensureAuth: async () => ({ uid: 'u' }) },
  './assetSync': { localAudioPath: (key) => `file:///docs/audio/${key}.wav` },
};

test('Part 1 audio keys match the server for bundled and versioned greetings', () => {
  const load = createLoader(part1Mocks);
  const { buildPart1AudioKey } = load('services/part1Audio.ts');
  const activities = load('constants/activities.ts');
  const server = serverBuildPart1AudioKey();

  for (const def of activities.BUNDLED_ACTIVITY_DEFINITIONS) {
    for (const [tone, voice] of [[undefined, undefined], ['calm', 'man']]) {
      assert.equal(
        buildPart1AudioKey(def.key, 'Liam', tone, voice),
        server(def.key, 'Liam', tone ?? def.part1Tone, voice ?? 'woman', 1),
        def.key
      );
    }
  }
  // Version 1 keeps the pre-versioning key, so cached clips stay valid.
  assert.equal(buildPart1AudioKey('wake_up', 'Liam'), 'p1_wake_up_liam_encouraging_woman');

  activities.applyActivityDefinitions([
    ...activities.BUNDLED_ACTIVITY_DEFINITIONS,
    { ...activities.BUNDLED_ACTIVITY_DEFINITIONS[0], key: 'feed_dog', part1Tone: 'calm', part1Version: 3 },
  ]);
  assert.equal(buildPart1AudioKey('feed_dog', 'Liam'), server('feed_dog', 'Liam', 'calm', 'woman', 3));
  assert.equal(buildPart1AudioKey('feed_dog', 'Liam'), 'p1_feed_dog_liam_calm_woman_v3');
});

test('bundled greetings and the catalog seed match the server legacy templates', () => {
  const activities = createLoader()('constants/activities.ts');
  const legacy = serverLegacyTemplates();
  const seed = JSON.parse(fs.readFileSync(path.join(root, 'functions/scripts/activity-catalog.seed.json'), 'utf8'));

  for (const def of activities.BUNDLED_ACTIVITY_DEFINITIONS.filter((d) => d.selectable)) {
    assert.deepEqual(
      { text: def.part1Text, tone: def.part1Tone },
      { text: legacy[def.key].textTemplate, tone: legacy[def.key].prompt },
      def.key
    );
    assert.deepEqual(seed[def.key].part1, { text: def.part1Text, tone: def.part1Tone }, def.key);
  }
  // Activities without uploaded videos carry no greeting, so the catalog keeps them hidden.
  for (const key of ['pack_backpack', 'wash_face', 'read_book']) assert.equal(seed[key].part1, undefined, key);
});

function catalogEntry(overrides = {}) {
  return {
    label: 'Feed the Dog',
    part1: { text: 'Doggy time, {name}!', tone: 'calm', version: 2 },
    assets: {
      becky: {
        p1: { path: 'avatars/becky/feed_dog_p1.mp4', generation: '11' },
        p2: { path: 'avatars/becky/feed_dog.mp4', generation: 12, md5: 'abc' },
      },
    },
    ...overrides,
  };
}

test('catalog parsing only exposes complete, enabled, supported activities', () => {
  const load = createLoader();
  const { BUNDLED_ACTIVITY_DEFINITIONS } = load('constants/activities.ts');
  const { parseActivityCatalog } = load('utils/activityCatalogModel.ts');
  const parse = (activities, appVersion = '1.0.0') =>
    parseActivityCatalog({ activities }, BUNDLED_ACTIVITY_DEFINITIONS, { appVersion });

  const parsed = parse({ feed_dog: catalogEntry(), 'Bad Key!': catalogEntry() });
  assert.equal(parsed.definitions.length, 1);
  const [def] = parsed.definitions;
  assert.equal(def.selectable, true);
  assert.equal(def.part1Version, 2);
  assert.equal(def.part1Tone, 'calm');
  assert.equal(parsed.assets.feed_dog.becky.p2.generation, '12');

  const selectable = (entry, version) => parse({ feed_dog: entry }, version).definitions[0].selectable;
  assert.equal(selectable(catalogEntry({ enabled: false })), false);
  assert.equal(selectable(catalogEntry({ minAppVersion: '1.2.0' }), '1.1.9'), false);
  assert.equal(selectable(catalogEntry({ minAppVersion: '1.2' }), '1.2.0'), true);
  assert.equal(selectable(catalogEntry({ assets: { becky: { p2: catalogEntry().assets.becky.p2 } } })), false);
  // Without its own greeting text the server cannot speak Part 1, so it stays hidden.
  assert.equal(parse({ feed_dog: catalogEntry({ part1: undefined }) }).definitions.length, 0);

  // Bundled activities inherit bundled copy for fields the catalog omits.
  const wake = parse({ wake_up: { part1: { text: 'Hi {name}!' }, assets: catalogEntry().assets } }).definitions[0];
  assert.equal(wake.label, 'Wake Up');
  assert.equal(wake.part1Text, 'Hi {name}!');
  assert.equal(wake.selectable, true);
  const noGreeting = parse({ wake_up: { assets: catalogEntry().assets } }).definitions[0];
  assert.equal(noGreeting.selectable, false);
});

test('registry keeps retired activities renderable and filters pickers by selectability', () => {
  const activities = createLoader()('constants/activities.ts');
  assert.equal(activities.isActivitySelectable('brush_teeth'), true);
  assert.equal(activities.isActivitySelectable('pack_backpack'), false);
  assert.ok(!activities.activityKeysForSegment('morning').includes('pack_backpack'));
  assert.ok(activities.activityKeysForSegment('evening').includes('go_to_sleep'));
  assert.ok(!activities.activityKeysForSegment('morning').includes('go_to_sleep'));

  const feed = { ...activities.getActivityDefinition('brush_teeth'), key: 'feed_dog', label: 'Feed the Dog', order: 0 };
  activities.applyActivityDefinitions([feed]);
  assert.equal(activities.ACTIVITY_KEYS[0], 'feed_dog');
  assert.equal(activities.ACTIVITIES.feed_dog.label, 'Feed the Dog');
  // Not in the new catalog: still known (old routines render) but no longer offered.
  assert.equal(activities.isKnownActivity('brush_teeth'), true);
  assert.equal(activities.isActivitySelectable('brush_teeth'), false);
  assert.deepEqual(activities.activityKeysForSegment('morning'), ['feed_dog']);

  // Unknown keys never borrow another activity's identity.
  assert.equal(activities.getActivityMeta('make_pancakes').label, 'Make Pancakes');
  assert.equal(activities.starsForStep(['make_pancakes']), 1);
});

test('Cloud Storage base64 MD5 converts to the hex digest expo-file-system reports', () => {
  const { base64Md5ToHex } = createLoader()('utils/activityCatalogModel.ts');
  const base64 = 'PNR0fNRJw/LN2mIDIxJkFA==';
  assert.equal(base64Md5ToHex(base64), Buffer.from(base64, 'base64').toString('hex'));
  assert.equal(base64Md5ToHex('not base64!'), null);
});

test('server catalog model maps Storage uploads onto catalog entries safely', () => {
  const model = createLoader()('functions/src/catalogModel.ts');
  const parse = model.parseCatalogObjectPath;

  assert.deepEqual(parse('avatars/becky/wake_up_p1.mp4'), { type: 'media', activityKey: 'wake_up', avatarId: 'becky', kind: 'p1', isAlias: false });
  assert.deepEqual(parse('avatars/becky/wake_up.mp4'), { type: 'media', activityKey: 'wake_up', avatarId: 'becky', kind: 'p2', isAlias: false });
  assert.deepEqual(parse('avatars/becky/wake_up_p2.mp4'), { type: 'media', activityKey: 'wake_up', avatarId: 'becky', kind: 'p2', isAlias: true });
  assert.deepEqual(parse('avatars/becky/wake_up_captions.json'), { type: 'media', activityKey: 'wake_up', avatarId: 'becky', kind: 'captions', isAlias: false });
  assert.deepEqual(parse('catalog/activities/feed_dog.json'), { type: 'metadata', activityKey: 'feed_dog' });
  assert.deepEqual(parse('catalog/activities/feed_dog.webp'), { type: 'image', activityKey: 'feed_dog' });
  for (const ignored of [
    'avatars/becky/welcome.mp4', 'avatars/default/welcome.mp4', 'avatars/public_site/x.mp4',
    'avatars/becky/wake_up_poster.png', 'avatars/becky/wake_up_p1.vtt', 'avatars/routines_manifest_part1.json',
    'avatars/becky/wake_up.json', 'audio/p1_wake_up_liam.wav',
  ]) assert.equal(parse(ignored), null, ignored);

  const ref = (p, generation) => ({ path: p, generation: String(generation) });
  let entry = model.applyAssetUpload(undefined, 'feed_dog', 'becky', 'p2', ref('avatars/becky/feed_dog.mp4', 5), false);
  assert.equal(entry.assets.becky.p2.generation, '5');
  // Out-of-order older event and the _p2 alias never replace the canonical file.
  assert.equal(model.applyAssetUpload(entry, 'feed_dog', 'becky', 'p2', ref('avatars/becky/feed_dog.mp4', 4), false), null);
  assert.equal(model.applyAssetUpload(entry, 'feed_dog', 'becky', 'p2', ref('avatars/becky/feed_dog_p2.mp4', 9), true), null);
  entry = model.applyAssetUpload(entry, 'feed_dog', 'becky', 'p2', ref('avatars/becky/feed_dog.mp4', 6), false);
  assert.equal(entry.assets.becky.p2.generation, '6');
  // An overwrite also deletes the previous generation — that must not drop the new ref.
  assert.equal(model.applyAssetDeletion(entry, 'becky', 'p2', 'avatars/becky/feed_dog.mp4', '5'), null);
  assert.equal(model.applyAssetDeletion(entry, 'becky', 'p2', 'avatars/becky/feed_dog.mp4', '6').assets.becky, undefined);
  // Deleting the canonical clip falls back to a still-uploaded _p2 alias (as the trigger does).
  const removed = model.applyAssetDeletion(entry, 'becky', 'p2', 'avatars/becky/feed_dog.mp4', '6');
  const fallback = model.applyAssetUpload(removed, 'feed_dog', 'becky', 'p2', ref('avatars/becky/feed_dog_p2.mp4', 9), true);
  assert.equal(fallback.assets.becky.p2.path, 'avatars/becky/feed_dog_p2.mp4');

  const valid = model.validateCatalogMetadata({ label: 'Feed the Dog', stars: 2, part1: { text: 'Doggy time, {name}!' } });
  assert.equal(valid.ok, true);
  const invalid = model.validateCatalogMetadata({ stars: 5, part1: { text: 'No placeholder' } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.length, 3);

  let withMeta = model.applyMetadata(entry, 'feed_dog', valid.value);
  assert.deepEqual(withMeta.part1, { text: 'Doggy time, {name}!', tone: 'encouraging', version: 1 });
  assert.equal(withMeta.assets.becky.p2.generation, '6');
  withMeta = model.applyMetadata(withMeta, 'feed_dog', valid.value);
  assert.equal(withMeta.part1.version, 1, 'unchanged greeting keeps its version');
  withMeta = model.applyMetadata(withMeta, 'feed_dog', { ...valid.value, part1: { text: 'Woof, {name}!' } });
  assert.equal(withMeta.part1.version, 2, 'changed greeting bumps the version');
  assert.equal(withMeta.stars, 2);
  // The JSON is the source of truth: omitted fields are removed.
  assert.equal(model.applyMetadata(withMeta, 'feed_dog', { label: 'Feed', part1: { text: 'Woof, {name}!' } }).stars, undefined);

  const cleared = model.clearMetadata(withMeta);
  assert.equal(cleared.enabled, false);
  assert.equal(cleared.label, undefined);
  assert.equal(cleared.part1.version, 2, 'version history survives so old clip keys are never reused');
});

test('prefetch queue runs by priority, dedupes, and re-runs jobs updated mid-flight', async () => {
  const { createPrefetchQueue } = createLoader()('services/prefetchQueue.ts');
  const queue = createPrefetchQueue({ concurrency: 1 });
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  queue.enqueue({ id: 'blocker', priority: 0, run: async () => { order.push('blocker'); await gate; } });
  queue.enqueue({ id: 'catalog', priority: 3, run: async () => { order.push('catalog'); } });
  queue.enqueue({ id: 'evening', priority: 2, run: async () => { order.push('evening'); } });
  queue.enqueue({ id: 'evening', priority: 2, run: async () => { order.push('evening-dupe'); } });
  queue.prioritize(['catalog'], 0);
  queue.enqueue({ id: 'blocker', priority: 1, run: async () => { order.push('blocker-rerun'); } });
  assert.deepEqual(queue.counts(), { pending: 2, running: 1 });

  release();
  await queue.whenIdle();
  assert.deepEqual(order, ['blocker', 'catalog', 'blocker-rerun', 'evening-dupe']);
});

test('captions follow cloud updates and deletions, and announce each change', async () => {
  const files = new Map();
  const storage = new Map();
  const fsMock = {
    documentDirectory: 'file:///docs/',
    EncodingType: { Base64: 'base64' },
    async getInfoAsync(path) {
      if (files.has(path)) return { exists: true, isDirectory: false, size: files.get(path).length };
      return { exists: path.endsWith('/'), isDirectory: path.endsWith('/') };
    },
    async makeDirectoryAsync() {},
    async readAsStringAsync(path) {
      if (!files.has(path)) throw new Error('ENOENT');
      return files.get(path);
    },
    async deleteAsync(path) { files.delete(path); },
    async moveAsync({ from, to }) { files.set(to, files.get(from)); files.delete(from); },
    async downloadAsync(url, path) { files.set(path, url); return { status: 200 }; },
    async readDirectoryAsync() { return []; },
  };
  const kv = new Map();
  const asyncStorage = {
    getItem: async (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: async (k, v) => { kv.set(k, v); },
    removeItem: async (k) => { kv.delete(k); },
    getAllKeys: async () => [...kv.keys()],
    removeMany: async (keys) => keys.forEach((k) => kv.delete(k)),
  };
  let catalogCaptions = { path: 'avatars/becky/brush_teeth_captions.json', generation: '1' };
  const load = createLoader({
    'expo-file-system/legacy': fsMock,
    '@react-native-async-storage/async-storage': asyncStorage,
    './firebase': { db: {}, storage: {}, ensureAuth: async () => ({ uid: 'u' }) },
    'firebase/firestore': { doc: () => ({}), getDoc: async () => ({ exists: () => false }) },
    'firebase/storage': {
      ref: (_s, p) => ({ p }),
      getDownloadURL: async ({ p }) => storage.get(p),
      getMetadata: async () => { throw Object.assign(new Error('unused'), { code: 'storage/object-not-found' }); },
    },
    './activityCatalog': {
      getCatalogAssetRef: (_key, _avatar, kind) => (kind === 'captions' ? catalogCaptions : null),
      getCatalogImageRef: () => null,
    },
  });
  const assetSync = load('services/assetSync.ts');
  const events = [];
  assetSync.subscribeAssetUpdates((event) => events.push(event));
  const local = 'file:///docs/captions/becky_brush_teeth.json';
  const cues = (text) => JSON.stringify([{ start: 0, end: 1, text }]);

  // Captions served as their own contents (downloadAsync writes the "URL" verbatim).
  storage.set(catalogCaptions.path, cues('v1'));
  assert.equal((await assetSync.syncActivityMedia('brush_teeth', 'becky')).captions, 'downloaded');
  assert.equal(JSON.parse(files.get(local))[0].text, 'v1');
  assert.equal((await assetSync.syncActivityMedia('brush_teeth', 'becky')).captions, 'fresh', 'unchanged → no download');

  // Overwritten in the cloud → new generation → replaced on device and announced.
  storage.set(catalogCaptions.path, cues('v2'));
  catalogCaptions = { ...catalogCaptions, generation: '2' };
  assert.equal((await assetSync.syncActivityMedia('brush_teeth', 'becky')).captions, 'updated');
  assert.equal(JSON.parse(files.get(local))[0].text, 'v2');
  assert.deepEqual(events, [{ activityKey: 'brush_teeth', avatarId: 'becky', kind: 'captions' }]);
  assert.equal(files.has(`${local}.download`), false);

  // A broken upload never replaces the working copy.
  storage.set(catalogCaptions.path, 'not json');
  catalogCaptions = { ...catalogCaptions, generation: '3' };
  assert.equal((await assetSync.syncActivityMedia('brush_teeth', 'becky')).captions, 'failed');
  assert.equal(JSON.parse(files.get(local))[0].text, 'v2');

  // Deleted in the cloud → removed on device and announced (merged captions get rebuilt).
  catalogCaptions = null;
  assert.equal((await assetSync.syncActivityMedia('brush_teeth', 'becky')).captions, 'updated');
  assert.equal(files.has(local), false);
  assert.equal(events.length, 2);
  assert.equal(await assetSync.ensureCaptionsData('brush_teeth', 'becky'), null);
});
