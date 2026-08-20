/**
 * Reports.
 *
 * Every one is sorted by money and every one exports to CSV, because the
 * purchase team lives in Excel and a report they cannot export is a report
 * they will not use.
 *
 * Leakage leads because it is the report that justifies the project: for every
 * PO raised, what it cost against the best quote available on that date.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { downloadCsv, reports } from '../lib/api.js';
import { date, money, moneyShort, number, percent, plantLabel, relativeDays, truncate } from '../lib/format.js';
import {
  Button, DataTable, Empty, ErrorBox, PlantBanner, Select, Spinner, Stat, Tag,
} from '../components/ui.jsx';

const REPORTS = [
  { key: 'leakage', label: 'Leakage', blurb: 'Money left on the table, PO by PO.' },
  { key: 'refresh-needed', label: 'Quotes needing refresh', blurb: 'Expiring or expired, by spend.' },
  { key: 'plant-gaps', label: 'Plant coverage gaps', blurb: 'Bought here, not quoted here.' },
  { key: 'spread', label: 'Cross-supplier spread', blurb: 'Same item, materially different rates.' },
  { key: 'single-source', label: 'Single-source risk', blurb: 'One supplier, weighted by spend.' },
  { key: 'data-quality', label: 'Data quality', blurb: 'Rate histories spanning more than 3x.' },
  { key: 'master-duplicates', label: 'Master duplicates', blurb: 'Two CDC items for one product.' },
];

export default function Reports({ site, plant }) {
  const [active, setActive] = useState('leakage');
  const [selectedPlant, setSelectedPlant] = useState(plant);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { plant: selectedPlant };
      const fetcher = {
        'leakage': () => reports.leakage(params),
        'refresh-needed': () => reports.refreshNeeded(params),
        'plant-gaps': () => reports.plantGaps(params),
        'spread': () => reports.spread(),
        'single-source': () => reports.singleSource(params),
        'data-quality': () => reports.dataQuality(),
        'master-duplicates': () => reports.masterDuplicates(),
      }[active];
      setData(await fetcher());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [active, selectedPlant]);

  useEffect(() => { load(); }, [load, site]);

  // Only the plant-scoped reports take a plant. Spread, data quality and
  // master duplicates read purchase history, which is already per database.
  const usesPlant = ['leakage', 'refresh-needed', 'plant-gaps', 'single-source'].includes(active);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {REPORTS.map((report) => (
          <button
            key={report.key}
            type="button"
            onClick={() => setActive(report.key)}
            title={report.blurb}
            className={`border px-2 py-1 text-xs ${
              active === report.key
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {report.label}
          </button>
        ))}

        {usesPlant ? (
          <Select
            value={selectedPlant}
            onChange={(e) => setSelectedPlant(e.target.value)}
            className="ml-auto w-40"
          >
            <option value="KOLKATA">Kolkata</option>
            <option value="AHMEDABAD">Ahmedabad</option>
          </Select>
        ) : null}

        <Button
          className={usesPlant ? '' : 'ml-auto'}
          onClick={() => downloadCsv(active, usesPlant ? { plant: selectedPlant } : {}, `${active}.csv`)}
        >
          Export CSV
        </Button>
      </div>

      {usesPlant ? <PlantBanner plant={plantLabel(selectedPlant)} site={site} /> : null}

      <ErrorBox error={error} onRetry={load} />

      {loading ? <Spinner label="Running the report" /> : (
        <ReportBody name={active} data={data} plant={selectedPlant} />
      )}
    </div>
  );
}

function ReportBody({ name, data, plant }) {
  if (!data) return <Empty title="No data." />;

  if (name === 'leakage') return <Leakage data={data} />;
  if (name === 'refresh-needed') return <RefreshNeeded rows={data} />;
  if (name === 'plant-gaps') return <PlantGaps rows={data} plant={plant} />;
  if (name === 'spread') return <Spread rows={data} />;
  if (name === 'single-source') return <SingleSource rows={data} />;
  if (name === 'data-quality') return <DataQuality rows={data} />;
  if (name === 'master-duplicates') return <MasterDuplicates rows={data} />;
  return null;
}

/** The report that justifies the project. */
function Leakage({ data }) {
  const columns = [
    { key: 'poDate', label: 'PO date', width: '110px', render: (r) => date(r.poDate) },
    { key: 'poVoucherNo', label: 'PO', width: '150px', mono: true },
    {
      key: 'itemName',
      label: 'Item',
      render: (r) => (
        <Link to={`/items/${r.itemId}`} className="underline hover:text-slate-900">
          {truncate(r.itemName, 50)}
        </Link>
      ),
    },
    { key: 'supplierName', label: 'Bought from', width: '150px' },
    { key: 'poRate', label: 'Paid', align: 'right', width: '100px', render: (r) => money(r.poRate) },
    { key: 'bestRate', label: 'Best', align: 'right', width: '100px', render: (r) => money(r.bestRate) },
    { key: 'bestSupplier', label: 'From', width: '140px' },
    { key: 'quantity', label: 'Qty', align: 'right', width: '90px', render: (r) => number(r.quantity) },
    {
      key: 'leakage',
      label: 'Leakage',
      align: 'right',
      width: '110px',
      render: (r) => <span className="font-semibold text-warn">{money(r.leakage)}</span>,
    },
  ];

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat
          label="Total leakage"
          value={moneyShort(data.totalLeakage)}
          sub={`${date(data.window?.from)} — ${date(data.window?.to)}`}
          tone="warn"
        />
        <Stat label="POs examined" value={number(data.poCount)} />
        <Stat label="Lines with leakage" value={number(data.lines?.length)} />
        <Stat label="Plant" value={plantLabel(data.plant)} />
      </div>

      <p className="text-2xs text-slate-500">
        Counts only firm quotes that were current on the PO date. Soft quotes are
        excluded — &quot;prices may fluctuate&quot; was never an offer on the table.
      </p>

      <DataTable
        columns={columns}
        rows={data.lines || []}
        keyField="poVoucherNo"
        empty={<Empty title="No leakage found in this window." hint="Either the buying was tight, or there were no comparable quotes current at the time." />}
      />
    </div>
  );
}

function RefreshNeeded({ rows }) {
  const columns = [
    { key: 'supplierName', label: 'Supplier', width: '160px' },
    { key: 'itemName', label: 'Item', render: (r) => truncate(r.itemName || r.supplierProductName, 55) },
    { key: 'rate', label: 'Rate', align: 'right', width: '100px', render: (r) => money(r.rate) },
    { key: 'effectiveTo', label: 'Expires', width: '110px', render: (r) => date(r.effectiveTo) },
    {
      key: 'daysLeft',
      label: 'When',
      width: '110px',
      render: (r) => (
        <span className={r.isExpired ? 'font-semibold text-block' : 'text-warn'}>
          {relativeDays(r.daysLeft)}
        </span>
      ),
    },
    {
      key: 'annualSpend',
      label: 'Annual spend',
      align: 'right',
      width: '120px',
      render: (r) => money(r.annualSpend, { whole: true }),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      keyField="supplierProductName"
      empty={<Empty title="No quotes expiring in the next 30 days." />}
    />
  );
}

/**
 * The report that keeps Ahmedabad from running on Kolkata's assumptions.
 *
 * Two different gaps, deliberately together because they compete for the same
 * buyer's attention.
 */
function PlantGaps({ rows, plant }) {
  const columns = [
    {
      key: 'kind',
      label: 'Gap',
      width: '190px',
      render: (r) => (
        <Tag title={r.message}>
          {r.kind === 'NO_QUOTE_ANYWHERE' ? 'No quote at all' : 'Other plant only'}
        </Tag>
      ),
    },
    {
      key: 'itemName',
      label: 'Item',
      render: (r) => (
        <Link to={`/items/${r.itemId}?plant=${plant}`} className="underline hover:text-slate-900">
          {truncate(r.itemName, 55)}
        </Link>
      ),
    },
    {
      key: 'suppliers',
      label: 'Quoted by, elsewhere',
      render: (r) => (r.suppliers?.length ? r.suppliers.join(', ') : <span className="text-slate-400">—</span>),
    },
    {
      key: 'annualSpend',
      label: 'Annual spend',
      align: 'right',
      width: '120px',
      render: (r) => money(r.annualSpend, { whole: true }),
    },
  ];

  return (
    <div className="space-y-2">
      <p className="text-2xs text-slate-500">
        &quot;Other plant only&quot; means a supplier quotes this item, but not here. That is a
        request for a rate — a different thing from an expired quote.
      </p>
      <DataTable
        columns={columns}
        rows={rows}
        keyField="itemId"
        empty={<Empty title={`Every purchased item has a current quote at ${plantLabel(plant)}.`} />}
      />
    </div>
  );
}

function Spread({ rows }) {
  const columns = [
    {
      key: 'itemName',
      label: 'Item',
      render: (r) => (
        <Link to={`/items/${r.itemId}`} className="underline hover:text-slate-900">
          {truncate(r.itemName, 50)}
        </Link>
      ),
    },
    { key: 'cheapest', label: 'Cheapest', width: '190px', render: (r) => `${r.cheapest.supplier} — ${money(r.cheapest.rate)}` },
    { key: 'dearest', label: 'Dearest', width: '190px', render: (r) => `${r.dearest.supplier} — ${money(r.dearest.rate)}` },
    { key: 'spreadPct', label: 'Spread', align: 'right', width: '80px', render: (r) => percent(r.spreadPct) },
    { key: 'volume', label: 'Buys', align: 'right', width: '70px' },
    {
      key: 'potentialSaving',
      label: 'At stake',
      align: 'right',
      width: '120px',
      render: (r) => <span className="font-semibold text-warn">{money(r.potentialSaving, { whole: true })}</span>,
    },
  ];

  return <DataTable columns={columns} rows={rows} keyField="itemId" empty={<Empty title="No material spread found." />} />;
}

function SingleSource({ rows }) {
  const columns = [
    {
      key: 'itemName',
      label: 'Item',
      render: (r) => (
        <Link to={`/items/${r.itemId}`} className="underline hover:text-slate-900">
          {truncate(r.itemName, 55)}
        </Link>
      ),
    },
    {
      key: 'severity',
      label: 'Risk',
      width: '140px',
      render: (r) => (
        <Tag title={r.severity === 'NO_QUOTE' ? 'Bought, but nobody has a current quote' : 'Exactly one quoting supplier'}>
          {r.severity === 'NO_QUOTE' ? 'no quote' : 'single source'}
        </Tag>
      ),
    },
    { key: 'annualSpend', label: 'Annual spend', align: 'right', width: '130px', render: (r) => money(r.annualSpend, { whole: true }) },
  ];

  return <DataTable columns={columns} rows={rows} keyField="itemId" empty={<Empty title="Every purchased item has more than one quoting supplier." />} />;
}

/** Finds entry errors for free — a blanket price typed onto a plate line. */
function DataQuality({ rows }) {
  const columns = [
    { key: 'itemName', label: 'Item', render: (r) => truncate(r.itemName, 50) },
    { key: 'minRate', label: 'Min', align: 'right', width: '100px', render: (r) => money(r.minRate) },
    { key: 'maxRate', label: 'Max', align: 'right', width: '110px', render: (r) => money(r.maxRate) },
    { key: 'factor', label: 'Spread', align: 'right', width: '80px', render: (r) => `${number(r.factor, 1)}×` },
    { key: 'observations', label: 'Obs', align: 'right', width: '60px' },
    { key: 'suspectVoucherNo', label: 'Highest on', width: '150px', mono: true },
    { key: 'suspectSupplier', label: 'From', width: '160px' },
    { key: 'suspectDate', label: 'Date', width: '110px', render: (r) => date(r.suspectDate) },
  ];

  return (
    <div className="space-y-2">
      <p className="text-2xs text-slate-500">
        A rate history spanning more than 3× is usually an entry error rather than a
        price movement. The voucher carrying the highest rate is named so it can be checked.
      </p>
      <DataTable columns={columns} rows={rows} keyField="itemId" empty={<Empty title="No item shows a suspicious rate spread." />} />
    </div>
  );
}

function MasterDuplicates({ rows }) {
  if (!rows.length) return <Empty title="No duplicate master rows found." />;

  return (
    <div className="space-y-2">
      <p className="text-2xs text-slate-500">
        One supplier product mapping to several CDC items. Confirmed duplicates are
        harmless; unconfirmed ones split an item&apos;s rate history in two.
      </p>
      {rows.map((row, i) => (
        <div key={i} className="border border-slate-200 bg-white p-2">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium">{row.supplierProductName}</span>
            <Tag>{row.isConfirmed ? 'confirmed equivalent' : 'unconfirmed'}</Tag>
          </div>
          <ul className="mt-1 space-y-0.5">
            {row.candidates.map((c) => (
              <li key={c.itemId} className="flex items-baseline gap-2 text-2xs">
                <Link to={`/items/${c.itemId}`} className="underline">{c.itemName}</Link>
                <span className="font-mono text-slate-400">{c.itemCode}</span>
                <span className="ml-auto tabular-nums">{money(c.annualSpend, { whole: true })}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
