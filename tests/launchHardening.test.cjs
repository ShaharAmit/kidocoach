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

/** Evaluates top-level server declarations (functions/consts) straight from functions/src/index.ts. */
function serverDeclarations(names, injected = {}) {
  const source = fs.readFileSync(path.join(root, 'functions/src/index.ts'), 'utf8');
  const blocks = names.map((name) => {
    const match = new RegExp(
      `^(?:async )?(?:function ${name}\\(|const ${name}\\b)[\\s\\S]*?\\n(?:\\}|\\};)\\n`,
      'm'
    ).exec(source);
    assert.ok(match, `${name} not found in functions/src/index.ts`);
    return match[0];
  });
  const injectedNames = Object.keys(injected);
  return new Function(
    ...injectedNames,
    `${transpile(blocks.join('\n'))}; return { ${names.join(', ')} };`
  )(...injectedNames.map((key) => injected[key]));
}

test('client and server Part 1 audio cache keys are identical', () => {
  const client = loadModule('services/part1Audio.ts', {
    'expo-file-system/legacy': {},
    'firebase/functions': {},
    'firebase/storage': {},
    './firebase': {},
    './assetSync': { localAudioPath: (key) => key },
    '../types': {},
  });
  const server = serverDeclarations(['normalizeNameToken', 'PART1_TEMPLATES', 'buildPart1AudioKey']);
  const cases = [
    ['wake_up', 'Liam', undefined, undefined],
    ['eat_dinner', 'נועה', undefined, 'man'],
    ['brush_teeth', 'Mary-Ann', 'cheerful', 'woman'],
    ['go_to_sleep', 'Zoë', 'calm', 'man'],
  ];

  for (const args of cases) {
    assert.equal(client.buildPart1AudioKey(...args), server.buildPart1AudioKey(...args), args.join('/'));
  }
  // Keys stay stable so a reused name always hits its existing clip.
  assert.equal(client.buildPart1AudioKey('wake_up', 'Liam'), 'p1_wake_up_liam_encouraging_woman');
});

test('only clips from the broken 3.8 prompt are regenerated; all other cached clips are reused', () => {
  const { isReusableReadyClip } = serverDeclarations(['TTS_PROMPT_VERSION', 'isReusableReadyClip']);
  // 3.1-era docs never stored ttsModel.
  assert.equal(isReusableReadyClip({ status: 'ready' }), true);
  assert.equal(isReusableReadyClip({ status: 'ready', ttsModel: 'gemini-3.1-flash-tts-preview' }), true);
  // Broken: 3.8 before the speechMetadata fix spoke the style direction aloud.
  assert.equal(isReusableReadyClip({ status: 'ready', ttsModel: 'gemini-3.8-flash-tts' }), false);
  // Fixed 3.8 clips are reused like any other.
  assert.equal(
    isReusableReadyClip({ status: 'ready', ttsModel: 'gemini-3.8-flash-tts', ttsPromptVersion: 2 }),
    true
  );
});

test('device re-fetches only double-wrapped (broken prompt) Part 1 clips', async () => {
  const files = {
    '/docs/audio/p1_wake_up_liam_encouraging_woman.wav': { size: 100000, at44: 'AAAAAA==' },
    '/docs/audio/p1_brush_teeth_liam_encouraging_woman.wav': { size: 100000, at44: 'UklGRg==' },
  };
  const client = loadModule('services/part1Audio.ts', {
    'expo-file-system/legacy': {
      documentDirectory: '/docs/',
      EncodingType: { Base64: 'base64' },
      async getInfoAsync(uri) {
        const file = files[uri];
        return file ? { exists: true, size: file.size } : { exists: false };
      },
      async readAsStringAsync(uri, options) {
        assert.deepEqual(options, { encoding: 'base64', position: 44, length: 4 });
        return files[uri].at44;
      },
    },
    'firebase/functions': {},
    'firebase/storage': {},
    './firebase': {},
    './assetSync': { localAudioPath: (key) => `/docs/audio/${key}.wav` },
    '../types': {},
  });

  assert.equal(
    await client.getReadyPart1AudioPath('wake_up', 'Liam'),
    '/docs/audio/p1_wake_up_liam_encouraging_woman.wav'
  );
  assert.equal(await client.getReadyPart1AudioPath('brush_teeth', 'Liam'), null);
});

test('TTS sends tone as speechMetadata, never inside the spoken transcript', async () => {
  const requests = [];
  const geminiClient = {
    models: {
      async generateContent(request) {
        requests.push(request);
        return { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(2048) } }] } }] };
      },
    },
  };
  const { synthesizeWithGeminiTts } = serverDeclarations(
    ['buildToneStyle', 'mapVoiceToGemini', 'extractAudioBuffer', 'synthesizeWithGeminiTts'],
    { geminiClient, geminiModel: 'gemini-3.8-flash-tts' }
  );

  for (const tone of ['cheerful', 'encouraging', 'calm', undefined]) {
    await synthesizeWithGeminiTts('Good morning, Liam!', tone, 'man');
  }

  for (const request of requests) {
    const [content] = request.contents;
    assert.deepEqual(content.parts.map((part) => part.text), ['Good morning, Liam!']);
    assert.ok(content.parts[0].speechMetadata.style.length > 0);
    assert.equal(request.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  }
  assert.match(requests[2].contents[0].parts[0].speechMetadata.style, /calm/);
});

test('TTS WAV output is re-wrapped with only its data chunk; raw PCM is still wrapped', () => {
  const { ttsAudioToWav } = serverDeclarations(['pcm16ToWav', 'ttsAudioToWav']);
  const samples = Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 256));
  const trailer = Buffer.from('LIST\x04\x00\x00\x00junk', 'binary');

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length + trailer.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);

  const fromWav = ttsAudioToWav(Buffer.concat([header, samples, trailer]));
  assert.equal(fromWav.length, 44 + samples.length);
  assert.equal(fromWav.readUInt32LE(40), samples.length);
  assert.equal(fromWav.readUInt32LE(28), 48000);
  assert.ok(fromWav.subarray(44).equals(samples));

  const fromPcm = ttsAudioToWav(samples);
  assert.equal(fromPcm.toString('ascii', 0, 4), 'RIFF');
  assert.ok(fromPcm.subarray(44).equals(samples));
});
