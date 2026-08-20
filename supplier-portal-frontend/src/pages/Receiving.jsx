/**
 * Receiving — a separate, tablet-first layout.
 *
 * Large touch targets, camera first, one decision per screen, no dense tables.
 * A store person is standing at a gate holding a parcel; the screen has to work
 * one-handed and be readable at arm's length.
 *
 * The posting step is deliberately hard to rush. A blocking check cannot be
 * overridden by anyone, and a warning needs a typed reason — the point of the
 * override is the sentence, not the click.
 */

import { useCallback, useEffect, useState } from 'react';
import { receiving } from '../lib/api.js';
import { date, money, number, truncate } from '../lib/format.js';
import {
  Button, CheckRow, Empty, ErrorBox, Field, Input, SectionHeading, Spinner, Tag, Verdict,
} from '../components/ui.jsx';

const STEPS = ['CAPTURED', 'EXTRACTED', 'MATCHED', 'NEEDS_REVIEW', 'POSTED'];

export default function Receiving({ site, session }) {
  const [sets, setSets] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await receiving.list({ limit: 30 });
      setSets(data.documentSets || []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, site]);

  if (activeId) {
    return (
      <DocumentSet
        id={activeId}
        onClose={() => { setActiveId(null); load(); }}
        session={session}
      />
    );
  }

  return (
    <div className="space-y-3">
      <SectionHeading
        actions={<NewCapture onCreated={(id) => setActiveId(id)} />}
      >
        Receiving
      </SectionHeading>

      <ContextBanner session={session} />
      <ErrorBox error={error} onRetry={load} />

      {loading ? <Spinner label="Loading" /> : !sets.length ? (
        <Empty
          title="Nothing being received."
          hint="Start a capture when a delivery arrives at the gate."
        />
      ) : (
        <ul className="space-y-1.5">
          {sets.map((set) => (
            <li key={set._id}>
              <button
                type="button"
                onClick={() => setActiveId(set._id)}
                className="flex w-full items-center gap-3 border border-slate-200 bg-white px-3 py-3 text-left hover:bg-slate-50"
              >
                <Verdict level={set.status === 'POSTED' ? 'OK' : set.status === 'NEEDS_REVIEW' ? 'WARN' : 'NEUTRAL'}>
                  {set.status}
                </Verdict>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {set.extractedHeader?.invoiceNo || '(no invoice number yet)'}
                  </p>
                  <p className="text-2xs text-slate-500">
                    {date(set.createdAt)} · {set.extractedLines?.length || 0} lines
                    {set.posted?.grnVoucherNo ? ` · ${set.posted.grnVoucherNo}` : ''}
                  </p>
                </div>
                <span className="text-lg text-slate-300">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The session context, shown large.
 *
 * A GRN is written against whichever employee ledger and warehouse are
 * selected, and these are three separate ID spaces in the ERP. Someone who
 * cannot see which warehouse they are receiving into will eventually receive
 * into the wrong one.
 */
function ContextBanner({ session }) {
  const context = session?.context || {};
  const missing = !context.employeeLedgerId || !context.warehouseId;

  return (
    <div className={`border px-3 py-2 ${missing ? 'border-warn-border bg-warn-bg' : 'border-slate-200 bg-white'}`}>
      <p className="text-2xs uppercase tracking-wide text-slate-500">Receiving as</p>
      <div className="mt-1 flex flex-wrap gap-4 text-sm">
        <span>
          <span className="text-slate-500">User </span>
          <span className="font-mono">{context.erpUserId ?? '—'}</span>
        </span>
        <span title="LedgerMaster, LedgerType Employees — this is what ReceivedBy records">
          <span className="text-slate-500">Employee ledger </span>
          <span className="font-mono">{context.employeeLedgerId ?? '—'}</span>
        </span>
        <span>
          <span className="text-slate-500">Warehouse </span>
          <span className="font-mono">{context.warehouseId ?? '—'}</span>
        </span>
        <span>
          <span className="text-slate-500">Site </span>
          <span className="font-mono">{context.site ?? '—'}</span>
        </span>
      </div>
      {missing ? (
        <p className="mt-1 text-2xs text-warn">
          An employee ledger and warehouse are required before anything can be posted.
          Set them from the top bar or sign in again.
        </p>
      ) : null}
    </div>
  );
}

function NewCapture({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [supplierLedgerId, setSupplierLedgerId] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function start(event) {
    event.preventDefault();
    if (!files.length || !supplierLedgerId) return;
    setBusy(true);
    setError(null);
    try {
      const pages = [];
      for (const [i, file] of files.entries()) {
        const signed = await receiving.uploadUrl({
          contentType: file.type, contentLength: file.size,
        });
        const put = await fetch(signed.url, {
          method: 'PUT', headers: { 'Content-Type': file.type }, body: file,
        });
        if (!put.ok) throw new Error(`Upload failed for ${file.name}`);
        pages.push({ storageKey: signed.key, pageNo: i + 1 });
      }

      const set = await receiving.create({
        supplierLedgerId: Number(supplierLedgerId),
        slots: { supplierInvoice: pages },
      });
      await receiving.extract(set._id);
      onCreated(set._id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <Button variant="primary" onClick={() => setOpen(true)}>New capture</Button>;
  }

  return (
    <form onSubmit={start} className="w-full border border-slate-200 bg-white p-3">
      <div className="space-y-3">
        <Field label="Supplier ledger ID" hint="From the ERP, for this site.">
          <Input
            value={supplierLedgerId}
            onChange={(e) => setSupplierLedgerId(e.target.value)}
            inputMode="numeric"
            required
          />
        </Field>

        <Field label="Supplier invoice" hint="Photograph every page. The e-way bill and packing list can be added later.">
          {/* capture="environment" opens the rear camera straight away. */}
          <input
            type="file"
            accept="image/*,application/pdf"
            capture="environment"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
            className="w-full py-2 text-sm"
            required
          />
        </Field>
      </div>

      {error ? <div className="mt-2"><ErrorBox error={error} /></div> : null}

      <div className="mt-3 flex gap-2">
        <Button type="submit" variant="primary" disabled={busy} className="flex-1 justify-center py-2 text-sm">
          {busy ? 'Uploading and reading…' : 'Capture and read'}
        </Button>
        <Button onClick={() => setOpen(false)} className="py-2">Cancel</Button>
      </div>
    </form>
  );
}

function DocumentSet({ id, onClose, session }) {
  const [set, setSet] = useState(null);
  const [checks, setChecks] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await receiving.get(id);
      setSet(data);
      setChecks(data.checks || []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function run(action, fn) {
    setBusy(action);
    setError(null);
    try {
      const result = await fn();
      if (result?.checks) setChecks(result.checks);
      await load();
      return result;
    } catch (err) {
      setError(err);
      return null;
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Spinner label="Loading" />;
  if (!set) return <ErrorBox error={error} onRetry={load} />;

  const blocking = checks.filter((c) => !c.passed && c.severity === 'BLOCK');
  const warnings = checks.filter((c) => !c.passed && c.severity === 'WARN');
  const unanswered = warnings.filter((c) => !c.overrideReason && !overrides[c.code]);
  const canPost = set.status !== 'POSTED' && !blocking.length && !unanswered.length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button onClick={onClose}>← Back</Button>
        <Verdict level={set.status === 'POSTED' ? 'OK' : set.status === 'NEEDS_REVIEW' ? 'WARN' : 'NEUTRAL'}>
          {set.status}
        </Verdict>
        <span className="text-sm font-medium">{set.extractedHeader?.invoiceNo || '(no invoice number)'}</span>
      </div>

      <ContextBanner session={session} />
      <ErrorBox error={error} onRetry={load} />

      {set.posted?.grnVoucherNo ? (
        <div className="border border-ok-border bg-ok-bg px-3 py-2">
          <p className="text-sm font-semibold text-ok">Posted</p>
          <p className="mt-0.5 text-xs text-ok">
            GRN <span className="font-mono">{set.posted.grnVoucherNo}</span> ·
            PI <span className="font-mono">{set.posted.piVoucherNo}</span>
          </p>
          {set.posted.stockRefreshOk === false ? (
            <p className="mt-1 text-2xs text-warn">
              The stock refresh did not complete ({set.posted.stockRefreshError}). The GRN and
              invoice are still correct — stock is computed from transactions.
            </p>
          ) : null}
        </div>
      ) : null}

      <InvoiceHeader header={set.extractedHeader} />
      <LineList lines={set.extractedLines || []} />

      {checks.length ? (
        <section>
          <SectionHeading>Checks</SectionHeading>
          <ul className="space-y-1">
            {checks.map((check, i) => (
              <CheckRow
                key={`${check.code}-${check.lineNo ?? 'doc'}-${i}`}
                check={overrides[check.code] ? { ...check, overrideReason: overrides[check.code] } : check}
                onOverride={(code, reason) => setOverrides((prev) => ({ ...prev, [code]: reason }))}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {preview ? <PostPreview preview={preview} onClose={() => setPreview(null)} /> : null}

      {set.status !== 'POSTED' ? (
        <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-slate-200 bg-white p-2">
          <Button
            onClick={() => run('match', () => receiving.match(id))}
            disabled={Boolean(busy)}
            className="py-2"
          >
            {busy === 'match' ? 'Matching…' : 'Match to POs and check'}
          </Button>

          {/*
            The dry run is the safeguard that makes the first live post
            reviewable: it returns the exact rows that would be written.
          */}
          <Button
            onClick={async () => {
              const result = await run('dry', () => receiving.post(id, {}, { dryRun: true }));
              if (result) setPreview(result);
            }}
            disabled={Boolean(busy)}
            className="py-2"
          >
            {busy === 'dry' ? 'Building…' : 'Preview what would be written'}
          </Button>

          <Button
            variant="primary"
            disabled={Boolean(busy) || !canPost}
            onClick={() => run('post', () => receiving.post(id, {
              overrides: Object.entries(overrides).map(([code, reason]) => ({ code, reason })),
            }))}
            className="ml-auto py-2"
          >
            {busy === 'post' ? 'Posting…' : 'Post GRN and invoice'}
          </Button>
        </div>
      ) : null}

      {blocking.length ? (
        <p className="border border-block-border bg-block-bg px-2 py-1 text-2xs text-block">
          {blocking.length} blocking check{blocking.length === 1 ? '' : 's'}. These cannot be
          overridden — the invoice or the PO has to be corrected first.
        </p>
      ) : unanswered.length ? (
        <p className="border border-warn-border bg-warn-bg px-2 py-1 text-2xs text-warn">
          {unanswered.length} warning{unanswered.length === 1 ? '' : 's'} need a recorded reason.
        </p>
      ) : null}
    </div>
  );
}

function InvoiceHeader({ header }) {
  if (!header) return null;
  const rows = [
    ['Invoice', header.invoiceNo],
    ['Date', date(header.invoiceDate)],
    ['Supplier GSTIN', header.supplierGstin],
    ['Ship to', header.shipToState || header.shipToGstin],
    ['Tax type', header.taxType],
    ['Sub total', money(header.subTotal)],
    ['Freight', money(header.freight)],
    ['Taxable', money(header.taxable)],
    ['CGST', money(header.cgst)],
    ['SGST', money(header.sgst)],
    ['IGST', money(header.igst)],
    ['Round off', money(header.roundOff)],
    ['Grand total', money(header.grandTotal)],
    ['E-way bill', header.eWayBillNo],
  ];

  return (
    <section className="border border-slate-200 bg-white p-3">
      <SectionHeading>Invoice</SectionHeading>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-2xs uppercase tracking-wide text-slate-500">{label}</dt>
            <dd className="tabular-nums">{value || '—'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * One card per line rather than a table row.
 *
 * Every variance a store person has to judge is on the card: PO quantity,
 * pending, invoiced, computed kg against billed kg, PO rate against invoice
 * rate.
 */
function LineList({ lines }) {
  if (!lines.length) return <Empty title="No lines extracted yet." />;

  return (
    <section className="space-y-2">
      <SectionHeading>Lines ({lines.length})</SectionHeading>
      {lines.map((line) => {
        const overPo = Number.isFinite(line.poPendingQty) && Number.isFinite(line.qty)
          && line.qty > line.poPendingQty * 1.1;
        const rateMismatch = Number.isFinite(line.matchedPoRate) && Number.isFinite(line.rate)
          && Math.abs(line.rate - line.matchedPoRate) > 0.01;

        return (
          <div
            key={line.lineNo}
            className={`border p-2 ${overPo || rateMismatch ? 'border-block-border bg-block-bg' : 'border-slate-200 bg-white'}`}
          >
            <div className="flex items-baseline gap-2">
              <span className="text-2xs text-slate-400">#{line.lineNo}</span>
              <span className="flex-1 text-sm font-medium">{truncate(line.description, 60)}</span>
              {line.matchedPoTransactionId ? (
                <Tag title={`Matched to PO ${line.poVoucherNo}`}>{line.poVoucherNo || 'matched'}</Tag>
              ) : (
                <Tag title="No open PO line was found for this item">no PO</Tag>
              )}
            </div>

            <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs md:grid-cols-6">
              <Cell label="PO qty">{number(line.poQty)}</Cell>
              <Cell label="Pending">{number(line.poPendingQty)}</Cell>
              <Cell label="Invoiced" tone={overPo ? 'block' : undefined}>{number(line.qty)}</Cell>
              <Cell label="Computed kg">{number(line.computedKg)}</Cell>
              <Cell label="Billed kg">{number(line.billedKg ?? line.qty)}</Cell>
              <Cell label="PO rate">{money(line.matchedPoRate)}</Cell>
              <Cell label="Invoice rate" tone={rateMismatch ? 'block' : undefined}>{money(line.rate)}</Cell>
              <Cell label="Amount">{money(line.amount)}</Cell>
            </dl>
          </div>
        );
      })}
    </section>
  );
}

function Cell({ label, children, tone }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`tabular-nums ${tone === 'block' ? 'font-semibold text-block' : ''}`}>
        {children ?? '—'}
      </dd>
    </div>
  );
}

/** The dry run, shown as the rows that would actually be written. */
function PostPreview({ preview, onClose }) {
  return (
    <section className="border border-slate-300 bg-slate-50 p-3">
      <SectionHeading actions={<Button variant="ghost" onClick={onClose}>close</Button>}>
        What would be written
      </SectionHeading>

      {preview.erpWritesEnabled === false ? (
        <p className="mb-2 border border-warn-border bg-warn-bg px-2 py-1 text-2xs text-warn">
          ERP writes are currently disabled on the server. This is a preview only.
        </p>
      ) : null}

      <div className="space-y-2 text-2xs">
        <details open>
          <summary className="cursor-pointer font-semibold">GRN — {preview.grn?.voucherNo}</summary>
          <pre className="mt-1 overflow-x-auto border border-slate-200 bg-white p-2 font-mono">
            {JSON.stringify(preview.grn, null, 2)}
          </pre>
        </details>
        <details>
          <summary className="cursor-pointer font-semibold">Purchase invoice — {preview.pi?.voucherNo}</summary>
          <pre className="mt-1 overflow-x-auto border border-slate-200 bg-white p-2 font-mono">
            {JSON.stringify(preview.pi, null, 2)}
          </pre>
        </details>
        <details>
          <summary className="cursor-pointer font-semibold">
            PO lines that would close ({preview.closedLines?.length || 0})
          </summary>
          <pre className="mt-1 overflow-x-auto border border-slate-200 bg-white p-2 font-mono">
            {JSON.stringify(preview.closedLines, null, 2)}
          </pre>
        </details>
      </div>
    </section>
  );
}

export { STEPS };
