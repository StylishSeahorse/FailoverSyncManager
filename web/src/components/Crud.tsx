import { useState, type ReactNode } from 'react';
import { del, patch, post } from '../api/client';
import { useInvalidate, useList } from '../api/hooks';
import type { Role } from '../api/types';
import { useAuth } from '../auth';
import { SimpleForm, type Field } from './Form';
import { ConfirmDialog, Dialog, ErrorBox, JsonView, Panel } from './ui';

export interface Column<T> {
  label: string;
  render: (row: T) => ReactNode;
}

export interface RowAction<T> {
  label: string;
  role?: Role;
  run: (row: T) => Promise<unknown>;
}

/**
 * List + create + edit + delete for one API collection. Row actions
 * (validate, discover, run) show their JSON result in a dialog.
 */
export function Crud<T extends { id: string }>(props: {
  title: string;
  queryKey: string;
  listPath: string;
  itemPath?: (row: T) => string;
  createPath?: string;
  columns: Column<T>[];
  createFields?: Field[];
  editFields?: Field[];
  editRole?: Role;
  actions?: RowAction<T>[];
  extra?: ReactNode;
  empty?: string;
  invalidate?: string[];
}) {
  const { can } = useAuth();
  const list = useList<T[]>(props.queryKey, props.listPath);
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  const [deleting, setDeleting] = useState<T | null>(null);
  const [result, setResult] = useState<{ title: string; value: unknown; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const editRole = props.editRole ?? 'admin';
  const itemPath = props.itemPath ?? ((r: T) => `${props.createPath ?? props.listPath}/${r.id}`);
  const refresh = () => invalidate(props.queryKey, 'status', ...(props.invalidate ?? []));

  return (
    <Panel
      title={props.title}
      actions={
        props.createFields && can(editRole) && (
          <button className="primary small" onClick={() => setCreating(true)}>
            Add
          </button>
        )
      }
    >
      {props.extra}
      <ErrorBox error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {props.columns.map((c) => (
                <th key={c.label}>{c.label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data?.map((row) => (
              <tr key={row.id}>
                {props.columns.map((c) => (
                  <td key={c.label}>{c.render(row)}</td>
                ))}
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    {props.actions
                      ?.filter((a) => can(a.role ?? 'operator'))
                      .map((a) => (
                        <button
                          key={a.label}
                          className="small"
                          disabled={busy === `${row.id}:${a.label}`}
                          onClick={async () => {
                            setBusy(`${row.id}:${a.label}`);
                            try {
                              const value = await a.run(row);
                              if (value !== undefined) setResult({ title: a.label, value });
                              void refresh();
                            } catch (e) {
                              setResult({ title: a.label, value: { error: (e as Error).message }, error: true });
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          {busy === `${row.id}:${a.label}` ? '…' : a.label}
                        </button>
                      ))}
                    {props.editFields && can(editRole) && (
                      <button className="small" onClick={() => setEditing(row)}>
                        Edit
                      </button>
                    )}
                    {can(editRole) && props.createPath !== undefined && (
                      <button className="small ghost" onClick={() => setDeleting(row)}>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {list.data && !list.data.length && (
              <tr>
                <td colSpan={props.columns.length + 1} className="muted">
                  {props.empty ?? 'Nothing configured yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && props.createFields && (
        <Dialog title={`Add ${props.title.replace(/s$/, '').toLowerCase()}`} onClose={() => setCreating(false)}>
          <SimpleForm
            fields={props.createFields}
            submitLabel="Create"
            onCancel={() => setCreating(false)}
            onSubmit={async (v) => {
              await post(props.createPath ?? props.listPath, v);
              setCreating(false);
              await refresh();
            }}
          />
        </Dialog>
      )}
      {editing && props.editFields && (
        <Dialog title="Edit" onClose={() => setEditing(null)}>
          <SimpleForm
            fields={props.editFields}
            initial={editing as unknown as Record<string, unknown>}
            submitLabel="Save"
            onCancel={() => setEditing(null)}
            onSubmit={async (v) => {
              await patch(itemPath(editing), v);
              setEditing(null);
              await refresh();
            }}
          />
        </Dialog>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete"
          body={<p>Delete this item? This is recorded in the audit log and cannot be undone.</p>}
          confirmLabel="Delete"
          danger
          onConfirm={async () => {
            await del(itemPath(deleting));
            await refresh();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
      {result && (
        <Dialog title={result.title} onClose={() => setResult(null)}>
          {result.error ? <div className="error">{String((result.value as { error: string }).error)}</div> : <JsonView value={result.value} />}
        </Dialog>
      )}
    </Panel>
  );
}
