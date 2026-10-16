import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { bindInvalidation, db } from '../client/db';
import { useAttention, useFeed, useOnline } from '../client/hooks';
import type { BootInfo } from '../worker/db.worker';
import { UndoProvider } from './components/Undo';
import { clock } from './format';
import { AttentionPage } from './pages/AttentionPage';
import { FleetPage } from './pages/FleetPage';
import { SimulatorPage } from './pages/SimulatorPage';
import { VehiclePage } from './pages/VehiclePage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Queries hit the local database, so they must keep running while offline.
      networkMode: 'always',
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      // Freshness is a function of time; refresh even when nothing new arrived.
      refetchInterval: 10_000,
      placeholderData: (prev: unknown) => prev,
    },
    mutations: { networkMode: 'always' },
  },
});
bindInvalidation(queryClient);

export function App() {
  const [boot, setBoot] = useState<BootInfo | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    db.init().then(setBoot, (e: unknown) => setBootError(e instanceof Error ? e.message : String(e)));
    void navigator.storage?.persist?.();
  }, []);

  if (bootError) return <div className="boot error-text">Failed to open the local database: {bootError}</div>;
  if (!boot)
    return (
      <div className="boot" role="status">
        <h1>Fleet Console</h1>
        <p>Opening local database… On first launch this seeds 500 trucks; older history keeps loading in the background.</p>
      </div>
    );

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <UndoProvider>
          <Shell boot={boot} />
        </UndoProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function Shell({ boot }: { boot: BootInfo }) {
  const online = useOnline();
  const [outage, setOutage] = useState(false);
  const { data: feed } = useFeed();
  const { data: att } = useAttention();
  const needs = att?.items.filter((i) => i.attention === 'needs_action').length ?? 0;
  const connected = online && !outage;

  useEffect(() => {
    void db.setConnected(connected);
  }, [connected]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Fleet Console</span>
        <nav className="nav">
          <NavLink to="/" end>
            Fleet
          </NavLink>
          <NavLink to="/attention">
            Attention{' '}
            {needs > 0 && (
              <span className="count" aria-label={`${needs} need action`}>
                {needs}
              </span>
            )}
          </NavLink>
          <NavLink to="/simulator">Simulator & data</NavLink>
        </nav>
        <span className="feed-state" role="status">
          {feed && feed.backfillRemaining > 0 && (
            <span className="tag">⟳ Loading history {Math.round((1 - feed.backfillRemaining) * 100)}%</span>
          )}
          {!connected ? (
            <span className="tag warn">⚠ Feed offline · {feed?.queued ?? 0} queued</span>
          ) : feed?.running ? (
            <span className="tag ok">● Live · {clock(feed.lastIngestTs)}</span>
          ) : (
            <span className="tag">❚❚ Simulator paused</span>
          )}
          <span className={`tag ${boot.storage === 'opfs' ? '' : 'warn'}`} title={boot.storageNote ?? 'Telemetry is stored in SQLite on the Origin Private File System'}>
            {boot.storage === 'opfs' ? '⛁ Stored on device' : '⚠ Not persisted'}
          </span>
        </span>
      </header>
      {boot.storageNote && <div className="banner warn">{boot.storageNote}</div>}
      {!connected && (
        <div className="banner warn" role="status">
          {online ? 'Feed outage simulated.' : 'You are offline.'} Showing data stored on this device. Readings will turn stale as time passes; nothing is assumed
          about what happened since the last packet.
        </div>
      )}
      <main>
        <Routes>
          <Route path="/" element={<FleetPage />} />
          <Route path="/vehicles/:id" element={<VehiclePage />} />
          <Route path="/attention" element={<AttentionPage />} />
          <Route path="/simulator" element={<SimulatorPage boot={boot} outage={outage} setOutage={setOutage} />} />
        </Routes>
      </main>
    </div>
  );
}
