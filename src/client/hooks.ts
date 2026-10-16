import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { db } from './db';

export const useFleet = () => useQuery({ queryKey: ['fleet'], queryFn: () => db.getFleet() });
export const useVehicle = (id: string) => useQuery({ queryKey: ['vehicle', id], queryFn: () => db.getVehicle(id) });
export const useHistory = (id: string, windowMs: number) =>
  useQuery({ queryKey: ['history', id, windowMs], queryFn: () => db.getHistory(id, windowMs) });
export const useRecentPackets = (id: string) => useQuery({ queryKey: ['packets', id], queryFn: () => db.getRecentPackets(id, 40) });
export const useAttention = () => useQuery({ queryKey: ['attention'], queryFn: () => db.getAttention() });
export const useStats = () => useQuery({ queryKey: ['stats'], queryFn: () => db.getStats() });
export const useFeed = () => useQuery({ queryKey: ['feed'], queryFn: () => db.getFeedStatus() });

export function useAlertActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries();
  const act = useMutation({
    mutationFn: (v: { episodeId: number; action: 'ack' | 'snooze'; snoozeMs?: number }) => db.act(v.episodeId, v.action, v.snoozeMs),
    onSettled: done,
  });
  const undo = useMutation({ mutationFn: (actionId: number) => db.undo(actionId), onSettled: done });
  return { act, undo };
}

/** Wall clock that re-renders every `ms`, for "x minutes ago" labels. */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
