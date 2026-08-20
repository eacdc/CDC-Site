/**
 * Shared primitives.
 *
 * Dense, keyboard-friendly, and disciplined about colour: red means BLOCK,
 * amber means WARN, and nothing else is allowed to use either. Colour-coding
 * by supplier or category would drown the one signal that has to be seen.
 */

import { useEffect, useRef, useState } from 'react';

export function Spinner({ label = 'Loading' }) {
  return (
    <div className="flex items-center gap-2 py-6 text-slate-500" role="status">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
      <span className="text-xs">{label}…</span>
    </div>
  );
}

/**
 * An empty state that says what would fill it.
 *
 * "No results" tells a user nothing; "No supplier has quoted this item at
 * Kolkata" tells them what to do next.
 */
export function Empty({ title, hint }) {
  return (
    <div className="border border-dashed border-slate-200 bg-slate-50/50 px-4 py-8 text-center">
      <p className="text-sm text-slate-600">{title}</p>
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  const checks = error.checks || [];
  return (
    <div className="border border-block-border bg-block-bg px-3 py-2">
      <p className="text-sm font-medium text-block">{error.message || String(error)}</p>
      {checks.length ? (
        <ul className="mt-2 space-y-1">
          {checks.map((c, i) => (
            <li key={`${c.code}-${i}`} className="text-xs text-block">
              <span className="font-mono">{c.code}</span> — {c.message}
            </li>
          ))}
        </ul>
      ) : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-2 text-xs underline text-block">
          Try again
        </button>
      ) : null}
    </div>
  );
}

const BUTTON_VARIANTS = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-300',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-300',
  danger: 'bg-block text-white hover:bg-block/90 disabled:bg-slate-300',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
};

export function Button({ variant = 'secondary', className = '', children, ...props }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * A validation check, rendered so severity is unmissable.
 *
 * A BLOCK carries a note that it cannot be overridden, because the most common
 * question about a blocked screen is "can I just push it through".
 */
export function CheckRow({ check, onOverride }) {
  if (check.passed) {
    return (
      <li className="flex items-baseline gap-2 py-0.5 text-2xs text-slate-400">
        <span className="font-mono">{check.code}</span>
        <span>{check.message}</span>
        <span className="ml-auto text-ok">passed</span>
      </li>
    );
  }

  const isBlock = check.severity === 'BLOCK';
  const tone = isBlock
    ? 'border-block-border bg-block-bg text-block'
    : check.severity === 'WARN'
      ? 'border-warn-border bg-warn-bg text-warn'
      : 'border-slate-200 bg-slate-50 text-slate-600';

  return (
    <li className={`border px-2 py-1.5 ${tone}`}>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-2xs">{check.code}</span>
        <span className="text-2xs font-semibold uppercase tracking-wide">{check.severity}</span>
      </div>
      <p className="mt-0.5 text-xs">{check.message}</p>
      {check.actualValue !== null && check.actualValue !== undefined ? (
        <p className="mt-0.5 font-mono text-2xs opacity-80">
          found {JSON.stringify(check.actualValue)}
          {check.expectedValue !== null && check.expectedValue !== undefined
            ? ` · expected ${JSON.stringify(check.expectedValue)}`
            : ''}
        </p>
      ) : null}
      {check.overrideReason ? (
        <p className="mt-1 text-2xs italic">Accepted: {check.overrideReason}</p>
      ) : null}
      {isBlock ? (
        <p className="mt-1 text-2xs font-medium">This cannot be overridden.</p>
      ) : onOverride && !check.overrideReason ? (
        <OverrideField code={check.code} onOverride={onOverride} />
      ) : null}
    </li>
  );
}

/** A warning is accepted by writing why, not by clicking past it. */
function OverrideField({ code, onOverride }) {
  const [reason, setReason] = useState('');
  return (
    <div className="mt-1.5 flex gap-1">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this acceptable?"
        className="flex-1 border border-warn-border bg-white px-1.5 py-0.5 text-2xs focus:outline-none focus:ring-1 focus:ring-warn"
      />
      <Button
        variant="secondary"
        disabled={reason.trim().length < 5}
        onClick={() => onOverride(code, reason.trim())}
      >
        Accept
      </Button>
    </div>
  );
}

/** A one-word verdict chip. */
export function Verdict({ level, children }) {
  const tone = {
    BLOCK: 'border-block-border bg-block-bg text-block',
    WARN: 'border-warn-border bg-warn-bg text-warn',
    OK: 'border-ok-border bg-ok-bg text-ok',
  }[level] || 'border-slate-200 bg-slate-50 text-slate-600';

  return (
    <span className={`inline-flex items-center border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide ${tone}`}>
      {children || level}
    </span>
  );
}

/** A neutral label. Deliberately colourless — see the colour discipline note. */
export function Tag({ children, title }) {
  return (
    <span
      title={title}
      className="inline-flex items-center border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-2xs text-slate-600"
    >
      {children}
    </span>
  );
}

/**
 * A dense table with sticky headers and a row-density toggle.
 *
 * `columns` is `[{key, label, align, width, render, sortable}]`; sorting is
 * client-side because every dataset here is already bounded by a report query.
 */
export function DataTable({
  columns, rows, keyField = 'id', dense = true, empty, onRowClick, selectedKey,
}) {
  const [sort, setSort] = useState(null);

  const sorted = sort
    ? [...rows].sort((a, b) => {
        const av = a[sort.key];
        const bv = b[sort.key];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp = typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
        return sort.direction === 'asc' ? cmp : -cmp;
      })
    : rows;

  if (!rows.length) return empty || <Empty title="Nothing to show." />;

  const cell = dense ? 'px-2 py-1' : 'px-3 py-2';

  return (
    <div className="overflow-x-auto border border-slate-200">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-slate-100">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                className={`${cell} border-b border-slate-200 text-left font-semibold text-slate-600 ${
                  col.align === 'right' ? 'text-right' : ''
                } ${col.sortable !== false ? 'cursor-pointer select-none hover:text-slate-900' : ''}`}
                onClick={() => {
                  if (col.sortable === false) return;
                  setSort((prev) => (
                    prev?.key === col.key
                      ? { key: col.key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
                      : { key: col.key, direction: 'asc' }
                  ));
                }}
              >
                {col.label}
                {sort?.key === col.key ? (
                  <span className="ml-1 text-2xs">{sort.direction === 'asc' ? '▲' : '▼'}</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => {
            const key = row[keyField] ?? i;
            return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-b border-slate-100 ${
                  onRowClick ? 'cursor-pointer' : ''
                } ${String(selectedKey) === String(key) ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`${cell} align-top ${col.align === 'right' ? 'text-right tabular-nums' : ''} ${col.mono ? 'font-mono' : ''}`}
                  >
                    {col.render ? col.render(row) : row[col.key] ?? '—'}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A labelled figure for the summary strip above a report. */
export function Stat({ label, value, sub, tone }) {
  const toneClass = {
    block: 'text-block',
    warn: 'text-warn',
    ok: 'text-ok',
  }[tone] || 'text-slate-900';

  return (
    <div className="border border-slate-200 bg-white px-3 py-2">
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {sub ? <p className="text-2xs text-slate-400">{sub}</p> : null}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-2xs uppercase tracking-wide text-slate-500">{label}</span>
      <div className="mt-0.5">{children}</div>
      {hint ? <span className="mt-0.5 block text-2xs text-slate-400">{hint}</span> : null}
    </label>
  );
}

const CONTROL = 'w-full border border-slate-300 bg-white px-2 py-1 text-xs focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-300';

export function Input({ className = '', ...props }) {
  return <input className={`${CONTROL} ${className}`} {...props} />;
}

export function Select({ className = '', children, ...props }) {
  return <select className={`${CONTROL} ${className}`} {...props}>{children}</select>;
}

/** Autofocus and select-on-mount, for a search box that opens ready to type. */
export function SearchInput({ value, onChange, placeholder, autoFocus }) {
  const ref = useRef(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-300"
    />
  );
}

export function SectionHeading({ children, actions }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold text-slate-800">{children}</h2>
      {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

/**
 * A banner naming the plant being shown.
 *
 * Always visible on any screen showing rates. A rate without its plant is
 * ambiguous, and the ambiguity is expensive — NR Agarwal's two plants are
 * about ₹4,000/MT apart for the same grade.
 */
export function PlantBanner({ plant, site }) {
  return (
    <div className="flex items-center gap-2 border border-slate-200 bg-slate-50 px-2.5 py-1 text-2xs text-slate-600">
      <span className="font-semibold uppercase tracking-wide">Showing</span>
      <span className="font-semibold text-slate-900">{plant}</span>
      <span className="text-slate-400">({site})</span>
      <span className="ml-auto text-slate-400">
        Rates are never carried across plants — a blank here means not quoted here.
      </span>
    </div>
  );
}
