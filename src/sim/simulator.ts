import type { Packet, ReceivedPacket } from '../domain/types';
import { Rng } from './rng';

/**
 * Telemetry simulator: a per-vehicle physical model plus an unreliable network.
 *
 * All state is plain JSON (including the PRNG state) so it can be persisted in the
 * database and resumed after a reload. Time is always passed in, never read from
 * the wall clock, which keeps the simulator deterministic and testable.
 */

export type DriveMode = 'driving' | 'parked' | 'charging';
export type LinkState = 'ok' | 'basement' | 'dead';

export interface SimVehicle {
  id: string;
  name: string;
  depot: string;
  model: string;
  seq: number;
  soc: number;
  odometer: number;
  temp: number;
  lat: number;
  lng: number;
  speed: number;
  mode: DriveMode;
  modeUntil: number;
  nextReportTs: number;
  lastPhysicsTs: number;
  tempBias: number;
  drainPerHour: number;
  /** Battery temperature sensor stopped reporting; other signals keep flowing. */
  tempSensorFaulty: boolean;
  link: LinkState;
  linkUntil: number;
  dieAt: number | null;
  /** Packets produced while out of coverage; uploaded as a backlog on reconnect. */
  buffer: Packet[];
}

export interface NetworkConfig {
  dropRate: number;
  dupRate: number;
  lateRate: number;
  lateMinMs: number;
  lateMaxMs: number;
  /** Probability per vehicle per hour of entering a coverage dead-zone. */
  basementPerHour: number;
  basementMinMs: number;
  basementMaxMs: number;
}

export interface InFlight {
  deliverAt: number;
  packet: Packet;
}

export interface SimState {
  rngState: number;
  clock: number;
  vehicles: SimVehicle[];
  inFlight: InFlight[];
  network: NetworkConfig;
}

export const DEFAULT_NETWORK: NetworkConfig = {
  dropRate: 0.02,
  dupRate: 0.03,
  lateRate: 0.04,
  lateMinMs: 60_000,
  lateMaxMs: 6 * 60_000,
  basementPerHour: 0.02,
  basementMinMs: 15 * 60_000,
  basementMaxMs: 90 * 60_000,
};

const DEPOTS = [
  { name: 'Bengaluru North', lat: 13.1, lng: 77.59 },
  { name: 'Bengaluru South', lat: 12.9, lng: 77.6 },
  { name: 'Hosur', lat: 12.74, lng: 77.83 },
  { name: 'Mysuru', lat: 12.3, lng: 76.64 },
  { name: 'Chennai', lat: 13.08, lng: 80.27 },
];
const MODELS = ['eCargo 7T', 'eCargo 12T', 'CityHaul 4T'];

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const REPORT_INTERVAL: Record<DriveMode, number> = {
  driving: 60 * SEC,
  charging: 120 * SEC,
  parked: 180 * SEC,
};

export function vehicleId(i: number): string {
  return `TRK-${String(i + 1).padStart(3, '0')}`;
}

export function createFleet(seed: number, count: number, start: number, historyEnd = start): SimState {
  const rng = new Rng(seed);
  const vehicles: SimVehicle[] = [];
  for (let i = 0; i < count; i++) {
    const depot = DEPOTS[i % DEPOTS.length]!;
    const roll = rng.next();
    // Seeded distribution so a fresh fleet has a few vehicles in each interesting state.
    const soc = roll < 0.03 ? rng.range(6, 10) : roll < 0.09 ? rng.range(11, 19.5) : rng.range(25, 98);
    const mode = rng.pick<DriveMode>(['driving', 'driving', 'parked', 'charging']);
    vehicles.push({
      id: vehicleId(i),
      name: vehicleId(i),
      depot: depot.name,
      model: rng.pick(MODELS),
      seq: 0,
      soc,
      odometer: rng.range(2_000, 180_000),
      temp: rng.range(22, 32),
      lat: depot.lat + rng.range(-0.15, 0.15),
      lng: depot.lng + rng.range(-0.15, 0.15),
      speed: mode === 'driving' ? rng.range(20, 70) : 0,
      mode,
      modeUntil: start + rng.range(5 * MIN, 60 * MIN),
      nextReportTs: start + rng.range(0, REPORT_INTERVAL[mode]),
      lastPhysicsTs: start,
      tempBias: rng.chance(0.02) ? 14 : rng.range(-2, 3),
      drainPerHour: rng.range(6, 12),
      tempSensorFaulty: rng.chance(0.02),
      link: 'ok',
      linkUntil: 0,
      dieAt: rng.chance(0.012) ? start + rng.range(0.25, 0.9) * Math.max(historyEnd - start, HOUR) : null,
      buffer: [],
    });
  }
  return { rngState: rng.state, clock: start, vehicles, inFlight: [], network: { ...DEFAULT_NETWORK } };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function stepPhysics(v: SimVehicle, t: number, rng: Rng) {
  const dtH = Math.max(0, (t - v.lastPhysicsTs) / HOUR);
  v.lastPhysicsTs = t;

  if (t >= v.modeUntil) {
    if (v.mode === 'driving') {
      v.mode = v.soc < 35 && rng.chance(0.6) ? 'charging' : 'parked';
    } else if (v.mode === 'charging') {
      v.mode = v.soc > 60 && rng.chance(0.5) ? 'driving' : 'parked';
    } else {
      v.mode = v.soc < 25 && rng.chance(0.5) ? 'charging' : 'driving';
    }
    v.modeUntil = t + (v.mode === 'driving' ? rng.range(20, 90) : rng.range(10, 60)) * MIN;
  }

  let tempTarget: number;
  switch (v.mode) {
    case 'driving': {
      v.speed = clamp(v.speed + rng.range(-12, 12), 15, 90);
      v.soc -= v.drainPerHour * dtH;
      v.odometer += v.speed * dtH;
      v.lat += rng.range(-0.004, 0.004);
      v.lng += rng.range(-0.004, 0.004);
      tempTarget = 31 + v.speed / 15 + v.tempBias;
      break;
    }
    case 'charging': {
      v.speed = 0;
      v.soc += 35 * dtH;
      if (v.soc >= 92) v.modeUntil = t;
      tempTarget = 34 + v.tempBias;
      break;
    }
    case 'parked': {
      v.speed = 0;
      tempTarget = 25 + v.tempBias * 0.3;
      break;
    }
  }
  v.soc = clamp(v.soc, 0, 100);
  if (v.mode === 'driving' && v.soc < 2) {
    // Stranded: an empty truck stops and waits for a tow/charger.
    v.mode = 'parked';
    v.speed = 0;
    v.modeUntil = t + rng.range(30, 120) * MIN;
  }
  v.temp += (tempTarget - v.temp) * Math.min(1, dtH * 4) + rng.range(-0.3, 0.3);
}

function makePacket(v: SimVehicle, t: number, rng: Rng): Packet {
  v.seq += 1;
  const s: Packet['signals'] = {};
  const moving = v.mode === 'driving';
  if (moving || rng.chance(0.5)) {
    s.lat = +v.lat.toFixed(5);
    s.lng = +v.lng.toFixed(5);
    s.speed_kph = Math.round(v.speed);
    s.ignition = moving ? 1 : 0;
  }
  if (rng.chance(0.7)) {
    s.soc = +v.soc.toFixed(1);
    s.range_km = Math.round(v.soc * 2.4);
  }
  if (!v.tempSensorFaulty && rng.chance(0.55)) s.battery_temp_c = +v.temp.toFixed(1);
  if (rng.chance(0.15)) s.odometer_km = Math.round(v.odometer);
  if (Object.keys(s).length === 0) s.ignition = moving ? 1 : 0;
  return { vehicleId: v.id, seq: v.seq, ts: Math.round(t), signals: s };
}

function route(state: SimState, v: SimVehicle, p: Packet, t: number, rng: Rng) {
  const n = state.network;
  if (v.link === 'basement') {
    v.buffer.push(p);
    return;
  }
  if (rng.chance(n.dropRate)) return;
  const delay = rng.chance(n.lateRate) ? rng.range(n.lateMinMs, n.lateMaxMs) : rng.range(200, 4 * SEC);
  state.inFlight.push({ deliverAt: t + delay, packet: p });
  if (rng.chance(n.dupRate)) {
    state.inFlight.push({ deliverAt: t + delay + rng.range(SEC, 90 * SEC), packet: { ...p, signals: { ...p.signals } } });
  }
}

function flushBacklog(state: SimState, v: SimVehicle, t: number, rng: Rng) {
  // Backlog upload: oldest first but a few seconds apart, with some reordering.
  let at = t;
  for (const p of v.buffer) {
    at += rng.range(20, 400);
    state.inFlight.push({ deliverAt: at + (rng.chance(0.1) ? rng.range(0, 3 * SEC) : 0), packet: p });
  }
  v.buffer = [];
  v.link = 'ok';
}

/**
 * Advance simulated time to `to` and return the packets that "arrived" in that window,
 * ordered by arrival time. With `emit: false` the vehicles move but nothing is sent
 * (used to skip over long periods the console was closed).
 */
export function advance(state: SimState, to: number, opts: { emit?: boolean } = {}): ReceivedPacket[] {
  const emit = opts.emit ?? true;
  const rng = new Rng(state.rngState);
  const n = state.network;

  for (const v of state.vehicles) {
    while (v.link !== 'dead' && v.nextReportTs <= to) {
      const t = v.nextReportTs;
      if (v.dieAt !== null && t >= v.dieAt) {
        v.link = 'dead';
        v.buffer = [];
        break;
      }
      if (v.link === 'basement' && t >= v.linkUntil) flushBacklog(state, v, t, rng);
      else if (v.link === 'ok' && rng.chance((n.basementPerHour * REPORT_INTERVAL[v.mode]) / HOUR)) {
        v.link = 'basement';
        v.linkUntil = t + rng.range(n.basementMinMs, n.basementMaxMs);
      }
      stepPhysics(v, t, rng);
      const p = makePacket(v, t, rng);
      if (emit) route(state, v, p, t, rng);
      v.nextReportTs = t + REPORT_INTERVAL[v.mode] * rng.range(0.8, 1.2);
    }
    if (v.link === 'basement' && v.linkUntil <= to) flushBacklog(state, v, Math.max(v.linkUntil, state.clock), rng);
  }

  state.clock = to;
  state.rngState = rng.state;

  const due: InFlight[] = [];
  const pending: InFlight[] = [];
  for (const f of state.inFlight) (f.deliverAt <= to ? due : pending).push(f);
  state.inFlight = pending;
  if (!emit) return [];
  due.sort((a, b) => a.deliverAt - b.deliverAt);
  return due.map((f) => ({ ...f.packet, receivedTs: Math.round(f.deliverAt) }));
}

export type Scenario = 'basement' | 'flush' | 'overheat' | 'drain' | 'kill' | 'revive';

export const SCENARIOS: { id: Scenario; label: string; help: string }[] = [
  { id: 'basement', label: 'Send 10 trucks underground', help: 'They buffer packets for 2–6 min, then upload a backlog.' },
  { id: 'flush', label: 'Restore coverage now', help: 'All buffered backlogs upload immediately.' },
  { id: 'overheat', label: 'Overheat a battery', help: 'One driving truck runs hot (>45 °C).' },
  { id: 'drain', label: 'Drain a battery', help: 'One truck drops from ~19% through 10% over a few minutes.' },
  { id: 'kill', label: 'Stop a truck reporting', help: 'A random truck goes silent permanently.' },
  { id: 'revive', label: 'Revive silent trucks', help: 'Silent trucks resume reporting.' },
];

/** Applies an operator-triggered scenario. Returns the affected vehicle ids. */
export function applyScenario(state: SimState, scenario: Scenario): string[] {
  const rng = new Rng(state.rngState);
  const t = state.clock;
  const alive = state.vehicles.filter((v) => v.link === 'ok');
  const affected: string[] = [];
  switch (scenario) {
    case 'basement':
      for (let i = 0; i < 10 && alive.length; i++) {
        const v = alive.splice(rng.int(0, alive.length - 1), 1)[0]!;
        v.link = 'basement';
        v.linkUntil = t + rng.range(2 * MIN, 6 * MIN);
        affected.push(v.id);
      }
      break;
    case 'flush':
      for (const v of state.vehicles)
        if (v.link === 'basement') {
          flushBacklog(state, v, t, rng);
          affected.push(v.id);
        }
      break;
    case 'overheat': {
      const v = rng.pick(alive.filter((x) => !x.tempSensorFaulty));
      if (v) {
        v.mode = 'driving';
        v.modeUntil = t + 30 * MIN;
        v.tempBias = 16;
        v.temp = 46.5;
        v.nextReportTs = Math.min(v.nextReportTs, t);
        affected.push(v.id);
      }
      break;
    }
    case 'drain': {
      const v = rng.pick(alive);
      if (v) {
        v.mode = 'driving';
        v.modeUntil = t + 30 * MIN;
        v.soc = 19;
        v.drainPerHour = 150;
        v.nextReportTs = Math.min(v.nextReportTs, t);
        affected.push(v.id);
      }
      break;
    }
    case 'kill': {
      const v = rng.pick(alive);
      if (v) {
        v.dieAt = t;
        affected.push(v.id);
      }
      break;
    }
    case 'revive':
      for (const v of state.vehicles)
        if (v.link === 'dead') {
          v.link = 'ok';
          v.dieAt = null;
          v.lastPhysicsTs = t;
          v.nextReportTs = t;
          affected.push(v.id);
        }
      break;
  }
  state.rngState = rng.state;
  return affected;
}
