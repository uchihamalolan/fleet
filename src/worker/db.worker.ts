/// <reference lib="webworker" />
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import * as Comlink from 'comlink';
import { FleetStore } from '../db/store';
import { advance, applyScenario, createFleet, type Scenario, type SimState } from '../sim/simulator';

/**
 * Everything database- or simulation-related runs in this dedicated worker so the
 * UI thread never blocks on SQLite or on generating/ingesting telemetry.
 */

const FLEET_SIZE = 500;
const SEED = 20251016;
const HISTORY_MS = 4 * 3600_000;
const TICK_MS = 2_000;
const RECONCILE_EVERY_MS = 5_000;
/** If the console was closed longer than this, older telemetry is skipped (shows as a gap). */
const MAX_CATCH_UP_MS = 30 * 60_000;
const RETAIN_MS = 24 * 3600_000;

export type StorageMode = 'opfs' | 'memory';

export interface BootInfo {
  storage: StorageMode;
  storageNote: string | null;
  seeded: boolean;
  sqliteVersion: string;
}

export interface FeedStatus {
  running: boolean;
  connected: boolean;
  queued: number;
  lastIngestTs: number | null;
  lastBatch: { inserted: number; duplicates: number } | null;
  /** Fraction of seeded history still being written in the background (0 when done). */
  backfillRemaining: number;
}

let store: FleetStore | null = null;
let boot: BootInfo | null = null;
let sim: SimState | null = null;
let running = true;
let connected = true;
/** Packets that "arrived" while the browser was offline; delivered on reconnect. */
let queued: Parameters<FleetStore['ingest']>[0] = [];
let lastIngestTs: number | null = null;
let lastBatch: FeedStatus['lastBatch'] = null;
let lastReconcile = 0;
let lastSave = 0;
let version = 0;
let backfill: Parameters<FleetStore['ingest']>[0] = [];
let backfillTotal = 0;

function startBackfill(packets: typeof backfill) {
  backfill = packets;
  backfillTotal = packets.length;
  setTimeout(runBackfill, 0);
}

function runBackfill() {
  if (!store) return;
  store.ingest(backfill.splice(0, 4000));
  notify();
  if (backfill.length) setTimeout(runBackfill, 50);
  else store.setMeta('seed_backfilled', '1');
}
const listeners = new Set<(v: number) => void>();

function notify() {
  version++;
  for (const l of listeners) {
    try {
      l(version);
    } catch {
      listeners.delete(l);
    }
  }
}

/** Resolves true once the lock is held (it is then held until the worker dies). */
function acquireLifetimeLock(name: string, timeoutMs: number): Promise<boolean> {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks
      .request(name, { signal: AbortSignal.timeout(timeoutMs) }, () => {
        resolve(true);
        return new Promise<never>(() => {});
      })
      .catch(() => resolve(false));
  });
}

async function openDatabase(): Promise<{ db: Database; storage: StorageMode; note: string | null; version: string }> {
  const sqlite3 = await sqlite3InitModule();
  let lastError: unknown;
  // The SAH pool needs exclusive access handles. Hold a Web Lock for the worker's
  // lifetime: a reloaded page's new worker waits until the old one is gone, and a
  // second tab gives up after a few seconds and falls back to memory.
  const locked = await acquireLifetimeLock('fleet-console-db', 5_000);
  if (locked) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'fleet-sahpool', directory: '/fleet-console', initialCapacity: 6 });
      const db = new pool.OpfsSAHPoolDb('/fleet.sqlite3');
      // WAL needs shared memory, which this VFS does not provide; use a rollback journal.
      // A larger page cache keeps index pages in memory during bulk ingest instead of
      // re-reading them through synchronous OPFS calls.
      db.exec('PRAGMA journal_mode = TRUNCATE; PRAGMA cache_size = -32768; PRAGMA temp_store = MEMORY;');
      return { db, storage: 'opfs', note: null, version: sqlite3.version.libVersion };
    } catch (e) {
      lastError = e;
    }
  } else {
    lastError = new Error('locked: database held by another tab');
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  const inUse = /access handle|NoModificationAllowed|locked|createSyncAccessHandle/i.test(msg);
  return {
    db: new sqlite3.oo1.DB(':memory:', 'c'),
    storage: 'memory',
    note: inUse
      ? 'The local database is open in another tab. This tab is running on a temporary in-memory copy that will not be saved.'
      : `Persistent storage (OPFS) is unavailable in this browser (${msg}). Data is kept in memory only and will be lost on reload.`,
    version: sqlite3.version.libVersion,
  };
}

function persistSim(now: number) {
  if (!store || !sim) return;
  store.saveSimState({ sim, queued, savedAt: now });
  lastSave = now;
}

async function init(): Promise<BootInfo> {
  if (boot) return boot;
  const { db, storage, note, version: v } = await openDatabase();
  store = new FleetStore(db);
  const now = Date.now();
  let seeded = false;

  const saved = store.loadSimState<{ sim: SimState; queued: typeof queued }>();
  if (saved && store.vehicleCount() === FLEET_SIZE) {
    sim = saved.sim;
    queued = saved.queued ?? [];
    // Resume: replay the period the console was closed as a catch-up sync, but cap it.
    const gap = now - sim.clock;
    if (gap > MAX_CATCH_UP_MS) advance(sim, now - MAX_CATCH_UP_MS, { emit: false });
    // Reloaded before the seeded history finished loading: regenerate it (the simulator
    // is deterministic) and re-ingest. Packets already stored are ignored as duplicates.
    const plan = store.getMeta('seed_plan');
    if (plan && store.getMeta('seed_backfilled') !== '1') {
      const { start, end, cut } = JSON.parse(plan) as { start: number; end: number; cut: number };
      const replay = createFleet(SEED, FLEET_SIZE, start, end);
      startBackfill(advance(replay, end).filter((p) => p.ts < cut));
    }
  } else {
    // First run: build the fleet and backfill a few hours of history.
    sim = createFleet(SEED, FLEET_SIZE, now - HISTORY_MS, now);
    store.upsertVehicles(sim.vehicles.map(({ id, name, depot, model }) => ({ id, name, depot, model })));
    // Ingest the most recent slice first so the console is usable in about a second,
    // then backfill older history in the background. Order does not matter for
    // correctness: latest state only moves forward by event time.
    const plan = { start: now - HISTORY_MS, end: now, cut: now - 20 * 60_000 };
    store.setMeta('seed_plan', JSON.stringify(plan));
    const packets = advance(sim, now);
    store.ingest(packets.filter((p) => p.ts >= plan.cut));
    startBackfill(packets.filter((p) => p.ts < plan.cut));
    seeded = true;
  }
  tick();
  store.reconcileAlerts(now);
  lastReconcile = now;
  persistSim(now);
  setInterval(tick, TICK_MS);
  boot = { storage, storageNote: note, seeded, sqliteVersion: v };
  return boot;
}

function tick() {
  if (!store || !sim) return;
  const now = Date.now();
  let changed = false;
  if (running) {
    const arrived = advance(sim, now);
    if (connected) {
      const batch = queued.length ? queued.concat(arrived) : arrived;
      queued = [];
      if (batch.length) {
        const r = store.ingest(batch);
        lastIngestTs = now;
        lastBatch = { inserted: r.inserted, duplicates: r.duplicates };
        if (r.vehicles.length) store.reconcileAlerts(now, r.vehicles);
        changed = true;
      }
    } else {
      queued.push(...arrived);
      changed = arrived.length > 0;
    }
  }
  if (now - lastReconcile >= RECONCILE_EVERY_MS) {
    // Time passing alone changes freshness, so re-evaluate every vehicle periodically.
    store.reconcileAlerts(now);
    lastReconcile = now;
    changed = true;
  }
  if (now - lastSave > 10_000) {
    persistSim(now);
    store.prune(now - RETAIN_MS);
  }
  if (changed) notify();
}

function ensure(): FleetStore {
  if (!store) throw new Error('Database not initialised');
  return store;
}

/** Queries reconcile first so a stale reading can never surface as an active alert. */
function fresh(now: number): FleetStore {
  const s = ensure();
  if (now - lastReconcile > 1_000) {
    s.reconcileAlerts(now);
    lastReconcile = now;
  }
  return s;
}

const api = {
  init,
  subscribe(cb: (v: number) => void) {
    listeners.add(cb);
  },
  getFleet: () => {
    const now = Date.now();
    return { now, rows: fresh(now).getFleet(now) };
  },
  getVehicle: (id: string) => {
    const now = Date.now();
    return { now, vehicle: fresh(now).getVehicle(id, now) };
  },
  getHistory: (id: string, windowMs: number) => {
    const now = Date.now();
    return { now, history: ensure().getHistory(id, now - windowMs, now) };
  },
  getRecentPackets: (id: string, limit = 40) => ensure().getRecentPackets(id, limit),
  getAttention: () => {
    const now = Date.now();
    return { now, ...fresh(now).getAttention(now) };
  },
  getStats: () => ensure().stats(),
  getFeedStatus: (): FeedStatus => ({
    running,
    connected,
    queued: queued.length,
    lastIngestTs,
    lastBatch,
    backfillRemaining: backfillTotal ? backfill.length / backfillTotal : 0,
  }),

  act(episodeId: number, action: 'ack' | 'snooze', snoozeMs?: number) {
    const now = Date.now();
    const id = ensure().act(episodeId, action, now, action === 'snooze' ? now + (snoozeMs ?? 30 * 60_000) : null);
    notify();
    return id;
  },
  undo(actionId: number) {
    ensure().undoAction(actionId, Date.now());
    notify();
  },

  setRunning(v: boolean) {
    running = v;
    notify();
  },
  setConnected(v: boolean) {
    connected = v;
    if (v) tick();
    notify();
  },
  scenario(s: Scenario) {
    if (!sim) return [];
    const affected = applyScenario(sim, s);
    tick();
    return affected;
  },
  /** Re-ingests the most recent packets verbatim. Must not create any new rows. */
  replay(limit = 1000) {
    const s = ensure();
    const before = s.stats().packets;
    const r = s.ingest(s.recentPackets(limit));
    notify();
    return { ...r, packetsBefore: before, packetsAfter: s.stats().packets };
  },
  async reset() {
    const s = ensure();
    sim = null;
    s.db.exec(
      'DELETE FROM alert_actions; DELETE FROM alert_events; DELETE FROM alert_episodes; DELETE FROM latest_signal; DELETE FROM packets; DELETE FROM sim_state; DELETE FROM vehicles; DELETE FROM meta;',
    );
    s.db.exec('VACUUM');
  },
  async storageEstimate() {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    return { usage: est?.usage ?? null, quota: est?.quota ?? null, persisted: persisted ?? null };
  },
};

export type DbApi = typeof api;

Comlink.expose(api);
