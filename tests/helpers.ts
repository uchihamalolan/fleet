import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { FleetStore } from '../src/db/store';
import type { ReceivedPacket } from '../src/domain/types';

const sqlite3 = await sqlite3InitModule();

/** Same store code as the browser, backed by an in-memory SQLite (Node can't use OPFS). */
export function memoryStore(vehicleIds = ['TRK-001', 'TRK-002']): FleetStore {
  const store = new FleetStore(new sqlite3.oo1.DB(':memory:', 'c'));
  store.upsertVehicles(vehicleIds.map((id) => ({ id, name: id, depot: 'Test', model: 'T' })));
  return store;
}

export const MIN = 60_000;
export const T0 = Date.UTC(2026, 0, 1, 12);

export function pkt(vehicleId: string, seq: number, ts: number, signals: ReceivedPacket['signals'], receivedTs = ts + 500): ReceivedPacket {
  return { vehicleId, seq, ts, receivedTs, signals };
}
