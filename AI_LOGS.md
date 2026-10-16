# AI usage

## Tools

- **Claude Code**: implementation of the application, tests and documentation, driven from the assignment PDF.
  - Conversation: https://claude.ai/code/session_01VKmd9V3ynY5bFLgqHoabAq

> Add exports or share links for any other AI conversations here before submitting.

## Where it helped

- Turning the brief into a data model: raw packet log, latest-by-event-time projection, alert episodes, action log.
- Writing the simulator's fault model and the deterministic, serialisable PRNG.
- Writing the store and e2e tests (dedup, out-of-order, backfill, stale-closes-alert, ack/escalation/undo, OPFS persistence, offline reload).

## Decisions changed during development

These are design decisions revised after measuring or testing during the session:

- **SQLite-wasm instead of the suggested DuckDB-Wasm.** The workload is many small idempotent upserts and point reads. Rationale is in the README.
- **First-run seeding.** Ingesting all 86k seeded packets up front took about 13–35 s in the browser. This was changed to load the newest 20 min first and backfill the rest in the background. The backfill resumes after a reload by deterministically regenerating the seed; already-stored packets are ignored as duplicates.
- **Latest-state upsert.** One upsert per signal per packet was replaced with collapsing each batch to the newest reading per (vehicle, signal), which cut ingest time by about 2.4×.
- **OPFS reload race.** Retrying `installOpfsSAHPoolVfs` does not work (the failed install is cached), so it was replaced with a lifetime Web Lock.
- **Ack semantics.** An ack records the episode's *peak* severity. Recording the current severity would make an acked-after-escalation alert re-raise forever.

> Add your own overrides of AI suggestions here.
