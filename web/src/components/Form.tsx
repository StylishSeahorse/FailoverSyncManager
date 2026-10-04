import { useState } from 'react';
import { ErrorBox, useAction } from './ui';

export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'password' | 'select' | 'checkbox' | 'textarea' | 'json' | 'list';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

type Values = Record<string, unknown>;

function initialFor(f: Field, v: unknown): string | boolean {
  if (f.type === 'checkbox') return Boolean(v);
  if (v === undefined || v === null) return f.type === 'select' && f.required && f.options?.length ? f.options[0]!.value : '';
  if (f.type === 'json') return JSON.stringify(v, null, 2);
  if (f.type === 'list' && Array.isArray(v)) return v.join(', ');
  return String(v);
}

/**
 * Small declarative form. Empty optional fields are left out of the
 * submitted body so PATCH requests only change what was filled in, which
 * also keeps write-only secrets unchanged unless a new value is typed.
 */
export function SimpleForm({ fields, initial = {}, submitLabel, onSubmit, onCancel }: { fields: Field[]; initial?: Values; submitLabel: string; onSubmit: (v: Values) => Promise<unknown>; onCancel?: () => void }) {
  const [state, setState] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.map((f) => [f.name, initialFor(f, initial[f.name])])));
  const act = useAction(async () => {
    const out: Values = {};
    for (const f of fields) {
      const raw = state[f.name];
      if (f.type === 'checkbox') {
        out[f.name] = Boolean(raw);
        continue;
      }
      const s = String(raw ?? '').trim();
      if (!s) {
        if (f.required) throw new Error(`${f.label} is required`);
        continue;
      }
      if (f.type === 'number') {
        const n = Number(s);
        if (!Number.isFinite(n)) throw new Error(`${f.label} must be a number`);
        out[f.name] = n;
      } else if (f.type === 'json') {
        try {
          out[f.name] = JSON.parse(s);
        } catch {
          throw new Error(`${f.label} is not valid JSON`);
        }
      } else if (f.type === 'list') {
        out[f.name] = s.split(',').map((x) => x.trim()).filter(Boolean);
      } else out[f.name] = s;
    }
    await onSubmit(out);
    return true;
  });
  const set = (name: string, v: string | boolean) => setState((p) => ({ ...p, [name]: v }));

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void act.run();
      }}
    >
      <div className="form-grid">
        {fields.map((f) => {
          const id = `f-${f.name}`;
          if (f.type === 'checkbox')
            return (
              <label className="check" key={f.name} htmlFor={id}>
                <input id={id} type="checkbox" checked={Boolean(state[f.name])} onChange={(e) => set(f.name, e.target.checked)} />
                {f.label}
              </label>
            );
          const common = { id, value: String(state[f.name] ?? ''), placeholder: f.placeholder };
          return (
            <label key={f.name} htmlFor={id} style={f.type === 'json' || f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
              {f.label}
              {f.required ? ' *' : ''}
              {f.type === 'select' ? (
                <select {...common} onChange={(e) => set(f.name, e.target.value)}>
                  {!f.required && <option value="">—</option>}
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === 'json' || f.type === 'textarea' ? (
                <textarea {...common} onChange={(e) => set(f.name, e.target.value)} />
              ) : (
                <input {...common} type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'} autoComplete={f.type === 'password' ? 'new-password' : 'off'} onChange={(e) => set(f.name, e.target.value)} />
              )}
              {f.help && <span className="small">{f.help}</span>}
            </label>
          );
        })}
      </div>
      <ErrorBox error={act.error} />
      <div className="row">
        <button className="primary" type="submit" disabled={act.busy}>
          {act.busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
