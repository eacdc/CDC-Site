/**
 * Sign in.
 *
 * The receiving context — site, employee ledger, warehouse — is chosen here
 * rather than at post time. `UserMaster` and `LedgerMaster` are not linked in
 * the ERP, so which employee a user is acting as is a choice, and making it
 * once at sign-in is how the ERP's own screens work.
 */

import { useState } from 'react';
import { auth, setSite, setToken } from '../lib/api.js';
import { Button, ErrorBox, Field, Input, Select } from '../components/ui.jsx';

export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [site, setSiteChoice] = useState('KOL');
  const [employeeLedgerId, setEmployeeLedgerId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await auth.login({
        email,
        password,
        site,
        employeeLedgerId: employeeLedgerId || undefined,
        warehouseId: warehouseId || undefined,
      });
      setToken(result.token);
      setSite(result.context?.site || site);
      onSignedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <form onSubmit={submit} className="w-full max-w-sm border border-slate-200 bg-white p-5">
        <h1 className="text-base font-semibold text-slate-900">CDC Supplier Portal</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Rates, matching, PO checks and receiving.
        </p>

        <div className="mt-4 space-y-3">
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </Field>

          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>

          <Field
            label="Site"
            hint="Kolkata and Ahmedabad are separate databases with separate item and ledger IDs."
          >
            <Select value={site} onChange={(e) => setSiteChoice(e.target.value)}>
              <option value="KOL">Kolkata — IndusEnterprise</option>
              <option value="AHM">Ahmedabad — IndusEnterprise2</option>
            </Select>
          </Field>

          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer select-none">
              Receiving context (store staff only)
            </summary>
            <div className="mt-2 space-y-2">
              <Field
                label="Employee ledger ID"
                hint="Who receipts are recorded against. This is a LedgerMaster id, not a user id."
              >
                <Input
                  value={employeeLedgerId}
                  onChange={(e) => setEmployeeLedgerId(e.target.value)}
                  inputMode="numeric"
                  placeholder="e.g. 9879"
                />
              </Field>
              <Field label="Warehouse ID" hint="Where goods are received.">
                <Input
                  value={warehouseId}
                  onChange={(e) => setWarehouseId(e.target.value)}
                  inputMode="numeric"
                  placeholder="e.g. 13"
                />
              </Field>
            </div>
          </details>
        </div>

        {error ? <div className="mt-3"><ErrorBox error={error} /></div> : null}

        <Button
          type="submit"
          variant="primary"
          disabled={busy || !email || !password}
          className="mt-4 w-full justify-center py-1.5"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
