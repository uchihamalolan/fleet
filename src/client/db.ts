import * as Comlink from 'comlink';
import type { QueryClient } from '@tanstack/react-query';
import type { DbApi } from '../worker/db.worker';

const worker = new Worker(new URL('../worker/db.worker.ts', import.meta.url), { type: 'module', name: 'fleet-db' });

/** Typed proxy to the database worker. Every call is an async message, never blocking the UI. */
export const db = Comlink.wrap<DbApi>(worker);

/**
 * Re-run visible queries whenever the worker commits. Throttled so a burst of
 * ingest batches turns into at most one refetch per interval.
 */
export function bindInvalidation(qc: QueryClient, intervalMs = 1500) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  const fire = () => {
    timer = null;
    last = Date.now();
    void qc.invalidateQueries();
  };
  void db.subscribe(
    Comlink.proxy(() => {
      if (timer) return;
      timer = setTimeout(fire, Math.max(0, intervalMs - (Date.now() - last)));
    }),
  );
}
