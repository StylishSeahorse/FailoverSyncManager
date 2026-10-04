import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get, qs } from '../api/client';
import type { AuditEvent } from '../api/types';
import { Badge, ErrorBox, fmtTime, JsonView, Panel } from '../components/ui';

const SEVERITIES = ['CRITICAL', 'ERROR', 'WARNING', 'SUCCESS', 'INFO', 'DEBUG'];
const CATEGORIES = ['failover', 'change', 'health', 'provider', 'config', 'auth', 'security', 'system'];
const PAGE = 100;

export function Events() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState({ q: '', severity: '', category: '', from: '', to: '' });
  const [severity, setSeverity] = useState('');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const events = useInfiniteQuery({
    queryKey: ['events', applied],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      get<AuditEvent[]>(
        `/api/events${qs({
          q: applied.q,
          severity: applied.severity,
          category: applied.category,
          from: applied.from ? new Date(applied.from).toISOString() : undefined,
          to: applied.to ? new Date(applied.to).toISOString() : undefined,
          before: pageParam,
          limit: PAGE,
        })}`,
      ),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1]!.id : undefined),
    refetchInterval: 10000,
  });
  const rows = events.data?.pages.flat() ?? [];

  return (
    <div className="stack">
      <h1>Event log</h1>
      <Panel>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ q, severity, category, from, to });
          }}
        >
          <label>
            Search
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. DNS, Nextcloud, admin" />
          </label>
          <label>
            Severity
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">All</option>
              {SEVERITIES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All</option>
              {CATEGORIES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            From
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <div className="row" style={{ alignSelf: 'end' }}>
            <button className="primary" type="submit">
              Search
            </button>
          </div>
        </form>
      </Panel>
      <ErrorBox error={events.error} />
      <Panel>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Severity</th>
                <th>Category</th>
                <th>Actor</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} onClick={() => setOpen(open === e.id ? null : e.id)} style={{ cursor: 'pointer' }}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtTime(e.at)}</td>
                  <td>
                    <Badge status={e.severity} />
                  </td>
                  <td className="muted">{e.category}</td>
                  <td>{e.actorName}</td>
                  <td>
                    {e.message}
                    {open === e.id && (
                      <JsonView value={{ action: e.action, ip: e.ip, siteId: e.siteId, applicationId: e.applicationId, operationId: e.operationId, details: e.details }} />
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && !events.isLoading && (
                <tr>
                  <td colSpan={5} className="muted">
                    No matching events.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {events.hasNextPage && (
          <div style={{ marginTop: 12 }}>
            <button disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
              {events.isFetchingNextPage ? 'Loading…' : 'Load older events'}
            </button>
          </div>
        )}
      </Panel>
    </div>
  );
}
