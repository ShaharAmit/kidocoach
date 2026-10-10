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

function loadModule(filename, mocks = {}) {
  const cache = new Map();
  function load(absolute) {
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const localRequire = (id) => {
      if (id in mocks) return mocks[id];
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(absolute), id);
        if (base === path.join(root, 'theme')) return { colors: load(path.join(root, 'theme/colors.ts')).colors };
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
  return load(path.resolve(root, filename));
}

/** Evaluates the server's normalizeNameToken straight from functions/src/index.ts. */
function serverNormalizeNameToken() {
  const source = fs.readFileSync(path.join(root, 'functions/src/index.ts'), 'utf8');
  const match = /function normalizeNameToken\(childName: string\): string \{[\s\S]*?\n\}\n/.exec(source);
  assert.ok(match, 'normalizeNameToken not found in functions/src/index.ts');
  return new Function(`${transpile(match[0])}; return normalizeNameToken;`)();
}

test('client and server child-name tokens are identical and collision-free', () => {
  const client = loadModule('utils/nameToken.ts');
  const server = serverNormalizeNameToken();
  const names = ['Liam', 'Mary-Ann', " O'Neil ", 'Zoë', 'נועה', 'יואב', 'Анна', 'Jean Luc'];

  for (const name of names) assert.equal(client.normalizeNameToken(name), server(name), name);

  // Latin names keep their pre-existing keys, so their cached clips stay valid.
  assert.equal(client.normalizeNameToken('Liam'), 'liam');
  assert.equal(client.normalizeNameToken('Mary-Ann'), 'mary_ann');
  // Same-length Hebrew names used to collapse to "____" and share one clip.
  assert.notEqual(client.normalizeNameToken('נועה'), client.normalizeNameToken('יואב'));

  assert.equal(client.isValidChildName('נועה'), true);
  assert.equal(client.isValidChildName('Liam2'), false);
  assert.equal(client.isValidChildName('x'.repeat(31)), false);
});

test('activity reminders fire 2 minutes before every step, wrapping midnight', async () => {
  const scheduled = [];
  const cancelled = [];
  const notifications = {
    setNotificationHandler() {},
    SchedulableTriggerInputTypes: { DAILY: 'daily', TIME_INTERVAL: 'timeInterval' },
    AndroidImportance: { MAX: 5 },
    async getAllScheduledNotificationsAsync() {
      return [
        { identifier: 'old-1', content: { data: { routineId: 'morning', userId: 'u1' } } },
        { identifier: 'other', content: { data: { routineId: 'evening', userId: 'u1' } } },
      ];
    },
    async cancelScheduledNotificationAsync(id) { cancelled.push(id); },
    async scheduleNotificationAsync(request) {
      scheduled.push(request);
      return `id-${scheduled.length}`;
    },
  };
  const { scheduleRoutineNotification } = loadModule('services/notifications.ts', {
    'expo-notifications': notifications,
    'expo-device': { isDevice: true },
    'react-native': { Platform: { OS: 'ios' } },
  });

  const firstId = await scheduleRoutineNotification({
    id: 'morning',
    userId: 'u1',
    childName: 'Liam',
    avatarId: 'becky',
    scheduledTime: '07:00',
    activityStack: [['wake_up'], ['brush_teeth', 'wash_face'], ['get_dressed'], ['make_bed']],
    stepTimes: ['07:00', '00:01', 'bad', '07:30'],
  });

  assert.deepEqual(cancelled, ['old-1']);
  assert.equal(firstId, 'id-1');
  assert.deepEqual(
    scheduled.map(({ trigger }) => [trigger.type, trigger.hour, trigger.minute, trigger.channelId]),
    [
      ['daily', 6, 58, 'routine-reminders'],
      ['daily', 23, 59, 'routine-reminders'],
      ['daily', 7, 28, 'routine-reminders'],
    ]
  );
  assert.equal(scheduled[1].content.title, '🦷 Brush Teeth + Wash Face in 2 minutes');
  assert.equal(scheduled[1].content.data.stepIndex, 1);
});
