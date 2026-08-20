/**
 * Quote documents: the list, and the upload flow.
 *
 * Upload asks for the plant scope up front and records whether the answer came
 * from the document or from the person uploading. A quote silent on plant is
 * asked about at review rather than assumed, because assuming is how one
 * plant's rate ends up standing in for the other's.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { quotes, suppliers } from '../lib/api.js';
import { date, dateTime, truncate } from '../lib/format.js';
import {
  Button, DataTable, Empty, ErrorBox, Field, SectionHeading, Select, Spinner, Tag, Verdict,
} from '../components/ui.jsx';

const DOC_TYPES = [
  ['PRICE_LIST', 'Price list'],
  ['EMAIL', 'Email'],
  ['PROFORMA_INVOICE', 'Proforma invoice'],
  ['HANDWRITTEN_NOTE', 'Handwritten note'],
  ['WORKSHEET', 'Worksheet (xlsx)'],
];

const STATUS_TONE = {
  APPROVED: 'OK',
  NEEDS_REVIEW: 'WARN',
  REJECTED: 'BLOCK',
};

export default function Quotes({ site }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [groups, setGroups] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showUpload, setShowUpload] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, groupList] = await Promise.all([
        quotes.list({ status: status || undefined, limit: 100 }),
        suppliers.list(),
      ]);
      setRows(list.documents || []);
      setGroups(groupList || []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load, site]);

  const groupName = (id) => groups.find((g) => String(g._id) === String(id))?.name || '—';

  const columns = [
    { key: 'uploadedAt', label: 'Uploaded', width: '130px', render: (r) => dateTime(r.uploadedAt) },
    { key: 'supplierGroupId', label: 'Supplier', width: '160px', render: (r) => groupName(r.supplierGroupId) },
    {
      key: 'originalFilename',
      label: 'Document',
      render: (r) => (
        <div>
          <span title={r.originalFilename}>{truncate(r.originalFilename || '(no filename)', 44)}</span>
          <div className="mt-0.5 flex flex-wrap gap-1">
            <Tag>{r.docType}</Tag>
            {r.quoteStrength === 'SOFT' ? (
              <Tag title="Subject to change without notice">soft</Tag>
            ) : null}
            {r.isPartialUpdate ? (
              <Tag title="Restates only some lines of an earlier quote">partial re-quote</Tag>
            ) : null}
          </div>
        </div>
      ),
    },
    {
      key: 'plantScope',
      label: 'Plant',
      width: '150px',
      render: (r) => (
        <span title={r.plantScopeBasis === 'ASSUMED' ? 'Assumed by the uploader — confirm at review' : `Plant scope: ${r.plantScopeBasis}`}>
          {r.plantScope?.length ? r.plantScope.join(' + ') : <span className="text-warn">not stated</span>}
        </span>
      ),
    },
    {
      key: 'effectiveTo',
      label: 'Valid to',
      width: '150px',
      render: (r) => (
        <span title={`Basis: ${r.validityBasis}`}>
          {date(r.effectiveTo)}
          {r.validityBasis !== 'STATED' ? (
            <span className="ml-1 text-2xs text-slate-400">({r.validityBasis?.toLowerCase()})</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      width: '120px',
      render: (r) => <Verdict level={STATUS_TONE[r.status] || 'NEUTRAL'}>{r.status}</Verdict>,
    },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <SectionHeading>Quote documents</SectionHeading>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="ml-auto w-44">
          <option value="">All statuses</option>
          <option value="UPLOADED">Uploaded</option>
          <option value="EXTRACTED">Extracted</option>
          <option value="NEEDS_REVIEW">Needs review</option>
          <option value="APPROVED">Approved</option>
          <option value="SUPERSEDED">Superseded</option>
          <option value="REJECTED">Rejected</option>
        </Select>
        <Button variant="primary" onClick={() => setShowUpload((s) => !s)}>
          {showUpload ? 'Close' : 'Upload a quote'}
        </Button>
      </div>

      {showUpload ? (
        <UploadPanel
          groups={groups}
          onUploaded={(id) => { setShowUpload(false); load(); if (id) navigate(`/quotes/${id}`); }}
        />
      ) : null}

      <ErrorBox error={error} onRetry={load} />

      {loading ? <Spinner label="Loading quotes" /> : (
        <DataTable
          columns={columns}
          rows={rows}
          keyField="_id"
          onRowClick={(row) => navigate(`/quotes/${row._id}`)}
          empty={<Empty title="No quote documents yet." hint="Upload a supplier price list, email, or worksheet to start." />}
        />
      )}
    </div>
  );
}

/**
 * Upload.
 *
 * Worksheets go straight to the server because the grid has to be parsed
 * there; images and PDFs take the presigned path so the file never passes
 * through the API process.
 */
function UploadPanel({ groups, onUploaded }) {
  const [supplierGroupId, setSupplierGroupId] = useState('');
  const [docType, setDocType] = useState('PRICE_LIST');
  const [plantScope, setPlantScope] = useState(['KOLKATA']);
  const [quoteStrength, setQuoteStrength] = useState('FIRM');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState('');

  function togglePlant(plant) {
    setPlantScope((prev) => (
      prev.includes(plant) ? prev.filter((p) => p !== plant) : [...prev, plant]
    ));
  }

  async function submit(event) {
    event.preventDefault();
    if (!file || !supplierGroupId) return;
    setBusy(true);
    setError(null);
    try {
      if (docType === 'WORKSHEET') {
        setProgress('Uploading and parsing the worksheet…');
        const form = new FormData();
        form.append('file', file);
        form.append('supplierGroupId', supplierGroupId);
        form.append('plantScope', JSON.stringify(plantScope));
        const result = await quotes.worksheet(form);
        onUploaded(result.documentId);
        return;
      }

      setProgress('Requesting an upload URL…');
      const signed = await quotes.uploadUrl({
        contentType: file.type,
        contentLength: file.size,
      });

      setProgress('Uploading…');
      const put = await fetch(signed.url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);

      setProgress('Registering the document…');
      const sha256 = await hashFile(file);
      const registered = await quotes.register({
        supplierGroupId,
        docType,
        storageKey: signed.key,
        originalFilename: file.name,
        mimeType: file.type,
        sha256,
        plantScope,
        plantScopeBasis: 'ASSUMED',
        quoteStrength,
      });

      setProgress('Extracting…');
      await quotes.extract(registered.document._id);
      onUploaded(registered.document._id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  return (
    <form onSubmit={submit} className="border border-slate-200 bg-white p-3">
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Supplier">
          <Select value={supplierGroupId} onChange={(e) => setSupplierGroupId(e.target.value)} required>
            <option value="">Select…</option>
            {groups.map((g) => <option key={g._id} value={g._id}>{g.name}</option>)}
          </Select>
        </Field>

        <Field label="Document type">
          <Select value={docType} onChange={(e) => setDocType(e.target.value)}>
            {DOC_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>

        <Field
          label="Quote strength"
          hint="Soft quotes are usable as benchmarks but never block a PO check."
        >
          <Select value={quoteStrength} onChange={(e) => setQuoteStrength(e.target.value)}>
            <option value="FIRM">Firm</option>
            <option value="SOFT">Soft — subject to change</option>
          </Select>
        </Field>

        <Field label="File">
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.xls,.docx"
            className="w-full text-xs"
            required
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field
          label="Plants this quote covers"
          hint="A document covering both writes a separate rate per plant. If the document is silent, say so — the review screen will ask."
        >
          <div className="flex gap-3 pt-0.5">
            {['KOLKATA', 'AHMEDABAD'].map((plant) => (
              <label key={plant} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={plantScope.includes(plant)}
                  onChange={() => togglePlant(plant)}
                />
                {plant}
              </label>
            ))}
          </div>
        </Field>
      </div>

      {error ? <div className="mt-2"><ErrorBox error={error} /></div> : null}

      <div className="mt-3 flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !file || !supplierGroupId || !plantScope.length}
        >
          {busy ? 'Working…' : 'Upload and extract'}
        </Button>
        {progress ? <span className="text-2xs text-slate-500">{progress}</span> : null}
      </div>
    </form>
  );
}

/**
 * SHA-256 in the browser, so the duplicate check runs before extraction is
 * paid for.
 */
async function hashFile(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
