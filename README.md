# Fleet Console (local-first)

A web console for an operator running 500 electric trucks. Telemetry is written to SQLite running in the browser (OPFS-backed, inside a Web Worker). The UI reads from that database. It never renders from an in-memory array.

## Run

```bash
npm install
npm run dev            # http://localhost:5173
# or a production build (enables the offline service worker):
npm run build && npm run preview   # http://localhost:4173
```

Use a recent Chromium, Firefox or Safari (17+). These are the browsers with OPFS sync access handles. On first launch the app seeds 500 trucks. The last 20 minutes load first, and the remaining 4 hours of history backfill in the background (see the "Loading history" chip).

## Tests

```bash
npm test               # Vitest: domain rules, store (real SQLite-wasm, in-memory), simulator, components
npm run typecheck
npm run test:e2e       # Playwright: OPFS persistence across reload, offline reload, ack+undo, replay idempotence
# if Playwright's bundled browser isn't installed: CHROMIUM_PATH=/path/to/chrome npm run test:e2e
```

The store tests run the same `FleetStore` code as the browser, against SQLite-wasm in Node. The only difference is in-memory storage instead of OPFS.

## Architecture

```
main thread (React)                         Web Worker (db.worker.ts)
┌───────────────────────────┐   Comlink   ┌───────────────────────────────────────────┐
│ Pages: Fleet / Vehicle /  │ ──RPC────▶  │ FleetStore (src/db/store.ts)              │
│ Attention / Simulator     │             │   SQLite-wasm  ── opfs-sahpool VFS ── OPFS │
│ TanStack Query (cache)    │ ◀─"changed"─│ Simulator (src/sim) → ingest() every 2 s   │
│ react-virtual (500 rows)  │             │ reconcileAlerts() on ingest + every 5 s    │
└───────────────────────────┘             └───────────────────────────────────────────┘
```

- `src/domain/`: pure, deterministic rules: signal catalogue and freshness budgets, status derivation, alert thresholds, attention state, gap detection. No I/O, fully unit-tested.
- `src/db/`: schema and `FleetStore`: idempotent ingest, latest-state projection, alert episode reconciliation, read models for each view.
- `src/sim/`: seeded, serialisable vehicle and network simulator.
- `src/worker/`: owns the database and simulator, and exposes an async API over Comlink. SQLite work, ingest and simulation never run on the UI thread.
- `src/client/` and `src/ui/`: React. TanStack Query caches worker results. A throttled "changed" callback from the worker invalidates queries, so the UI updates once new telemetry is committed. Queries also refetch every 10 s, because freshness changes as time passes even when nothing arrives.

### Library choices

| Choice | Why | Trade-off |
|---|---|---|
| Vite + React + TS | Fast builds, first-class worker and wasm handling | — |
| **SQLite-wasm (official build) on OPFS** instead of DuckDB-Wasm | The workload is OLTP-shaped: many small idempotent inserts, keyed upserts and point lookups, transactional ingest. SQLite's `opfs-sahpool` VFS is mature and durable, and needs no COOP/COEP headers. DuckDB-Wasm is columnar and great for scans, but its OPFS persistence is younger and per-row upserts are its weak spot. | Weaker for heavy analytics over long history, which would need pre-aggregation |
| Comlink | Typed RPC to the worker with ~1 KB of code | — |
| TanStack Query | Caching, loading states, invalidation. `networkMode: 'always'` keeps local queries running offline | Data passes through a cache, but the cache is always filled from SQL |
| @tanstack/react-virtual | Keeps all 500 rows in one scrollable, sortable list without 500 DOM rows | — |
| react-router | URL-addressable filters (`/?status=critical&stale=1`) and vehicle pages | — |
| Hand-written SVG charts | Lines must break across gaps, and gaps must be drawn. Small and accessible (`aria-label` summary) | No zoom or hover tooltips |
| vite-plugin-pwa | Precaches the app shell and the SQLite wasm, so the console opens with no network | Updates apply on the next load |

## Database and persistence

- **Storage:** `opfs-sahpool` VFS, file `/fleet.sqlite3` in the origin-private file system. Survives reloads and browser restarts. On boot the app calls `navigator.storage.persist()` to ask for eviction protection. The Simulator page shows whether it was granted, plus quota usage.
- **Single writer:** the SAH pool needs exclusive file handles. The worker holds a Web Lock for its lifetime. A reloaded page's new worker waits for the old one to die. A second tab waits 5 s, then falls back to memory.
- **Fallback:** if OPFS is unavailable (old browsers, some private modes) or another tab holds the DB, the app runs on an in-memory SQLite. Behaviour is identical except nothing survives a reload. A banner and the header chip ("⚠ Not persisted") say so. localStorage is never used for telemetry.
- **Journal:** `TRUNCATE` rollback journal. WAL needs shared memory, which this VFS lacks. Each ingest batch is a single transaction.
- **Limits:** OPFS shares the origin quota (typically a large fraction of free disk). Without granted persistence the browser may evict it under storage pressure. Raw packets older than 24 h are pruned; alert history and the latest state are kept. In this headless Chromium, ingest runs at roughly 7k packets/s. That is why first-run history is backfilled in the background.

## Data model (telemetry as an event log)

| Table | Role |
|---|---|
| `packets` | Append-only raw log. PK `(vehicle_id, seq)`. Signals are nullable columns, so partial packets just leave NULLs. Stores both `event_ts` (vehicle clock) and `received_ts` (browser). |
| `latest_signal` | Projection: newest reading per `(vehicle, signal)` **by event time**. The upsert only moves forward (`WHERE excluded.event_ts > latest.event_ts`, tie-break on seq). Late, out-of-order and backfilled packets can never overwrite newer data. Can be rebuilt from `packets` (a test asserts projection == rebuild). |
| `alert_episodes`, `alert_events` | Derived alert lifecycle and its transitions (opened / escalated / de-escalated / recovered / stale). |
| `alert_actions` | Operator action log (ack / snooze). Undo sets `undone_ts`; nothing is deleted. |
| `sim_state`, `meta` | Simulator state (so it resumes after reload) and ingest counters. |

### Packet identity and deduplication

A packet's identity is `(vehicle_id, seq)`. `seq` is a per-vehicle counter assigned by the truck. Ingest is `INSERT OR IGNORE`, so replaying packets, re-delivering duplicates, or re-running a seed after a reload creates nothing new. Duplicates are counted globally and per vehicle. A duplicate id with *different* content counts as a **conflict**: the first write wins and the conflict is reported. The Simulator page's "Replay last 1,000 packets" shows this live (0 new rows), and an e2e test asserts it.

Assumption: `seq` never resets. Real firmware would need `(vehicle_id, boot_id, seq)` or a content hash. That is noted under limitations.

### Event time vs receipt time

- Freshness, alerts, history order and gaps all use **event time**.
- Receipt time is used to flag **late** packets (> 1 min between production and arrival) and is shown on the vehicle page.
- Packets claiming an event time more than 2 min ahead of receipt (clock skew) are stored but never become "latest". Otherwise they would look fresh forever.

## Simulator

Each truck has a simple physical model: driving, parked or charging; SOC drain and charge; battery temperature tracking speed and a per-truck bias; odometer; position. It reports every ~60 s while driving, ~120 s while charging and ~180 s while parked, with ±20% jitter. The network in front of it is deliberately unreliable:

| Required imperfection | How |
|---|---|
| Partial packets | Each packet carries a random subset (SOC ~70%, temp ~55%, odometer ~15%, location only when moving or 50%). 2% of trucks have a dead temp sensor, so other signals stay fresh while temp goes stale. |
| Duplicates | 3% of packets are re-delivered 1–90 s later |
| Out-of-order / late | 4% delayed 1–6 min; others 0.2–4 s jitter |
| Missing intervals | 2% dropped outright |
| Stop reporting | ~1% of trucks die during the seeded history; "Stop a truck reporting" scenario |
| Backlog after disconnection | Trucks randomly enter dead-zones for 15–90 min, buffer packets, then upload the backlog in a burst. "Send 10 trucks underground" does it on demand. |

The simulator is seeded and its whole state (including the PRNG) is plain JSON. It is deterministic, unit-tested, and persisted, so it resumes after a reload. If the console was closed for more than 30 min, the vehicles are fast-forwarded without emitting packets, and that period shows up as a real gap. When the **browser goes offline** (or "Simulate feed outage" is ticked), arriving packets queue up as if held by a server and are delivered as a backlog on reconnect. Meanwhile the UI keeps working from local data, and readings honestly turn stale.

## Status, freshness and alert rules

**Per-signal freshness** (event-time age at "now"): SOC, range and battery temp 10 min; speed, ignition and location 5 min; odometer 60 min. Each signal is `fresh`, `stale` or `missing` independently. A fresh GPS packet does not refresh a 40-minute-old SOC.

**Vehicle status** (deterministic, `assessVehicle`), in precedence order:

1. **Offline**: no packet of any kind for 30 min.
2. **Critical**: a *fresh* reading crosses a critical threshold.
3. **Warning**: a *fresh* reading crosses a warning threshold.
4. **Can't verify**: still reporting, but SOC or battery temp is stale or missing.
5. **Healthy**: SOC and temp fresh and within limits.

**Thresholds:** SOC < 20% warning; SOC < 10% critical (one escalating `battery_soc` alert, not two); battery temp > 45 °C critical. Boundaries are strict ("below", "above").

**Alert episodes** (`reconcileAlerts`, run after each ingest batch, every 5 s, and before every read):

- A fresh breach with no open episode opens one. Its time is the reading's event time.
- If the severity changes, the episode escalates or de-escalates. A critical SOC alert de-escalates to warning when SOC rises but stays < 20%.
- A fresh reading within limits closes it as **recovered**.
- A stale or missing reading closes it as **stale**, at `reading time + freshness budget`. **Stale data never keeps or creates an alert claim.** The truck moves to "Can't verify", and the Attention queue lists it under *Can't verify* with its last known value.
- Late backlogs of old breaching readings do not raise alerts, because they are not fresh (tested).

**Operator actions** (`attentionState`):

- **Acknowledge** covers the episode's peak severity at the time of acking. If the episode later escalates above that, it returns to *Needs action* marked "escalated". De-escalation never re-raises it.
- **Snooze 30 m / 2 h** hides the item until then, or sooner if it escalates.
- **Undo / Restore**: every action shows an Undo toast, and the Snoozed and Acknowledged tabs have *Restore*. Both mark the action `undone`; the previous action, if any, applies again.
- Actions belong to one episode. If the episode closes (recovered or stale) and the condition later reappears, a new episode starts un-acknowledged. A situation the operator could no longer see should not stay silenced.
- Acks never change the vehicle's *status*. The status reflects the truth; handling state is shown separately.

**Deterministic vs heuristic**

- *Deterministic:* dedup, latest-by-event-time, thresholds, status precedence, episode transitions, attention state. All are pure functions of the stored log, the action log and `now`.
- *Heuristic:* the freshness budgets and the 30-min offline cutoff (tuned to the simulated report rates), the 1-min "late" and 5-min "gap" thresholds, triage ordering inside a status, the 2-min clock-skew tolerance, and the absence of hysteresis (a value oscillating around 20% will open and close episodes).

## Product and UI decisions

- **Fleet overview first answers "where do I look?"** Five status segments with counts and a one-line definition double as filters. The list defaults to *most urgent first*: alerts, then trucks whose last known value was alerting but is now unverifiable, then other unverifiable or offline trucks, then healthy ones. All 500 rows sit in one virtualised table with search, depot, sort, "unhandled alerts only" and "stale battery data" filters. Filter state lives in the URL.
- **Uncertainty is first-class.** Every value shows its age. Stale values are italic and muted with a "⏱ stale" label. Missing values say "no data". "Can't verify" is its own status rather than being folded into healthy or alerting.
- **Never colour alone.** Every status and severity has a glyph and a text label (◆ Critical, ▲ Warning, ? Can't verify, ⊘ Offline, ✓ Healthy). Attention states are text tags. Charts have text summaries.
- **Vehicle detail** answers "what's the condition, what's missing, what changed?": the current assessment with reasons and inline actions; every signal's value, freshness, event and receipt time, and trust window; 1/4/24 h charts with thresholds and hatched missing intervals; data-quality counts (gaps, late, duplicates); the alert and action timeline; and the raw recent packets showing which signals each carried.
- **Attention queue:** Needs action, Snoozed, Acknowledged, Can't verify (informational, not alerts), Closed in the last 6 h (with recovered vs data-went-stale).
- **Deliberately not shown:** a map (location is shown as text; a map adds weight without helping triage battery health), and range/odometer in the fleet table (they are derived or slow-changing and do not affect urgency).

## Known limitations / with more time

- `seq` is assumed never to reset. I would use `(vehicle_id, boot_id, seq)` and a content hash for conflict detection.
- Single-tab writer. Other tabs could proxy to the lock holder over BroadcastChannel instead of falling back to memory.
- No hysteresis or debounce on thresholds. I would add a configurable recovery band and minimum-duration rules.
- Freshness budgets are global per signal. Ideally they would be per vehicle model and per reporting mode (parked trucks report less often).
- No auth or multi-operator attribution on actions, and no real backend sync. In a real deployment the simulator would be replaced by a sync endpoint feeding the same `ingest()`.
- Long-range analytics (days/weeks) would need downsampled rollup tables or DuckDB alongside SQLite.
- Seeding runs at about 7k packets/s in the browser. Bulk paths (JSON `json_each` inserts) could raise that.

## AI tools used

See [`AI_LOGS.md`](AI_LOGS.md).
