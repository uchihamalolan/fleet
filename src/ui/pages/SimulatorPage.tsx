import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { db } from '../../client/db';
import { useFeed, useStats } from '../../client/hooks';
import { SCENARIOS } from '../../sim/simulator';
import type { BootInfo } from '../../worker/db.worker';
import { bytes, clock } from '../format';

export function SimulatorPage({ boot, outage, setOutage }: { boot: BootInfo; outage: boolean; setOutage: (v: boolean) => void }) {
  const qc = useQueryClient();
  const { data: stats } = useStats();
  const { data: feed } = useFeed();
  const storage = useQuery({ queryKey: ['storage'], queryFn: () => db.storageEstimate() });
  const [log, setLog] = useState<string[]>([]);
  const note = (s: string) => setLog((l) => [`${clock(Date.now())} ${s}`, ...l].slice(0, 12));

  const scenario = useMutation({
    mutationFn: (id: (typeof SCENARIOS)[number]['id']) => db.scenario(id),
    onSuccess: (affected, id) => {
      note(`${SCENARIOS.find((s) => s.id === id)!.label}: ${affected.length ? affected.join(', ') : 'no vehicle affected'}`);
      void qc.invalidateQueries();
    },
  });
  const replay = useMutation({
    mutationFn: () => db.replay(1000),
    onSuccess: (r) => {
      note(`Replayed ${r.received} packets → ${r.inserted} new, ${r.duplicates} duplicates ignored (rows ${r.packetsBefore} → ${r.packetsAfter})`);
      void qc.invalidateQueries();
    },
  });

  return (
    <div className="page sim-page">
      <section className="panel">
        <h2>Telemetry feed</h2>
        <p className="small muted">
          The simulator stands in for the vehicles and the mobile network. Its packets go through the same idempotent ingest path a real feed would use.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={() => db.setRunning(!feed?.running).then(() => qc.invalidateQueries())}>
            {feed?.running ? '❚❚ Pause simulator' : '▶ Resume simulator'}
          </button>
          <label className="check">
            <input type="checkbox" checked={outage} onChange={(e) => setOutage(e.target.checked)} />
            Simulate feed outage (packets queue up, then arrive as a backlog)
          </label>
        </div>
        <p className="small">
          Status: {feed?.running ? 'running' : 'paused'} · {feed?.connected ? 'connected' : `disconnected, ${feed?.queued ?? 0} packets queued`} · last
          commit {clock(feed?.lastIngestTs)}
          {feed?.lastBatch && ` (${feed.lastBatch.inserted} new, ${feed.lastBatch.duplicates} dup)`}
        </p>
      </section>

      <section className="panel">
        <h2>Scenarios</h2>
        <div className="scenario-grid">
          {SCENARIOS.map((s) => (
            <button key={s.id} className="btn scenario" onClick={() => scenario.mutate(s.id)}>
              <strong>{s.label}</strong>
              <small>{s.help}</small>
            </button>
          ))}
          <button className="btn scenario" onClick={() => replay.mutate()}>
            <strong>Replay last 1,000 packets</strong>
            <small>Re-ingests stored packets verbatim. Should add zero rows.</small>
          </button>
        </div>
        {log.length > 0 && (
          <ol className="log small">
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel">
        <h2>Local database</h2>
        <dl className="quality">
          <div>
            <dt>Storage</dt>
            <dd>{boot.storage === 'opfs' ? 'OPFS (persistent)' : 'In-memory (not persisted)'}</dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>SQLite {boot.sqliteVersion}</dd>
          </div>
          <div>
            <dt>DB size</dt>
            <dd>{bytes(stats?.dbBytes)}</dd>
          </div>
          <div>
            <dt>Origin quota used</dt>
            <dd>
              {bytes(storage.data?.usage)} / {bytes(storage.data?.quota)}
            </dd>
          </div>
          <div>
            <dt>Eviction-protected</dt>
            <dd>{storage.data?.persisted === null ? 'unknown' : storage.data?.persisted ? 'yes' : 'no (best-effort)'}</dd>
          </div>
          <div>
            <dt>Packets stored</dt>
            <dd>{stats?.packets.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Received / inserted</dt>
            <dd>
              {stats?.received.toLocaleString()} / {stats?.inserted.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt>Duplicates ignored</dt>
            <dd>{stats?.duplicates.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Conflicting duplicates</dt>
            <dd>{stats?.conflicts}</dd>
          </div>
          <div>
            <dt>Late arrivals</dt>
            <dd>{stats?.late.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Open alerts</dt>
            <dd>{stats?.openAlerts}</dd>
          </div>
          <div>
            <dt>Event-time range</dt>
            <dd>
              {clock(stats?.oldestEventTs)} – {clock(stats?.newestEventTs)}
            </dd>
          </div>
        </dl>
        <div className="btn-row">
          {storage.data?.persisted === false && (
            <button className="btn" onClick={() => navigator.storage.persist().then(() => storage.refetch())}>
              Request persistent storage
            </button>
          )}
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm('Delete all local telemetry, alerts and actions, then re-seed?')) return;
              await db.reset();
              location.reload();
            }}
          >
            Reset local database
          </button>
        </div>
      </section>
    </div>
  );
}
