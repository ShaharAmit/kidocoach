import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineString } from 'firebase-functions/params';
import {
  ANALYTICS_DELETION_DELAY_MS,
  processAnalyticsDeletionBatch,
  type AnalyticsDeletionDeps,
} from './analyticsDeletionModel';

// Website analytics erasure for deleted accounts (docs/WEB_ANALYTICS.md §5). The runtime service
// account needs the GA4 Editor role on the property; BigQuery access comes from its project role.
const ga4PropertyId = defineString('GA4_PROPERTY_ID', { default: '539565663' });
const ga4ExportDataset = defineString('GA4_EXPORT_DATASET', { default: 'analytics_539565663' });

const BIGQUERY_LOCATION = 'US';
const SCOPE_CLOUD = 'https://www.googleapis.com/auth/cloud-platform';
const SCOPE_GA_EDIT = 'https://www.googleapis.com/auth/analytics.edit';
const MAX_BATCHES_PER_RUN = 8;

const queue = () => getFirestore().collection('analytics_deletions');

/** Called by `deleteAccount`; the erasure runs once the GA4 export has caught up. */
export async function queueAnalyticsDeletion(uid: string): Promise<void> {
  await queue().doc(uid).set({ requestedAt: Timestamp.now(), attempts: 0 });
}

const tokens = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(scope: string): Promise<string> {
  const cached = tokens.get(scope);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const response = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=${encodeURIComponent(scope)}`,
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  if (!response.ok) throw new Error(`metadata token ${response.status}`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  tokens.set(scope, { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

async function googleApi(url: string, scope: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${await accessToken(scope)}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${url.split('?')[0]}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

type BigQueryResult = {
  jobComplete?: boolean;
  jobReference: { jobId: string };
  schema?: { fields: { name: string }[] };
  rows?: { f: { v: unknown }[] }[];
  pageToken?: string;
};

async function bigQuery(sql: string, params: Record<string, string[]>): Promise<Record<string, unknown>[]> {
  const project = process.env.GCLOUD_PROJECT;
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`;
  let result: BigQueryResult = await googleApi(base, SCOPE_CLOUD, {
    method: 'POST',
    body: {
      query: sql,
      useLegacySql: false,
      location: BIGQUERY_LOCATION,
      timeoutMs: 50_000,
      parameterMode: 'NAMED',
      queryParameters: Object.entries(params).map(([name, values]) => ({
        name,
        parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
        parameterValue: { arrayValues: values.map((value) => ({ value })) },
      })),
    },
  });
  const rows: Record<string, unknown>[] = [];
  for (;;) {
    if (result.jobComplete) {
      const names = result.schema?.fields.map((f) => f.name) ?? [];
      for (const row of result.rows ?? []) rows.push(Object.fromEntries(row.f.map((c, i) => [names[i], c.v])));
      if (!result.pageToken) return rows;
    }
    const query = new URLSearchParams({ location: BIGQUERY_LOCATION, timeoutMs: '50000' });
    if (result.pageToken) query.set('pageToken', result.pageToken);
    result = await googleApi(`${base}/${result.jobReference.jobId}?${query}`, SCOPE_CLOUD);
  }
}

const deps: AnalyticsDeletionDeps = {
  get exportDataset() {
    return `${process.env.GCLOUD_PROJECT}.${ga4ExportDataset.value()}`;
  },
  async listDue(limit) {
    const cutoff = Timestamp.fromMillis(Date.now() - ANALYTICS_DELETION_DELAY_MS);
    const snap = await queue().where('requestedAt', '<=', cutoff).orderBy('requestedAt').limit(limit).get();
    return snap.docs.map((doc) => doc.id);
  },
  bigQuery,
  async submitGaDeletion(user) {
    await googleApi(
      `https://analyticsadmin.googleapis.com/v1alpha/properties/${ga4PropertyId.value()}:submitUserDeletion`,
      SCOPE_GA_EDIT,
      { method: 'POST', body: user },
    );
  },
  async markDone(uids) {
    const batch = getFirestore().batch();
    for (const uid of uids) batch.delete(queue().doc(uid));
    await batch.commit();
  },
  async markFailed(uids, error) {
    const message = error instanceof Error ? error.message : String(error);
    const batch = getFirestore().batch();
    for (const uid of uids) {
      batch.update(queue().doc(uid), { attempts: FieldValue.increment(1), lastError: message.slice(0, 500), lastAttemptAt: Timestamp.now() });
    }
    await batch.commit();
  },
};

export const processAnalyticsDeletions = onSchedule(
  { schedule: 'every day 04:00', timeZone: 'UTC', memory: '256MiB', timeoutSeconds: 540 },
  async () => {
    let erased = 0;
    try {
      for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
        const count = await processAnalyticsDeletionBatch(deps);
        erased += count;
        if (count === 0) break;
      }
    } catch (error) {
      console.error('[processAnalyticsDeletions] Batch failed; it is retried tomorrow:', error);
    }
    console.info(`[processAnalyticsDeletions] Erased analytics for ${erased} deleted account(s)`);
  },
);
