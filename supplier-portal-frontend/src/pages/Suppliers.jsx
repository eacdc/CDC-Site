/**
 * Supplier groups.
 *
 * The one piece of master data the portal owns rather than reads, because the
 * ERP has no concept of "these five ledgers are one supplier". Without the
 * grouping, "who is cheapest" compares Siegwerk's Bhiwandi branch against its
 * Bengaluru branch and supplier scoring fragments into meaningless slices.
 *
 * Reconciliation surfaces unplaced ledgers rather than grouping them
 * automatically: a wrong grouping silently corrupts every comparison that
 * follows, and the cost of asking is one screen.
 */

import { useCallback, useEffect, useState } from 'react';
import { suppliers } from '../lib/api.js';
import { siteLabel } from '../lib/format.js';
import {
  Button, DataTable, Empty, ErrorBox, Field, Input, SectionHeading, Select, Spinner, Tag,
} from '../components/ui.jsx';

export default function Suppliers({ site }) {
  const [groups, setGroups] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGroups(await suppliers.list());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, site]);

  async function reconcile() {
    setBusy('reconcile');
    setError(null);
    try {
      const result = await suppliers.reconcile({});
      setUnmatched(result.unmatched || []);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function assign(ledgerId, groupId) {
    const group = groups.find((g) => String(g._id) === String(groupId));
    if (!group) return;
    await suppliers.update(groupId, {
      ledgerRefs: [...(group.ledgerRefs || []), { site, ledgerId }],
    });
    setUnmatched((prev) => prev.filter((u) => u.ledgerId !== ledgerId));
    load();
  }

  const columns = [
    { key: 'name', label: 'Supplier', width: '200px' },
    {
      key: 'ledgerRefs',
      label: `Ledgers at ${siteLabel(site)}`,
      render: (r) => {
        const here = (r.ledgerRefs || []).filter((l) => l.site === site);
        if (!here.length) return <span className="text-warn">none linked here</span>;
        return (
          <span className="font-mono text-2xs">{here.map((l) => l.ledgerId).join(', ')}</span>
        );
      },
    },
    {
      key: 'aliases',
      label: 'Also known as',
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {(r.aliases || []).map((a) => <Tag key={a}>{a}</Tag>)}
          {(r.tradesAs || []).map((a) => (
            <Tag key={a} title="Quotes arrive from this entity; POs go to the group">{a} (trader)</Tag>
          ))}
        </div>
      ),
    },
    {
      key: 'isInternal',
      label: '',
      width: '140px',
      render: (r) => (r.isInternal
        ? <Tag title="An inter-unit transfer, not a purchase — excluded from every benchmark">internal transfer</Tag>
        : null),
    },
  ];

  return (
    <div className="space-y-3">
      <SectionHeading
        actions={
          <>
            <Button onClick={reconcile} disabled={busy === 'reconcile'}>
              {busy === 'reconcile' ? 'Checking…' : 'Reconcile ERP ledgers'}
            </Button>
            <Button variant="primary" onClick={() => setCreating((c) => !c)}>
              {creating ? 'Close' : 'New group'}
            </Button>
          </>
        }
      >
        Supplier groups
      </SectionHeading>

      {creating ? <CreateGroup onCreated={() => { setCreating(false); load(); }} /> : null}

      <ErrorBox error={error} onRetry={load} />

      {unmatched.length ? (
        <section className="border border-warn-border bg-warn-bg p-2">
          <p className="text-xs font-semibold text-warn">
            {unmatched.length} ERP supplier ledger{unmatched.length === 1 ? '' : 's'} not linked to a group
          </p>
          <p className="mt-0.5 text-2xs text-warn">
            Until these are placed, their rates are invisible to comparison. Suggestions
            are scored by name similarity — check them rather than accepting them.
          </p>
          <ul className="mt-2 space-y-1">
            {unmatched.map((row) => (
              <li key={row.ledgerId} className="flex flex-wrap items-center gap-2 bg-white px-2 py-1">
                <span className="font-mono text-2xs text-slate-500">{row.ledgerId}</span>
                <span className="text-xs">{row.ledgerName}</span>
                {row.suggestion ? (
                  <Tag title={`Name similarity ${row.suggestion.score}`}>
                    maybe {row.suggestion.name}
                  </Tag>
                ) : null}
                <Select
                  className="ml-auto w-56"
                  defaultValue={row.suggestion?.groupId || ''}
                  onChange={(e) => e.target.value && assign(row.ledgerId, e.target.value)}
                >
                  <option value="">Link to…</option>
                  {groups.map((g) => <option key={g._id} value={g._id}>{g.name}</option>)}
                </Select>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {loading ? <Spinner label="Loading suppliers" /> : (
        <DataTable
          columns={columns}
          rows={groups}
          keyField="_id"
          empty={
            <Empty
              title="No supplier groups yet."
              hint="Run Reconcile to pull the ERP's supplier ledgers, then group the branches that belong together."
            />
          }
        />
      )}
    </div>
  );
}

function CreateGroup({ onCreated }) {
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [tradesAs, setTradesAs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await suppliers.create({
        name: name.trim(),
        aliases: aliases.split(',').map((a) => a.trim()).filter(Boolean),
        tradesAs: tradesAs.split(',').map((a) => a.trim()).filter(Boolean),
      });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="border border-slate-200 bg-white p-3">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Aliases" hint="Comma separated. Branch names and misspellings — SIEGWORK is in the data.">
          <Input value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </Field>
        <Field
          label="Trades as"
          hint="Entities that quote on this supplier's behalf. Kamal Enterprises quotes; K K Emulsions invoices."
        >
          <Input value={tradesAs} onChange={(e) => setTradesAs(e.target.value)} />
        </Field>
      </div>

      {error ? <div className="mt-2"><ErrorBox error={error} /></div> : null}

      <Button type="submit" variant="primary" disabled={busy || !name.trim()} className="mt-3">
        {busy ? 'Creating…' : 'Create group'}
      </Button>
    </form>
  );
}
