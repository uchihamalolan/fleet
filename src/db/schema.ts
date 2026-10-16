export const SCHEMA_VERSION = 1;

/**
 * Event-log schema.
 *
 * - `packets` is the append-only raw log. Identity = (vehicle_id, seq); duplicates
 *   are rejected by the primary key. Signals are nullable columns, so a partial
 *   packet simply leaves the others NULL.
 * - `latest_signal` is a materialised "latest by event time" projection, one row per
 *   (vehicle, signal). It is only moved forward by a strictly newer event time, so
 *   out-of-order and backfilled packets never overwrite newer data. It can be rebuilt
 *   from `packets` at any time.
 * - `alert_episodes`/`alert_events` record alert state transitions derived from fresh
 *   readings. `alert_actions` is the operator's action log (undo = mark undone).
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  depot      TEXT NOT NULL,
  model      TEXT NOT NULL,
  duplicates INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS packets (
  vehicle_id     TEXT    NOT NULL,
  seq            INTEGER NOT NULL,
  event_ts       INTEGER NOT NULL,
  received_ts    INTEGER NOT NULL,
  soc            REAL,
  range_km       REAL,
  odometer_km    REAL,
  speed_kph      REAL,
  ignition       INTEGER,
  battery_temp_c REAL,
  lat            REAL,
  lng            REAL,
  PRIMARY KEY (vehicle_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS packets_by_vehicle_time ON packets (vehicle_id, event_ts);

CREATE TABLE IF NOT EXISTS latest_signal (
  vehicle_id  TEXT    NOT NULL,
  signal      TEXT    NOT NULL,
  value       REAL    NOT NULL,
  event_ts    INTEGER NOT NULL,
  received_ts INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (vehicle_id, signal)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS alert_episodes (
  id            INTEGER PRIMARY KEY,
  vehicle_id    TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  severity      TEXT    NOT NULL,
  peak_severity TEXT    NOT NULL,
  value         REAL    NOT NULL,
  value_ts      INTEGER NOT NULL,
  opened_ts     INTEGER NOT NULL,
  closed_ts     INTEGER,
  close_reason  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_episode
  ON alert_episodes (vehicle_id, kind) WHERE closed_ts IS NULL;
CREATE INDEX IF NOT EXISTS episodes_by_vehicle ON alert_episodes (vehicle_id, opened_ts);

CREATE TABLE IF NOT EXISTS alert_events (
  id         INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES alert_episodes(id),
  ts         INTEGER NOT NULL,
  type       TEXT    NOT NULL,
  severity   TEXT,
  value      REAL
);
CREATE INDEX IF NOT EXISTS alert_events_by_episode ON alert_events (episode_id);

CREATE TABLE IF NOT EXISTS alert_actions (
  id                 INTEGER PRIMARY KEY,
  episode_id         INTEGER NOT NULL REFERENCES alert_episodes(id),
  action             TEXT    NOT NULL,
  severity_at_action TEXT    NOT NULL,
  until_ts           INTEGER,
  created_ts         INTEGER NOT NULL,
  undone_ts          INTEGER
);
CREATE INDEX IF NOT EXISTS alert_actions_by_episode ON alert_actions (episode_id);

CREATE TABLE IF NOT EXISTS sim_state (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  json  TEXT NOT NULL
);
`;
