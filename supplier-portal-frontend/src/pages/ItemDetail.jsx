/**
 * Item detail — the centrepiece.
 *
 * Everything a buyer needs on one screen: last paid, every supplier's current
 * rate at this plant, the delta against last paid, a 12-month rate chart, and
 * the mapping panel.
 *
 * The three plant states are rendered as three visibly different things.
 * Collapsing "quoted at the other plant only" into a blank would hide the one
 * state that is actionable — it means *ask this supplier for a rate here*,
 * which is a different request from *your quote has expired*.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { items } from '../lib/api.js';
import { date, money, number, percent, plantLabel } from '../lib/format.js';
import {
  Button, DataTable, Empty, ErrorBox, PlantBanner, SectionHeading, Spinner, Stat, Tag, Verdict,
} from '../components/ui.jsx';

export default function ItemDetail({ site, plant }) {
  const { itemId } = useParams();
  const [params] = useSearchParams();
  const activePlant = params.get('plant') || plant;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await items.detail(itemId, { plant: activePlant }));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [itemId, activePlant]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner label="Loading item" />;
  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!data) return <Empty title="Item not found." />;

  const { item, lastPaid, best, deltaVsLastPaid, quotes, ranking, sparkline } = data;

  async function setClassification(mode) {
    await items.classify(itemId, { rankingMode: mode });
    load();
  }

  return (
    <div className="space-y-3">
      <div>
        <Link to="/items" className="text-2xs text-slate-500 underline">← Back to search</Link>
        <h1 className="mt-1 text-base font-semibold text-slate-900">{item.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Tag>{item.itemCode || `ItemID ${item.itemId}`}</Tag>
          <Tag>{item.groupName || `Group ${item.groupId}`}</Tag>
          {item.subGroupName ? <Tag>{item.subGroupName}</Tag> : null}
          <Tag title="Stock unit / purchase unit">{item.stockUnit} / {item.purchaseUnit}</Tag>
          <RankingTag mode={data.rankingMode} onChange={setClassification} />
        </div>
      </div>

      <PlantBanner plant={plantLabel(activePlant)} site={site} />

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat
          label="Last paid"
          value={money(lastPaid?.rate)}
          sub={lastPaid ? `${date(lastPaid.date)} · ${lastPaid.supplierName || '—'}` : 'No purchase history'}
        />
        <Stat
          label="Best available"
          value={money(best?.rate)}
          sub={best ? best.supplierName : `Not quoted at ${plantLabel(activePlant)}`}
          tone={best ? 'ok' : undefined}
        />
        <Stat
          label="Δ vs last paid"
          value={deltaVsLastPaid ? money(deltaVsLastPaid.rupees) : '—'}
          sub={deltaVsLastPaid ? percent(deltaVsLastPaid.percent, { signed: true }) : null}
          // Positive means the best quote is cheaper than the last purchase.
          tone={deltaVsLastPaid?.rupees > 0 ? 'ok' : deltaVsLastPaid?.rupees < 0 ? 'warn' : undefined}
        />
        <Stat
          label="Annual spend"
          value={money(data.annualSpend, { whole: true })}
          sub={data.purchaseCount ? `${data.purchaseCount} purchases` : null}
        />
      </div>

      <section>
        <SectionHeading>Current quotes</SectionHeading>
        <QuotePanel ranking={ranking} quotes={quotes} plant={activePlant} />
      </section>

      {sparkline?.length ? (
        <section>
          <SectionHeading>Rate history — 12 months</SectionHeading>
          <Sparkline points={sparkline} lastPaid={lastPaid?.rate} best={best?.rate} />
        </section>
      ) : null}

      <section>
        <SectionHeading>Purchase history</SectionHeading>
        <PurchaseHistory rows={data.purchaseHistory} />
      </section>
    </div>
  );
}

/**
 * Quotes, grouped by the brand-vs-spec rule.
 *
 * Spec-defined items rank suppliers outright. Brand-defined items rank within
 * brand and show cross-brand separately — Siegwerk cyan at Rs 810 and SKT Enviro
 * NEO cyan at Rs 308 are not the same purchase, and one ranking would say they
 * are.
 */
function QuotePanel({ ranking, quotes, plant }) {
  if (!quotes?.length) {
    return (
      <Empty
        title={`No supplier has quoted this item at ${plantLabel(plant)}.`}
        hint="This item appears in the Plant coverage gaps report."
      />
    );
  }

  if (ranking?.mode === 'SPEC') {
    return <QuoteTable rows={ranking.ranked || quotes} />;
  }

  return (
    <div className="space-y-2">
      {(ranking?.byBrand || []).map((group) => (
        <div key={group.brand}>
          <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-slate-500">
            {group.brand}
          </p>
          <QuoteTable rows={group.quotes} />
        </div>
      ))}
      {ranking?.crossBrandNote ? (
        <p className="text-2xs italic text-slate-500">{ranking.crossBrandNote}</p>
      ) : null}
    </div>
  );
}

function QuoteTable({ rows }) {
  const columns = [
    { key: 'supplierName', label: 'Supplier', width: '180px' },
    {
      key: 'supplierProductName',
      label: 'Their product',
      render: (r) => r.supplierProductName || <span className="text-slate-400">—</span>,
    },
    {
      key: 'rate',
      label: 'Rate',
      align: 'right',
      width: '120px',
      render: (r) => {
        // The three states, kept visibly distinct.
        if (r.state === 'NOT_AT_PLANT') {
          return <span className="text-warn" title="This supplier quotes the item, but only for the other plant">{r.displayNote}</span>;
        }
        if (!Number.isFinite(r.rate)) return <span className="text-slate-400">—</span>;
        return (
          <span className={r.isExpired ? 'text-slate-400 line-through' : ''}>
            {money(r.rate)}
          </span>
        );
      },
    },
    { key: 'uom', label: 'Unit', width: '60px' },
    {
      key: 'effectiveTo',
      label: 'Valid to',
      width: '110px',
      render: (r) => (
        r.effectiveTo
          ? <span className={r.isExpired ? 'text-warn' : ''}>{date(r.effectiveTo)}</span>
          : <span className="text-slate-400">open</span>
      ),
    },
    {
      key: 'flags',
      label: '',
      sortable: false,
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.quoteStrength === 'SOFT' ? (
            <Tag title="Subject to change without notice — a benchmark, not a commitment">soft</Tag>
          ) : null}
          {r.isExpired ? <Tag title="Past its validity date">expired</Tag> : null}
          {r.isSpecLevel ? (
            <Tag title="The supplier quoted the spec, not this exact size">spec rate</Tag>
          ) : null}
          {r.isDerived ? (
            <Tag title={r.derivationNote || 'Derived from a rule stated on the document'}>derived</Tag>
          ) : null}
        </div>
      ),
    },
  ];

  return <DataTable columns={columns} rows={rows} keyField="supplierGroupId" />;
}

/**
 * A minimal inline SVG chart.
 *
 * Deliberately not a charting library: a band between the month's min and max
 * with the average through it is the whole question — "what have we been
 * paying, and how much does it move" — and anything more would be decoration
 * on a screen that has to load fast all day.
 */
function Sparkline({ points, lastPaid, best }) {
  if (points.length < 2) {
    return <Empty title="Not enough purchase history to plot." />;
  }

  const width = 640;
  const height = 120;
  const padding = { top: 8, right: 8, bottom: 18, left: 52 };

  const values = points.flatMap((p) => [p.min, p.max])
    .concat([lastPaid, best].filter(Number.isFinite));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const x = (i) => padding.left + (i / (points.length - 1)) * (width - padding.left - padding.right);
  const y = (v) => padding.top + (1 - (v - min) / span) * (height - padding.top - padding.bottom);

  const avgPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.avg)}`).join(' ');
  const bandPath = [
    ...points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.max)}`),
    ...points.slice().reverse().map((p, i) => `L${x(points.length - 1 - i)},${y(p.min)}`),
    'Z',
  ].join(' ');

  return (
    <div className="border border-slate-200 bg-white p-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Rate history">
        <path d={bandPath} fill="#e2e8f0" />
        <path d={avgPath} fill="none" stroke="#334155" strokeWidth="1.5" />

        {Number.isFinite(lastPaid) ? (
          <line
            x1={padding.left} x2={width - padding.right} y1={y(lastPaid)} y2={y(lastPaid)}
            stroke="#94a3b8" strokeWidth="1" strokeDasharray="3 3"
          />
        ) : null}
        {Number.isFinite(best) ? (
          <line
            x1={padding.left} x2={width - padding.right} y1={y(best)} y2={y(best)}
            stroke="#067647" strokeWidth="1" strokeDasharray="2 2"
          />
        ) : null}

        <text x={4} y={y(max) + 4} className="fill-slate-500" fontSize="9">{number(max, 0)}</text>
        <text x={4} y={y(min) + 4} className="fill-slate-500" fontSize="9">{number(min, 0)}</text>
        <text x={padding.left} y={height - 4} className="fill-slate-400" fontSize="9">{points[0].month}</text>
        <text x={width - padding.right} y={height - 4} textAnchor="end" className="fill-slate-400" fontSize="9">
          {points[points.length - 1].month}
        </text>
      </svg>
      <p className="mt-1 text-2xs text-slate-400">
        Band is the month&apos;s range, line is the average. Dashed grey is last paid;
        dashed green is the best current quote.
      </p>
    </div>
  );
}

function PurchaseHistory({ rows }) {
  if (!rows?.length) return <Empty title="No purchases in the last 24 months." />;

  const columns = [
    { key: 'VoucherDate', label: 'Date', width: '110px', render: (r) => date(r.VoucherDate) },
    { key: 'VoucherNo', label: 'PO', width: '150px', mono: true },
    { key: 'LedgerName', label: 'Supplier' },
    { key: 'PurchaseRate', label: 'Rate', align: 'right', width: '110px', render: (r) => money(r.PurchaseRate) },
    { key: 'PurchaseOrderQuantity', label: 'Qty', align: 'right', width: '100px', render: (r) => number(r.PurchaseOrderQuantity) },
    { key: 'PurchaseUnit', label: 'Unit', width: '60px' },
  ];

  return <DataTable columns={columns} rows={rows} keyField="VoucherNo" />;
}

/** The brand-vs-spec flag, with a one-click correction for the purchase team. */
function RankingTag({ mode, onChange }) {
  const explanation = mode === 'SPEC'
    ? 'Spec-defined: a buyer would accept any brand at this spec, so suppliers rank against each other.'
    : 'Brand-defined: the brand is part of the identity, so suppliers rank within brand.';

  return (
    <span className="inline-flex items-center gap-1">
      <Verdict level={mode === 'SPEC' ? 'OK' : 'NEUTRAL'}>{mode}</Verdict>
      <span className="text-2xs text-slate-400" title={explanation}>?</span>
      <Button variant="ghost" onClick={() => onChange(mode === 'SPEC' ? 'BRAND' : 'SPEC')}>
        change to {mode === 'SPEC' ? 'BRAND' : 'SPEC'}
      </Button>
    </span>
  );
}
