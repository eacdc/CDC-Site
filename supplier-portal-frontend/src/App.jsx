/**
 * The shell.
 *
 * Left nav, a top bar carrying global search and the active session context,
 * and a routed body. The session context — user, employee ledger, warehouse
 * and site — is in the top bar on every screen because the ERP writes a
 * voucher against whichever of those is selected, and a store person who
 * cannot see which warehouse they are receiving into will eventually receive
 * into the wrong one.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { auth, getSite, getToken, setSite, setToken, plantForSite } from './lib/api.js';
import { siteLabel } from './lib/format.js';
import { Spinner } from './components/ui.jsx';

import Login from './pages/Login.jsx';
import Quotes from './pages/Quotes.jsx';
import QuoteReview from './pages/QuoteReview.jsx';
import ItemSearch from './pages/ItemSearch.jsx';
import ItemDetail from './pages/ItemDetail.jsx';
import MappingQueue from './pages/MappingQueue.jsx';
import Reports from './pages/Reports.jsx';
import PoCheck from './pages/PoCheck.jsx';
import Receiving from './pages/Receiving.jsx';
import Suppliers from './pages/Suppliers.jsx';

const NAV = [
  { to: '/quotes', label: 'Quotes' },
  { to: '/items', label: 'Items' },
  { to: '/mapping', label: 'Mapping queue' },
  { to: '/suppliers', label: 'Suppliers' },
  { to: '/po-check', label: 'PO check' },
  { to: '/receiving', label: 'Receiving' },
  { to: '/reports', label: 'Reports' },
];

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));

  const loadSession = useCallback(async () => {
    if (!getToken()) { setSession(null); setLoading(false); return; }
    try {
      const me = await auth.me();
      setSession(me);
      if (me.context?.site) setSite(me.context.site);
    } catch {
      setToken(null);
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSession(); }, [loadSession]);

  if (loading) {
    return <div className="flex h-screen items-center justify-center"><Spinner label="Signing in" /></div>;
  }

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<Login onSignedIn={loadSession} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return <Shell session={session} onSessionChange={loadSession} />;
}

function Shell({ session, onSessionChange }) {
  const navigate = useNavigate();
  const [site, setSiteState] = useState(getSite());
  const plant = useMemo(() => plantForSite(site), [site]);

  /**
   * Switching site switches database. It is a full reload rather than a state
   * update because every cached ItemID, LedgerID and WarehouseID on screen
   * belongs to the old one, and showing them under the new site's name would
   * be worse than a moment's blank.
   */
  const switchSite = useCallback(async (next) => {
    setSite(next);
    setSiteState(next);
    try { await auth.setContext({ site: next }); } catch { /* the header still carries it */ }
    window.location.reload();
  }, []);

  const signOut = useCallback(async () => {
    try { await auth.logout(); } finally {
      setToken(null);
      navigate('/login');
      onSessionChange();
    }
  }, [navigate, onSessionChange]);

  return (
    <div className="flex h-screen flex-col">
      <TopBar
        session={session}
        site={site}
        plant={plant}
        onSwitchSite={switchSite}
        onSignOut={signOut}
      />

      <div className="flex min-h-0 flex-1">
        <nav className="w-40 shrink-0 border-r border-slate-200 bg-white">
          <ul className="py-1">
            {NAV.map((entry) => (
              <li key={entry.to}>
                <NavLink
                  to={entry.to}
                  className={({ isActive }) => `block px-3 py-1.5 text-xs ${
                    isActive
                      ? 'border-l-2 border-slate-900 bg-slate-100 font-semibold text-slate-900'
                      : 'border-l-2 border-transparent text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {entry.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 flex-1 overflow-auto bg-slate-50 p-3">
          <Routes>
            <Route path="/" element={<Navigate to="/items" replace />} />
            <Route path="/login" element={<Navigate to="/items" replace />} />
            <Route path="/quotes" element={<Quotes site={site} />} />
            <Route path="/quotes/:id" element={<QuoteReview site={site} plant={plant} />} />
            <Route path="/items" element={<ItemSearch site={site} plant={plant} />} />
            <Route path="/items/:itemId" element={<ItemDetail site={site} plant={plant} />} />
            <Route path="/mapping" element={<MappingQueue site={site} />} />
            <Route path="/suppliers" element={<Suppliers site={site} />} />
            <Route path="/po-check" element={<PoCheck site={site} plant={plant} />} />
            <Route path="/receiving" element={<Receiving site={site} session={session} />} />
            <Route path="/reports" element={<Reports site={site} plant={plant} />} />
            <Route path="*" element={<Navigate to="/items" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function TopBar({ session, site, plant, onSwitchSite, onSignOut }) {
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const context = session.context || {};

  return (
    <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-1.5">
      <span className="text-sm font-semibold tracking-tight text-slate-900">
        CDC Supplier Portal
      </span>

      <form
        className="ml-2 w-80"
        onSubmit={(e) => {
          e.preventDefault();
          if (term.trim()) navigate(`/items?q=${encodeURIComponent(term.trim())}`);
        }}
      >
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search items, codes, supplier products…"
          className="w-full border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-300"
        />
      </form>

      <div className="ml-auto flex items-center gap-3 text-2xs text-slate-500">
        {/* The site selector is a database selector. It is labelled as both. */}
        <label className="flex items-center gap-1">
          <span className="uppercase tracking-wide">Site</span>
          <select
            value={site}
            onChange={(e) => onSwitchSite(e.target.value)}
            className="border border-slate-300 px-1 py-0.5 text-2xs"
          >
            <option value="KOL">Kolkata</option>
            <option value="AHM">Ahmedabad</option>
          </select>
        </label>

        <span title="Rates and vouchers are scoped to this plant">
          Plant <span className="font-semibold text-slate-800">{plant}</span>
        </span>

        {/*
          Employee ledger and warehouse are shown because a GRN is written
          against them. UserMaster and LedgerMaster are not linked in the ERP,
          so the acting employee is a choice the user makes, not a lookup.
        */}
        {context.employeeLedgerId ? (
          <span title="The employee ledger receipts are recorded against (ReceivedBy)">
            Employee <span className="font-mono text-slate-700">{context.employeeLedgerId}</span>
          </span>
        ) : null}
        {context.warehouseId ? (
          <span title="The warehouse goods are received into">
            WH <span className="font-mono text-slate-700">{context.warehouseId}</span>
          </span>
        ) : null}

        <span className="text-slate-700">{session.user?.displayName || session.user?.email}</span>
        <button type="button" onClick={onSignOut} className="underline hover:text-slate-900">
          Sign out
        </button>
      </div>
    </header>
  );
}

export { siteLabel };
