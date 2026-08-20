/**
 * PO checking.
 *
 * Two views that answer different questions:
 *
 *   Sweep — POs raised recently that need attention. Clean POs produce no row;
 *           a queue that lists everything is a queue nobody reads.
 *   Open above quote — POs that were fine when raised and have since been
 *           overtaken by a newer quote. That is a renegotiation opportunity,
 *           not an error, and only the pending quantity is still recoverable.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { poCheck } from '../lib/api.js';
import { date, money, number, plantLabel, truncate } from '../lib/format.js';
import {
  Button, CheckRow, DataTable, Empty, ErrorBox, Input, PlantBanner, SectionHeading,
  Select, Spinner, Stat, Verdict,
} from '../components/ui.jsx';

export default function PoCheck({ site, plant }) {
  const [tab, setTab] = useState('sweep');
  const [selectedPlant, setSelectedPlant] = useState(plant);
  const [sweep, setSweep] = useState(null);
  const [overtaken, setOvertaken] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [lookup, setLookup] = useState('');
  const [single, setSingle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'sweep') setSweep(await poCheck.sweep({ plant: selectedPlant }));
      else setOvertaken(await poCheck.openAboveQuote({ plant: selectedPlant }));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [tab, selectedPlant]);

  useEffect(() => { load(); }, [load, site]);

  async function checkOne(event) {
    event.preventDefault();
    if (!lookup.trim()) return;
    setError(null);
    try {
      setSingle(await poCheck.one(lookup.trim(), { plant: selectedPlant }));
    } catch (err) {
      setError(err);
      setSingle(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={tab === 'sweep' ? 'primary' : 'secondary'}
          onClick={() => setTab('sweep')}
        >
          Needs attention
        </Button>
        <Button
          variant={tab === 'overtaken' ? 'primary' : 'secondary'}
          onClick={() => setTab('overtaken')}
        >
          Overtaken by a newer quote
        </Button>

        <form onSubmit={checkOne} className="ml-auto flex items-center gap-1">
          <Input
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="Check one PO by TransactionID"
            className="w-56"
          />
          <Button type="submit">Check</Button>
        </form>

        <Select
          value={selectedPlant}
          onChange={(e) => setSelectedPlant(e.target.value)}
          className="w-40"
        >
          <option value="KOLKATA">Kolkata</option>
          <option value="AHMEDABAD">Ahmedabad</option>
        </Select>
      </div>

      <PlantBanner plant={plantLabel(selectedPlant)} site={site} />
      <ErrorBox error={error} onRetry={load} />

      {single ? (
        <section>
          <SectionHeading actions={<Button variant="ghost" onClick={() => setSingle(null)}>close</Button>}>
            {single.poVoucherNo}
          </SectionHeading>
          <PoResult result={single} />
        </section>
      ) : null}

      {loading ? <Spinner label="Checking" /> : tab === 'sweep' ? (
        <SweepView sweep={sweep} expanded={expanded} onExpand={setExpanded} />
      ) : (
        <OvertakenView rows={overtaken} />
      )}
    </div>
  );
}

function SweepView({ sweep, expanded, onExpand }) {
  if (!sweep) return <Empty title="No sweep has been run." />;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="POs checked" value={number(sweep.checked)} sub={`${date(sweep.window?.from)} — ${date(sweep.window?.to)}`} />
        <Stat
          label="Needing attention"
          value={number(sweep.needingAttention)}
          tone={sweep.needingAttention ? 'warn' : 'ok'}
        />
        <Stat
          label="Blocking"
          value={number(sweep.results?.filter((r) => r.verdict.level === 'BLOCK').length)}
          tone="block"
        />
        <Stat label="Plant" value={plantLabel(sweep.plant)} />
      </div>

      {!sweep.results?.length ? (
        <Empty
          title="Every PO in this window is priced in line with current quotes."
          hint="Clean POs are deliberately not listed."
        />
      ) : (
        <div className="space-y-1">
          {sweep.results.map((result) => (
            <div key={result.poTransactionId} className="border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => onExpand(expanded === result.poTransactionId ? null : result.poTransactionId)}
                className="flex w-full items-baseline gap-2 px-2 py-1.5 text-left hover:bg-slate-50"
              >
                <Verdict level={result.verdict.level} />
                <span className="font-mono text-xs">{result.poVoucherNo}</span>
                <span className="text-xs text-slate-600">{result.supplierName}</span>
                <span className="text-2xs text-slate-500">{date(result.poDate)}</span>
                <span className="ml-auto text-2xs text-slate-600">{result.verdict.summary}</span>
              </button>
              {expanded === result.poTransactionId ? (
                <div className="border-t border-slate-100 p-2">
                  <PoResult result={result} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PoResult({ result }) {
  return (
    <div className="space-y-2">
      {result.lines.map((line) => (
        <div key={line.transactionDetailId} className="border border-slate-200 bg-white p-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <Verdict level={line.verdict.level} />
            <Link to={`/items/${line.itemId}`} className="text-xs underline hover:text-slate-900">
              {truncate(line.itemName, 50)}
            </Link>
            <span className="text-2xs text-slate-500">
              {number(line.quantity)} {line.uom}
            </span>
            <span className="ml-auto text-xs tabular-nums">
              PO {money(line.poRate)}
              {line.bestQuote ? (
                <span className="ml-2 text-slate-500">best {money(line.bestQuote.rate)} ({line.bestQuote.supplier})</span>
              ) : null}
              {line.lastPaid ? (
                <span className="ml-2 text-slate-400">last {money(line.lastPaid.rate)}</span>
              ) : null}
            </span>
          </div>

          {line.checks?.some((c) => !c.passed) ? (
            <ul className="mt-1.5 space-y-1">
              {line.checks.filter((c) => !c.passed).map((c, i) => (
                <CheckRow key={`${c.code}-${i}`} check={c} />
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function OvertakenView({ rows }) {
  const columns = [
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
    { key: 'supplierName', label: 'Supplier', width: '160px' },
    { key: 'poRate', label: 'PO rate', align: 'right', width: '100px', render: (r) => money(r.poRate) },
    { key: 'bestRate', label: 'Now', align: 'right', width: '100px', render: (r) => money(r.bestRate) },
    { key: 'bestSupplier', label: 'From', width: '150px' },
    { key: 'pendingQty', label: 'Pending', align: 'right', width: '90px', render: (r) => number(r.pendingQty) },
    {
      key: 'exposureOnPending',
      label: 'Recoverable',
      align: 'right',
      width: '120px',
      render: (r) => <span className="font-semibold text-warn">{money(r.exposureOnPending)}</span>,
    },
  ];

  return (
    <div className="space-y-2">
      <p className="text-2xs text-slate-500">
        These POs were priced fairly when raised. Only the pending quantity is still
        recoverable — what has already been received is spent.
      </p>
      <DataTable
        columns={columns}
        rows={rows}
        keyField="transactionDetailId"
        empty={<Empty title="No open PO has been overtaken by a newer quote." />}
      />
    </div>
  );
}
