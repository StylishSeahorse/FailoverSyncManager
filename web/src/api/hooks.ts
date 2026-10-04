import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get } from './client';
import type { SystemStatus } from './types';

/** Dashboard status; polls faster while an operation is running. */
export function useSystemStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: () => get<SystemStatus>('/api/system/status'),
    refetchInterval: (q) => (q.state.data?.controller.currentOperationId ? 1500 : 5000),
    refetchIntervalInBackground: true,
  });
}

export function useList<T>(key: string, path: string | null, refetchInterval?: number) {
  return useQuery({ queryKey: [key, path], queryFn: () => get<T>(path!), enabled: !!path, refetchInterval });
}

export function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => Promise.all((keys.length ? keys : ['status']).map((k) => qc.invalidateQueries({ queryKey: [k] })));
}
