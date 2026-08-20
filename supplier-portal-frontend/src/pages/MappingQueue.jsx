/**
 * The mapping queue.
 *
 * A focused two-pane worker: the quote line and its source image on the left,
 * ranked candidates on the right. The initial pass is ~546 items and the speed
 * of this screen decides whether the project lands, so it is built for the
 * keyboard and aims for under five seconds a decision.
 *
 *   1–8    pick that candidate
 *   N      no CDC item — a real answer, not a failure
 *   D      defer
 *   Enter  confirm the highlighted candidate
 *   ↑ ↓    move the highlight
 *
 * The queue is worked in spend order, so the money is mapped first even if the
 * tail is never finished.
 */

import { useCallback, useEffect, useState } from 'react';
import { mappings } from '../lib/api.js';
import { money, number, truncate } from '../lib/format.js';
import {
  Button, Empty, ErrorBox, SectionHeading, Spinner, Stat, Tag,
} from '../components/ui.jsx';

const REASON_LABELS = {
  NO_CANDIDATE: 'No candidate found',
  AMBIGUOUS: 'Several equally good candidates',
  LOW_CONFIDENCE: 'Below the auto-accept threshold',
  UOM_UNRESOLVED: 'Unit could not be resolved',
  RATE_OUT_OF_BAND: 'Rate far from anything expected',
  NEW_ITEM_BETTER_MATCH: 'A newer ItemID may fit better',
};

export default function MappingQueue({ site }) {
  const [entries, setEntries] = useState([]);
  const [index, setIndex] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [queue, queueStats] = await Promise.all([
        mappings.queue({ status: 'OPEN', limit: 25 }),
        mappings.stats(),
      ]);
      setEntries(queue.entries || []);
      setStats(queueStats);
      setIndex(0);
      setHighlight(0);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, site]);

  const entry = entries[index];

  /**
   * Resolve and advance.
   *
   * The entry is dropped from the local list rather than reloading the queue:
   * a refetch between every decision would cost more than the decision itself,
   * and the queue is refilled when the batch runs out.
   */
  const resolve = useCallback(async (status, itemId) => {
    if (!entry || saving) return;
    setSaving(true);
    try {
      await mappings.resolve(entry._id, { status, itemId, note: note.trim() || undefined });
      setNote('');
      setHighlight(0);
      const remaining = entries.filter((e) => e._id !== entry._id);
      setEntries(remaining);
      if (index >= remaining.length) setIndex(Math.max(0, remaining.length - 1));
      if (!remaining.length) load();
      setStats((prev) => (prev ? { ...prev, openCount: Math.max(0, prev.openCount - 1) } : prev));
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }, [entry, entries, index, note, saving, load]);

  // Keyboard handling is deliberately global rather than per-input: the whole
  // point is that a coordinator's hands never leave the number row.
  useEffect(() => {
    function onKey(event) {
      if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
      if (!entry) return;

      const candidates = entry.candidates || [];

      if (event.key >= '1' && event.key <= '8') {
        const picked = candidates[Number(event.key) - 1];
        if (picked) { event.preventDefault(); resolve('RESOLVED', picked.itemId); }
        return;
      }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); resolve('NO_CDC_ITEM'); return; }
      if (event.key.toLowerCase() === 'd') { event.preventDefault(); resolve('DEFERRED'); return; }
      if (event.key === 'Enter') {
        const picked = candidates[highlight];
        if (picked) { event.preventDefault(); resolve('RESOLVED', picked.itemId); }
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight((h) => Math.min(h + 1, candidates.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entry, highlight, resolve]);

  if (loading) return <Spinner label="Loading the queue" />;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Open" value={number(stats?.openCount ?? 0)} sub="unmapped supplier items" />
        <Stat
          label="Spend at stake"
          value={money(stats?.openSpend, { whole: true })}
          sub="annual, across candidates"
        />
        <Stat label="In this batch" value={`${entries.length ? index + 1 : 0} / ${entries.length}`} />
        <Stat label="Site" value={site} sub="mappings are per database" />
      </div>

      <ErrorBox error={error} onRetry={load} />

      {!entry ? (
        <Empty
          title="Nothing waiting."
          hint="New entries appear when a quote is matched and a line cannot be resolved automatically."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <QuoteLinePane entry={entry} />
          <CandidatePane
            entry={entry}
            highlight={highlight}
            onHighlight={setHighlight}
            onPick={(itemId) => resolve('RESOLVED', itemId)}
            saving={saving}
          />
        </div>
      )}

      {entry ? (
        <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-white px-3 py-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for this decision…"
            className="w-64 border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-slate-300"
          />
          <Button variant="danger" onClick={() => resolve('NO_CDC_ITEM')} disabled={saving}>
            No CDC item (N)
          </Button>
          <Button onClick={() => resolve('DEFERRED')} disabled={saving}>Defer (D)</Button>
          <Button
            onClick={() => setIndex((i) => Math.min(i + 1, entries.length - 1))}
            disabled={index >= entries.length - 1}
          >
            Skip →
          </Button>
          <span className="ml-auto text-2xs text-slate-400">
            1–8 pick · Enter confirm · ↑↓ move · N no item · D defer
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** The left pane: what the supplier actually sent. */
function QuoteLinePane({ entry }) {
  const line = entry.line || {};
  const raw = line.raw || {};

  return (
    <section className="border border-slate-200 bg-white p-3">
      <SectionHeading>
        {entry.supplierGroup?.name || 'Unknown supplier'}
      </SectionHeading>

      <div className="mb-2 flex flex-wrap gap-1">
        <Tag title={REASON_LABELS[entry.reason]}>{entry.reason}</Tag>
        {entry.document?.docType ? <Tag>{entry.document.docType}</Tag> : null}
        <Tag title="Annual spend on the candidate items">
          {money(entry.priority, { whole: true })} at stake
        </Tag>
      </div>

      <dl className="space-y-1 text-xs">
        <Row label="Product">{raw.productName || '—'}</Row>
        <Row label="Code" mono>{raw.productCode || '—'}</Row>
        <Row label="Pack">{raw.packSize || '—'}</Row>
        <Row label="Quoted">
          {raw.rate || '—'} {raw.uom ? <span className="text-slate-500">/ {raw.uom}</span> : null}
        </Row>
        <Row label="Normalised">
          {line.normalised?.ratePerBaseUom
            ? `${money(line.normalised.ratePerBaseUom)} / ${line.normalised.uom}`
            : '—'}
        </Row>
        {line.normalised?.conversionNote ? (
          <Row label="Conversion">
            <span className="text-slate-500">{line.normalised.conversionNote}</span>
          </Row>
        ) : null}
      </dl>

      {raw.text ? (
        <div className="mt-2 border border-slate-200 bg-slate-50 p-2">
          <p className="text-2xs uppercase tracking-wide text-slate-500">As printed</p>
          <p className="mt-0.5 font-mono text-2xs text-slate-700">{raw.text}</p>
        </div>
      ) : null}

      {/*
        The source image, not a transcription. Someone deciding in five seconds
        needs to see the printed line — a re-typed one carries the extractor's
        errors invisibly.
      */}
      {entry.sourceUrl ? (
        <div className="mt-2">
          <p className="mb-1 text-2xs uppercase tracking-wide text-slate-500">Source document</p>
          <a href={entry.sourceUrl} target="_blank" rel="noreferrer">
            <img
              src={entry.sourceUrl}
              alt="Source document"
              className="max-h-64 w-full border border-slate-200 object-contain"
            />
          </a>
        </div>
      ) : null}
    </section>
  );
}

/** The right pane: ranked candidates with everything a decision needs. */
function CandidatePane({ entry, highlight, onHighlight, onPick, saving }) {
  const candidates = entry.candidates || [];

  if (!candidates.length) {
    return (
      <section className="border border-slate-200 bg-white p-3">
        <SectionHeading>Candidates</SectionHeading>
        <Empty
          title="No candidate items were found."
          hint="CDC may genuinely not stock this. Press N — that is a real answer and the rate is still kept as a benchmark."
        />
      </section>
    );
  }

  const normalised = entry.line?.normalised || {};

  return (
    <section className="border border-slate-200 bg-white p-3">
      <SectionHeading>Candidates</SectionHeading>
      <ul className="space-y-1">
        {candidates.map((candidate, i) => {
          const isHighlighted = i === highlight;
          /**
           * How close this candidate's last-paid rate is to the quote is the
           * single most informative number on the screen — but it has to be
           * measured against the right reading of the quote. A supplier
           * pricing GI wire at ₹149/kg and CDC buying the 15 kg spool at
           * ₹2,235 is the *same* price; showing "-93%" there would send a
           * coordinator past the correct answer.
           *
           * The server does this comparison and says which basis it used;
           * the fallback below only runs against older queue entries.
           */
          const comparison = candidateComparison(candidate, normalised);
          const delta = comparison?.deltaPct ?? null;
          const isAnchor = delta !== null && Math.abs(delta) <= 0.5;

          return (
            <li key={candidate.itemId}>
              <button
                type="button"
                disabled={saving}
                onMouseEnter={() => onHighlight(i)}
                onClick={() => onPick(candidate.itemId)}
                className={`w-full border px-2 py-1.5 text-left transition-colors ${
                  isHighlighted ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="w-4 shrink-0 text-center font-mono text-2xs text-slate-400">{i + 1}</span>
                  <span className="flex-1 text-xs font-medium text-slate-800">
                    {truncate(candidate.itemName, 60)}
                  </span>
                  <span className="text-xs tabular-nums text-slate-700">
                    {money(candidate.lastPaidRate)}
                  </span>
                </div>
                <div className="ml-6 mt-0.5 flex flex-wrap items-center gap-2 text-2xs text-slate-500">
                  {candidate.subGroupName ? <span>{candidate.subGroupName}</span> : null}
                  {candidate.lastSupplier ? <span>last: {candidate.lastSupplier}</span> : null}
                  {candidate.purchaseCount ? <span>{candidate.purchaseCount} buys</span> : null}
                  {delta !== null ? (
                    <span className={isAnchor ? 'font-semibold text-ok' : ''} title={comparison.explanation}>
                      {isAnchor
                        ? `rate matches exactly${comparison.basis === 'PER_PACK' ? ' (as a pack)' : ''}`
                        : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}% vs quote${comparison.basis === 'PER_PACK' ? ' (as a pack)' : ''}`}
                    </span>
                  ) : null}
                </div>
                {candidate.rationale ? (
                  <p className="ml-6 mt-0.5 text-2xs italic text-slate-400">{candidate.rationale}</p>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Compare a candidate's last-paid rate against the closest legitimate reading
 * of the quote.
 *
 * Two readings are possible whenever the line carries a pack size: the
 * per-unit rate as normalised, and that rate times the pack quantity. CDC's
 * master and the supplier routinely price the same purchase in different
 * units — ₹149/kg for a 15 kg spool that CDC buys as one "Nos" at ₹2,235 —
 * and comparing only the per-unit figure makes an exact match look like a 93%
 * discrepancy.
 *
 * The server sends `matchedBasis` and `deltaVsLastPaidPct` when it has done
 * this itself; this recomputes for entries queued before that existed.
 */
function candidateComparison(candidate, normalised) {
  const paid = Number(candidate.lastPaidRate);
  if (!Number.isFinite(paid) || paid <= 0) return null;

  if (candidate.matchedBasis && Number.isFinite(candidate.deltaVsLastPaidPct)) {
    return {
      deltaPct: candidate.deltaVsLastPaidPct,
      basis: candidate.matchedBasis,
      explanation: candidate.matchedBasis === 'PER_PACK'
        ? `Compared as a whole pack: the per-unit rate times the pack size, against a last-paid of ${paid}.`
        : `Compared per unit against a last-paid of ${paid}.`,
    };
  }

  const perUnit = Number(normalised.ratePerBaseUom ?? normalised.rate);
  if (!Number.isFinite(perUnit) || perUnit <= 0) return null;

  const readings = [{ rate: perUnit, basis: 'PER_UNIT' }];
  const packQty = Number(normalised.packQty);
  if (Number.isFinite(packQty) && packQty > 1) {
    readings.push({ rate: perUnit * packQty, basis: 'PER_PACK' });
  }

  let best = null;
  for (const reading of readings) {
    const deltaPct = ((reading.rate - paid) / paid) * 100;
    if (!best || Math.abs(deltaPct) < Math.abs(best.deltaPct)) {
      best = { deltaPct, basis: reading.basis };
    }
  }

  return {
    ...best,
    explanation: best.basis === 'PER_PACK'
      ? `Compared as a pack of ${packQty}: ${perUnit} x ${packQty} against a last-paid of ${paid}.`
      : `Compared per unit against a last-paid of ${paid}.`,
  };
}

function Row({ label, children, mono }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-2xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`flex-1 ${mono ? 'font-mono' : ''}`}>{children}</dd>
    </div>
  );
}
