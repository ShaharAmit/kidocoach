const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function load(relativePath) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(() => ({}), module, module.exports);
  return module.exports;
}

const events = load('website/src/services/analyticsEvents.ts');

test('site_entry classifies how the visitor arrived', () => {
  const entry = (search, referrer = '') => events.describeEntry('/', search, referrer, 'kidocoach.app');
  assert.equal(entry('?ref=Jane&utm_source=blog').entry_type, 'partner_link');
  assert.equal(entry('?ref=Jane').affiliate_code, 'jane');
  assert.equal(entry('?coupon=SPRING').entry_type, 'coupon_link');
  assert.equal(entry('?utm_source=newsletter').entry_type, 'campaign');
  assert.equal(entry('', 'https://www.google.com/search?q=kids').entry_type, 'referral_site');
  assert.equal(entry('', 'https://www.google.com/search?q=kids').referrer_host, 'google.com',
    'only the host, never the referring path or query');
  assert.equal(entry('', 'https://kidocoach.app/terms').entry_type, 'direct', 'own site is not a referrer');
  assert.equal(entry('').entry_type, 'direct');
});

test('page URLs keep only campaign parameters', () => {
  assert.equal(events.sanitizeSearch('?email=a%40b.com&ref=jane&token=x&utm_medium=social'),
    '?ref=jane&utm_medium=social');
  assert.equal(events.sanitizeSearch('?oobCode=secret'), '');
});

test('questionnaire_complete sends categories only, never the child name, birth date or gender', () => {
  const params = events.questionnaireParams({
    age: 7, wakeTime: '07:00', bedtime: '20:00',
    answers: { stuckPoints: ['teeth', 'dressing'], masteredTasks: ['none_yet'], motivationStyle: 'stars',
      helpLevel: 'some', morningSpeed: 'slow' },
  });
  assert.equal(params.child_age_band, '6-8');
  assert.equal(params.stuck_points, 'dressing,teeth');
  assert.deepEqual(Object.keys(params).filter((key) => /name|birth|gender|email/.test(key)), []);
  assert.deepEqual([2, 3, 4, 5, 6, 8, 9, 12].map(events.ageBand),
    ['2-3', '2-3', '4-5', '4-5', '6-8', '6-8', '9-12', '9-12']);
});

test('analytics loads nothing before consent and the banner offers an equal Reject', () => {
  const service = fs.readFileSync(path.join(root, 'website/src/services/analytics.ts'), 'utf8');
  assert.doesNotMatch(service, /^import (?!type)[^\n]*firebase\/analytics/m, 'SDK is only imported dynamically');
  assert.match(service, /export function initAnalytics\(\): void \{\n {2}if \(getConsentChoice\(\) === 'granted'\) start\(\);/);
  assert.match(service, /globalPrivacyControl === true/, 'GPC is honored');
  assert.match(service, /ad_storage: 'denied'/);
  assert.match(service, /allow_google_signals: false/);
  assert.match(service, /page_location: pageLocation\(window\.location\.pathname, window\.location\.search\)/,
    'hit-level page URL is sanitized, not the raw address bar');
  assert.match(service, /setDefaultEventParameters\(\{ page_location: location \}\)/);
  const banner = fs.readFileSync(path.join(root, 'website/src/components/ConsentBanner.tsx'), 'utf8');
  assert.match(banner, /setAnalyticsConsent\('denied'\)\}>Reject</);
  assert.match(banner, /setAnalyticsConsent\('granted'\)\}>Accept</);
});

const deletion = load('functions/src/analyticsDeletionModel.ts');

function deletionDeps({ uids = ['uid1'], fail } = {}) {
  const log = [];
  return {
    log,
    deps: {
      exportDataset: 'proj.analytics_1',
      listDue: async () => uids,
      bigQuery: async (sql, params) => {
        log.push(['sql', sql, params]);
        if (fail === 'bigQuery' && sql.startsWith('DELETE')) throw new Error('boom');
        if (sql.includes('DISTINCT user_pseudo_id')) return [{ user_pseudo_id: 'c.1' }, { user_pseudo_id: 'c.1' }];
        if (sql.includes('_TABLE_SUFFIX')) return [{ suffix: '20261101' }, { suffix: 'intraday_20261102' }, { suffix: 'x`; DROP' }];
        return [];
      },
      submitGaDeletion: async (user) => log.push(['ga', user]),
      markDone: async (ids) => log.push(['done', ids]),
      markFailed: async (ids) => log.push(['failed', ids]),
    },
  };
}

test('deleted accounts lose GA4 and BigQuery analytics, including pre-sign-in browser events', async () => {
  const { deps, log } = deletionDeps();
  assert.equal(await deletion.processAnalyticsDeletionBatch(deps), 1);
  assert.deepEqual(log.filter(([k]) => k === 'ga').map(([, u]) => u), [{ userId: 'uid1' }, { clientId: 'c.1' }]);
  const deletes = log.filter(([k, sql]) => k === 'sql' && sql.startsWith('DELETE'));
  assert.deepEqual(deletes.map(([, sql]) => sql.match(/`([^`]+)`/)[1]),
    ['proj.analytics_1.events_20261101', 'proj.analytics_1.events_intraday_20261102'],
    'only real export table suffixes are written into SQL');
  assert.deepEqual(deletes[0][2], { uids: ['uid1'], clientIds: ['c.1'] });
  assert.deepEqual(log.at(-1), ['done', ['uid1']]);
});

test('analytics erasure waits for the GA4 export and retries a failed batch', async () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(deletion.isAnalyticsDeletionDue(0, 3 * day), false, 'late events still land for 72 h');
  assert.equal(deletion.isAnalyticsDeletionDue(0, 4 * day), true);

  const { deps, log } = deletionDeps({ fail: 'bigQuery' });
  await assert.rejects(deletion.processAnalyticsDeletionBatch(deps));
  assert.deepEqual(log.at(-1), ['failed', ['uid1']]);
  assert.equal(log.some(([k]) => k === 'done'), false);

  assert.equal(await deletion.processAnalyticsDeletionBatch(deletionDeps({ uids: [] }).deps), 0);
});
