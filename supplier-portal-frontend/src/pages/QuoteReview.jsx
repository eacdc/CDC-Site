/**
 * Quote review — source on the left, extracted table on the right, editable.
 *
 * Nothing enters rate history until a human approves here. That is the whole
 * design: extraction is fast and mostly right, and "mostly right" written
 * silently into a rate table is worse than slow, because a wrong rate stays
 * invisible until somebody buys against it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { quotes } from '../lib/api.js';
import { date, money, truncate } from '../lib/format.js';
import {
  Button, CheckRow, Empty, ErrorBox, Input, SectionHeading, Spinner, Tag, Verdict,
} from '../components/ui.jsx';

export default function QuoteReview() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await quotes.get(id));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner label="Loading the document" />;
  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!data) return <Empty title="Document not found." />;

  const { document: doc, lines, supplierGroup, pageUrls } = data;
  const documentChecks = doc.checks || [];
  const lineChecks = lines.flatMap((l) => (l.checks || []).map((c) => ({ ...c, lineNo: l.lineNo })));
  const allChecks = [...documentChecks, ...lineChecks];
  const blocking = allChecks.filter((c) => !c.passed && c.severity === 'BLOCK');
  const warnings = allChecks.filter((c) => !c.passed && c.severity === 'WARN');
  const unansweredWarnings = warnings.filter((c) => !c.overrideReason && !overrides[c.code]);

  async function run(action, fn) {
    setBusy(action);
    setError(null);
    try { await fn(); await load(); } catch (err) { setError(err); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Link to="/quotes" className="text-2xs text-slate-500 underline">← All quotes</Link>
        <h1 className="text-base font-semibold text-slate-900">
          {supplierGroup?.name || 'Unknown supplier'}
        </h1>
        <Verdict level={doc.status === 'APPROVED' ? 'OK' : doc.status === 'NEEDS_REVIEW' ? 'WARN' : 'NEUTRAL'}>
          {doc.status}
        </Verdict>
        <Tag>{doc.docType}</Tag>
        {doc.quoteStrength === 'SOFT' ? <Tag title="Never used as hard evidence in a PO check">soft quote</Tag> : null}
      </div>

      <DocumentSummary doc={doc} />

      <div className="grid gap-3 lg:grid-cols-5">
        <section className="lg:col-span-2">
          <SectionHeading>Source</SectionHeading>
          {pageUrls?.length ? (
            <div className="space-y-2">
              {pageUrls.map((url, i) => (
                <a key={url} href={url} target="_blank" rel="noreferrer" className="block">
                  <img
                    src={url}
                    alt={`Page ${i + 1}`}
                    className="w-full border border-slate-200 object-contain"
                  />
                </a>
              ))}
            </div>
          ) : (
            <Empty
              title="No preview available."
              hint="Worksheets are parsed as a grid rather than rendered."
            />
          )}
        </section>

        <section className="lg:col-span-3 space-y-2">
          <SectionHeading
            actions={
              <>
                <Button
                  onClick={() => run('match', () => quotes.match(id))}
                  disabled={Boolean(busy) || doc.status === 'APPROVED'}
                >
                  {busy === 'match' ? 'Matching…' : 'Run matching'}
                </Button>
                <Button
                  variant="primary"
                  disabled={
                    Boolean(busy) || doc.status === 'APPROVED'
                    || blocking.length > 0 || unansweredWarnings.length > 0
                  }
                  onClick={() => run('approve', () => quotes.approve(id, {
                    overrides: Object.entries(overrides).map(([code, reason]) => ({ code, reason })),
                  }))}
                >
                  {busy === 'approve' ? 'Approving…' : 'Approve and write rates'}
                </Button>
              </>
            }
          >
            Extracted lines ({lines.length})
          </SectionHeading>

          {/*
            The approve button's own reason for being disabled, stated. A
            greyed-out button with no explanation is the most common way a
            review screen wastes somebody's afternoon.
          */}
          {blocking.length ? (
            <p className="border border-block-border bg-block-bg px-2 py-1 text-2xs text-block">
              {blocking.length} blocking check{blocking.length === 1 ? '' : 's'} must be fixed before
              approval. These cannot be overridden.
            </p>
          ) : unansweredWarnings.length ? (
            <p className="border border-warn-border bg-warn-bg px-2 py-1 text-2xs text-warn">
              {unansweredWarnings.length} warning{unansweredWarnings.length === 1 ? '' : 's'} need a
              recorded reason before approval.
            </p>
          ) : doc.status === 'APPROVED' ? (
            <p className="border border-ok-border bg-ok-bg px-2 py-1 text-2xs text-ok">
              Approved on {date(doc.approvedAt)} by {doc.approvedBy}. Rate history has been written.
            </p>
          ) : null}

          <LineTable
            lines={lines}
            editing={editing}
            onEdit={setEditing}
            onSave={async (lineId, raw) => {
              await run('edit', () => quotes.editLine(id, lineId, { raw }));
              setEditing(null);
            }}
          />
        </section>
      </div>

      {allChecks.length ? (
        <section>
          <SectionHeading>Checks</SectionHeading>
          <ul className="space-y-1">
            {allChecks.map((check, i) => (
              <CheckRow
                key={`${check.code}-${check.lineNo ?? 'doc'}-${i}`}
                check={overrides[check.code] ? { ...check, overrideReason: overrides[check.code] } : check}
                onOverride={(code, reason) => setOverrides((prev) => ({ ...prev, [code]: reason }))}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function DocumentSummary({ doc }) {
  return (
    <div className="grid gap-2 border border-slate-200 bg-white px-3 py-2 text-xs md:grid-cols-4">
      <Detail label="Effective from">{date(doc.effectiveFrom)}</Detail>
      <Detail label="Valid to">
        {date(doc.effectiveTo)}
        {doc.validityBasis !== 'STATED' ? (
          <span
            className="ml-1 text-2xs text-warn"
            title={
              doc.validityBasis === 'NONE_GIVEN'
                ? 'The document gave no date at all — this expiry is the default, not the supplier’s terms'
                : 'Derived from the effective date and the default validity'
            }
          >
            ({doc.validityBasis.toLowerCase().replace('_', ' ')})
          </span>
        ) : null}
      </Detail>
      <Detail label="Plants">
        {doc.plantScope?.length ? doc.plantScope.join(' + ') : <span className="text-warn">not stated</span>}
        {doc.plantScopeBasis === 'ASSUMED' ? (
          <span className="ml-1 text-2xs text-warn" title="Nobody has confirmed this against the document">
            (assumed)
          </span>
        ) : null}
      </Detail>
      <Detail label="Entity scope">{doc.cdcEntityScope}</Detail>

      {doc.commercialTerms?.paymentTerms ? (
        <Detail label="Payment">{doc.commercialTerms.paymentTerms}</Detail>
      ) : null}
      {doc.commercialTerms?.freightTerms ? (
        <Detail label="Freight">{doc.commercialTerms.freightTerms}</Detail>
      ) : null}
      {doc.nominatedPriceColumn ? (
        <Detail label="Price column">{doc.nominatedPriceColumn}</Detail>
      ) : null}
      {doc.derivationRules?.length ? (
        <Detail label="Stated rules">
          {doc.derivationRules.map((r, i) => (
            <span key={i} className="block text-2xs text-slate-500">{r.note}</span>
          ))}
        </Detail>
      ) : null}
    </div>
  );
}

function LineTable({ lines, editing, onEdit, onSave }) {
  if (!lines.length) {
    return <Empty title="No lines were extracted." hint="Check the source document, then re-run extraction." />;
  }

  return (
    <div className="overflow-x-auto border border-slate-200">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-slate-100">
          <tr>
            <th className="px-2 py-1 text-left font-semibold text-slate-600" style={{ width: '32px' }}>#</th>
            <th className="px-2 py-1 text-left font-semibold text-slate-600">Product</th>
            <th className="px-2 py-1 text-left font-semibold text-slate-600" style={{ width: '110px' }}>Code</th>
            <th className="px-2 py-1 text-right font-semibold text-slate-600" style={{ width: '90px' }}>As quoted</th>
            <th className="px-2 py-1 text-left font-semibold text-slate-600" style={{ width: '60px' }}>Unit</th>
            <th className="px-2 py-1 text-right font-semibold text-slate-600" style={{ width: '110px' }}>Normalised</th>
            <th className="px-2 py-1 text-left font-semibold text-slate-600" style={{ width: '110px' }}>Flags</th>
            <th className="px-2 py-1" style={{ width: '50px' }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const failing = (line.checks || []).filter((c) => !c.passed);
            const worst = failing.some((c) => c.severity === 'BLOCK') ? 'BLOCK'
              : failing.length ? 'WARN' : null;

            if (editing === line._id) {
              return <EditRow key={line._id} line={line} onCancel={() => onEdit(null)} onSave={onSave} />;
            }

            return (
              <tr
                key={line._id}
                className={`border-b border-slate-100 ${
                  worst === 'BLOCK' ? 'bg-block-bg' : worst === 'WARN' ? 'bg-warn-bg' : ''
                }`}
              >
                <td className="px-2 py-1 text-slate-400">{line.lineNo}</td>
                <td className="px-2 py-1">
                  <span title={line.raw?.productName}>{truncate(line.raw?.productName, 50)}</span>
                  {line.raw?.packSize ? (
                    <span className="ml-1 text-2xs text-slate-400">({line.raw.packSize})</span>
                  ) : null}
                </td>
                <td className="px-2 py-1 font-mono text-2xs">{line.raw?.productCode || '—'}</td>
                <td className="px-2 py-1 text-right tabular-nums">{line.raw?.rate || '—'}</td>
                <td className="px-2 py-1">{line.raw?.uom || <span className="text-warn">?</span>}</td>
                <td className="px-2 py-1 text-right tabular-nums" title={line.normalised?.conversionNote}>
                  {line.normalised?.ratePerBaseUom
                    ? `${money(line.normalised.ratePerBaseUom)}`
                    : <span className="text-slate-400">—</span>}
                  {line.normalised?.uom ? (
                    <span className="ml-0.5 text-2xs text-slate-400">/{line.normalised.uom}</span>
                  ) : null}
                </td>
                <td className="px-2 py-1">
                  <div className="flex flex-wrap gap-0.5">
                    {(line.flags || []).map((flag) => (
                      <Tag key={flag} title={FLAG_HINTS[flag]}>{flag.replaceAll('_', ' ').toLowerCase()}</Tag>
                    ))}
                  </div>
                </td>
                <td className="px-2 py-1">
                  <Button variant="ghost" onClick={() => onEdit(line._id)}>edit</Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Editing supersedes the line rather than overwriting it, so what the document
 * actually said stays recoverable — otherwise a reviewer's correction and a
 * bad extraction look identical afterwards.
 */
function EditRow({ line, onCancel, onSave }) {
  const [raw, setRaw] = useState(line.raw || {});
  const field = (key) => (
    <Input
      value={raw[key] ?? ''}
      onChange={(e) => setRaw((prev) => ({ ...prev, [key]: e.target.value }))}
    />
  );

  return (
    <tr className="border-b border-slate-200 bg-slate-50">
      <td className="px-2 py-1 text-slate-400">{line.lineNo}</td>
      <td className="px-2 py-1">{field('productName')}</td>
      <td className="px-2 py-1">{field('productCode')}</td>
      <td className="px-2 py-1">{field('rate')}</td>
      <td className="px-2 py-1">{field('uom')}</td>
      <td className="px-2 py-1">{field('packSize')}</td>
      <td className="px-2 py-1 text-2xs text-slate-500">
        The original line is kept and superseded.
      </td>
      <td className="px-2 py-1">
        <div className="flex flex-col gap-1">
          <Button variant="primary" onClick={() => onSave(line._id, raw)}>save</Button>
          <Button variant="ghost" onClick={onCancel}>cancel</Button>
        </div>
      </td>
    </tr>
  );
}

const FLAG_HINTS = {
  PACK_SIZE_IN_NAME: 'A pack size was found inside the product name.',
  PACK_UOM_ASSUMED: 'A bare number was read as a pack size using the supplier default.',
  RATE_TREATED_AS_PER_PACK: 'The quoted figure was treated as the price of a whole pack.',
  UOM_UNRESOLVED: 'The unit could not be resolved and needs a human.',
  NO_UOM_ON_LINE: 'This line stated no unit of its own.',
  WEB_LOOKUP_ELIGIBLE: 'Carries a brand or product code, so an online lookup would be meaningful.',
  HUMAN_CORRECTED: 'Corrected by a reviewer.',
};

function Detail({ label, children }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5">{children}</p>
    </div>
  );
}
