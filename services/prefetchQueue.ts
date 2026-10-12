/**
 * Small priority queue for background asset work. Lower `priority` runs first; equal priorities
 * run in enqueue order. Jobs are deduped by `id`: re-enqueueing a pending job only raises its
 * priority, and re-enqueueing a running job schedules exactly one re-run after it finishes (so a
 * catalog update that lands mid-download is never lost).
 */

export interface QueueJob {
  id: string;
  priority: number;
  run: () => Promise<void>;
}

interface PendingJob extends QueueJob {
  seq: number;
}

export interface PrefetchQueue {
  enqueue(job: QueueJob): void;
  /** Moves pending jobs with these ids up to `priority` (no-op for unknown ids). */
  prioritize(ids: string[], priority: number): void;
  /** Resolves once nothing is pending or running. */
  whenIdle(): Promise<void>;
  onIdle(listener: () => void): () => void;
  counts(): { pending: number; running: number };
  clear(): void;
}

export function createPrefetchQueue(options: { concurrency: number }): PrefetchQueue {
  const pending: PendingJob[] = [];
  const running = new Map<string, QueueJob>();
  const rerun = new Map<string, QueueJob>();
  const idleListeners = new Set<() => void>();
  let idleWaiters: (() => void)[] = [];
  let seq = 0;

  const isIdle = () => pending.length === 0 && running.size === 0;

  function settleIdle() {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach((resolve) => resolve());
    idleListeners.forEach((listener) => listener());
  }

  function pump() {
    while (running.size < options.concurrency && pending.length > 0) {
      pending.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const job = pending.shift()!;
      running.set(job.id, job);
      job
        .run()
        .catch((err) => console.warn(`[PrefetchQueue] Job ${job.id} failed:`, err))
        .finally(() => {
          running.delete(job.id);
          const again = rerun.get(job.id);
          if (again) {
            rerun.delete(job.id);
            pending.push({ ...again, seq: seq++ });
          }
          pump();
          settleIdle();
        });
    }
  }

  return {
    enqueue(job) {
      if (running.has(job.id)) {
        const queued = rerun.get(job.id);
        rerun.set(job.id, queued ? { ...job, priority: Math.min(queued.priority, job.priority) } : job);
        return;
      }
      const existing = pending.find((item) => item.id === job.id);
      if (existing) {
        existing.priority = Math.min(existing.priority, job.priority);
        existing.run = job.run;
        return;
      }
      pending.push({ ...job, seq: seq++ });
      pump();
    },
    prioritize(ids, priority) {
      for (const item of pending) {
        if (ids.includes(item.id)) item.priority = Math.min(item.priority, priority);
      }
    },
    whenIdle() {
      if (isIdle()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    onIdle(listener) {
      idleListeners.add(listener);
      return () => {
        idleListeners.delete(listener);
      };
    },
    counts() {
      return { pending: pending.length, running: running.size };
    },
    clear() {
      pending.length = 0;
      rerun.clear();
      settleIdle();
    },
  };
}
