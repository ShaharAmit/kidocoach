// Pure rules for erasing a deleted family's website analytics (GA4 + BigQuery export).

/** GA4 updates daily export tables for up to 72 h after the day ends; wait past that before erasing. */
export const ANALYTICS_DELETION_DELAY_MS = 4 * 24 * 60 * 60 * 1000;
export const ANALYTICS_DELETION_BATCH = 25;

export interface AnalyticsDeletionDeps {
  /** UIDs whose deletion is due, oldest first. */
  listDue(limit: number): Promise<string[]>;
  /** Runs a GoogleSQL statement with named `STRING` array parameters; returns rows as plain objects. */
  bigQuery(sql: string, params: Record<string, string[]>): Promise<Record<string, unknown>[]>;
  /** GA4 Admin `submitUserDeletion` for one identifier. */
  submitGaDeletion(user: { userId: string } | { clientId: string }): Promise<void>;
  markDone(uids: string[]): Promise<void>;
  markFailed(uids: string[], error: unknown): Promise<void>;
  exportDataset: string; // `project.dataset`
}

export function isAnalyticsDeletionDue(requestedAtMs: number, nowMs: number): boolean {
  return nowMs - requestedAtMs >= ANALYTICS_DELETION_DELAY_MS;
}

/** `events_YYYYMMDD` / `events_intraday_YYYYMMDD` suffixes; anything else is never written into SQL. */
export function isExportTableSuffix(suffix: unknown): suffix is string {
  return typeof suffix === 'string' && /^(intraday_)?\d{8}$/.test(suffix);
}

const strings = (rows: Record<string, unknown>[], key: string): string[] =>
  [...new Set(rows.map((row) => row[key]).filter((v): v is string => typeof v === 'string' && v.length > 0))];

/**
 * Erases one batch: finds the browsers (`user_pseudo_id` = GA client ID) each UID used, submits GA4
 * deletions for the user IDs and those client IDs (pre-sign-in events), then deletes the matching
 * rows from every export table that has them. A batch is retried whole on any failure; every step
 * is idempotent.
 */
export async function processAnalyticsDeletionBatch(deps: AnalyticsDeletionDeps): Promise<number> {
  const uids = await deps.listDue(ANALYTICS_DELETION_BATCH);
  if (uids.length === 0) return 0;
  try {
    const events = `\`${deps.exportDataset}.events_*\``;
    const clientIds = strings(
      await deps.bigQuery(
        `SELECT DISTINCT user_pseudo_id FROM ${events} WHERE user_id IN UNNEST(@uids)`,
        { uids },
      ),
      'user_pseudo_id',
    );
    const match = 'user_id IN UNNEST(@uids) OR user_pseudo_id IN UNNEST(@clientIds)';
    const suffixes = strings(
      await deps.bigQuery(`SELECT DISTINCT _TABLE_SUFFIX AS suffix FROM ${events} WHERE ${match}`, { uids, clientIds }),
      'suffix',
    ).filter(isExportTableSuffix);

    for (const userId of uids) await deps.submitGaDeletion({ userId });
    for (const clientId of clientIds) await deps.submitGaDeletion({ clientId });
    for (const suffix of suffixes) {
      await deps.bigQuery(`DELETE FROM \`${deps.exportDataset}.events_${suffix}\` WHERE ${match}`, { uids, clientIds });
    }
    await deps.markDone(uids);
    return uids.length;
  } catch (error) {
    await deps.markFailed(uids, error);
    throw error;
  }
}
