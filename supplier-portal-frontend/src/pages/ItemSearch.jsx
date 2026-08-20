/**
 * Item search.
 *
 * One box, accepting a generic name ("cyan coated", "shrink film 16 inch"), an
 * ItemCode or an ItemID. It also searches the supplier product names mapped to
 * each item, which is what lets a buyer type "sicura" and reach
 * `UV Ink - Process-Cyan` — a CDC name containing no such word.
 *
 * The plant selector sits beside the box, never buried in a filter panel: a
 * rate list means nothing without knowing which plant it is for.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { items } from '../lib/api.js';
import { plantLabel, truncate } from '../lib/format.js';
import {
  DataTable, Empty, ErrorBox, PlantBanner, SearchInput, Select, Spinner, Tag,
} from '../components/ui.jsx';

export default function ItemSearch({ site, plant }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [term, setTerm] = useState(params.get('q') || '');
  const [selectedPlant, setSelectedPlant] = useState(plant);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);

  const run = useCallback(async (query) => {
    if (!query.trim()) { setResults([]); setSearched(false); return; }
    setLoading(true);
    setError(null);
    try {
      const data = await items.search(query.trim(), { plant: selectedPlant });
      setResults(data.results || []);
      setSearched(true);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [selectedPlant]);

  // Debounced so typing does not fire a query per keystroke against the ERP.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (term.trim()) {
        run(term);
        setParams({ q: term.trim() }, { replace: true });
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [term, run, setParams]);

  const columns = [
    {
      key: 'ItemCode',
      label: 'Code',
      width: '120px',
      mono: true,
      render: (r) => r.ItemCode || '—',
    },
    {
      key: 'ItemName',
      label: 'Item',
      render: (r) => (
        <div>
          <span title={r.ItemName}>{truncate(r.ItemName, 70)}</span>
          {r.matchedVia === 'SUPPLIER_NAME' ? (
            <span className="ml-1.5">
              <Tag title="Found through a mapped supplier product name, not CDC's own name">
                via supplier name
              </Tag>
            </span>
          ) : null}
        </div>
      ),
    },
    { key: 'ItemGroupName', label: 'Group', width: '150px' },
    {
      key: 'ItemSubGroupName',
      label: 'Sub-group',
      width: '150px',
      // Paper carries no sub-group on any item; that is the master, not a gap
      // in the data we hold.
      render: (r) => r.ItemSubGroupName || <span className="text-slate-400">—</span>,
    },
    { key: 'StockUnit', label: 'Stock', width: '70px' },
    { key: 'PurchaseUnit', label: 'Purchase', width: '70px' },
    { key: 'ItemID', label: 'ItemID', width: '80px', align: 'right', mono: true },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <SearchInput
            value={term}
            onChange={setTerm}
            placeholder="Item name, code, ItemID, or a supplier's product name…"
            autoFocus
          />
        </div>
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

      <ErrorBox error={error} onRetry={() => run(term)} />

      {loading ? <Spinner label="Searching" /> : null}

      {!loading && searched && !results.length ? (
        <Empty
          title={`Nothing matched "${term}".`}
          hint="Try a shorter fragment, the ItemCode, or the supplier's own product name."
        />
      ) : null}

      {!loading && !searched ? (
        <Empty
          title="Search for an item to see every supplier's current rate."
          hint="Accepts a generic name, an ItemCode, an ItemID, or a supplier's product name."
        />
      ) : null}

      {results.length ? (
        <DataTable
          columns={columns}
          rows={results}
          keyField="ItemID"
          onRowClick={(row) => navigate(`/items/${row.ItemID}?plant=${selectedPlant}`)}
        />
      ) : null}
    </div>
  );
}
