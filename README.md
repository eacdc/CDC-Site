Backend (Node.js + Express + MSSQL)

Setup

1. Create database table and test user
- Open SQL Server Management Studio (SSMS)
- Run the script in `sql/init_users.sql` against your database

2. Configure environment variables in `.env`

```
PORT=3001
DB_USER=your_sql_user
DB_PASSWORD=your_sql_password
DB_NAME=your_database_name
DB_SERVER=localhost\\SQLEXPRESS

# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/contractor-po-system
MONGODB_URI_VT=mongodb://localhost:27017/voice-tool

# OpenAI Configuration (Required for Voice Note Tool AI analysis)
OPENAI_API_KEY=your_openai_api_key_here

# JWT Secret
JWT_SECRET=your_jwt_secret_here
```

**Note:** To use the Voice Note Tool's AI analysis feature, you need to:
1. Sign up for an OpenAI API account at https://platform.openai.com/
2. Create an API key from your OpenAI dashboard
3. Add the API key to your `.env` file as `OPENAI_API_KEY`

3. Start the server

```
npm start
```

API

- POST `/api/auth/login`
  - body: `{ "userId": "testuser", "password": "Passw0rd!" }`
  - response: `{ "username": "Test User", "userId": "testuser", "empId": "EMP001" }`



---

## CDC Stock Issue Tool (`/api/issue-tool`)

Lets storekeepers issue paper and other stock to jobs, replacing the ERP's two issue screens. It writes `-19` issue vouchers to the live IndusEnterprise database. Those vouchers must be indistinguishable from the ERP's own, and must share the ERP's voucher numbering. The frontend is a separate repo (`eacdc/Item-Issue-Tool`), built from `docs/issue-tool-api.md`.

| Where | What |
|---|---|
| `src/issue-tool/` | The module: routes, auth, validation, read queries, posting service |
| `sql/issue-tool/` | The only three database objects it adds: `IssueTool_PostLog`, `usp_IssueTool_PostIssue`, `usp_IssueTool_DeleteIssue`. Idempotent; deploy them yourself, in order |
| `docs/issue-tool-api.md` | API contract for the frontend |
| `docs/issue-tool-schema-notes.md` | What is known about the ERP schema, what is assumed, what discovery decides |
| `scripts/issue-tool-*.js` | Discovery, acceptance tests A/B (dry run), voucher compare |

The tool writes what the ERP's issue screen writes: `ItemTransactionMain` / `ItemTransactionDetail` (the issue) and `ItemConsumptionMain` / `ItemConsumptionDetail` (the "received on floor" voucher, VoucherID -53 "RFS", that the ERP writes with every issue, found on 6 Oct 2026), plus its own `IssueTool_PostLog`, and only through the two procedures. The only ERP procedure it calls is `UPDATE_ITEM_STOCK_VALUES`, after commit. It never sets `IsCompleted` on a picklist line.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ISSUE_TOOL_COMPANY_ID` | `2` | CompanyID it reads and writes. Optional per-site override `ISSUE_TOOL_COMPANY_ID_KOL` / `_AHM` |
| `ISSUE_TOOL_ALLOW_WRITES` | `false` | Until `true`, every post and delete runs in a transaction that is rolled back, and the response says `dryRun: true` |
| `ISSUE_TOOL_CORS_ORIGIN` | — | Frontend origin(s). Only matters once `CORS_ORIGINS` restricts the server (unset = all origins allowed) |
| `DB_NAME_KOL` / `DB_NAME_AHM` and the other `DB_*` | existing | The database comes from the user's site, through the shared pool in `src/db.js` |
| `JWT_SECRET` | existing | Signs the session token |
| `ISSUE_TOOL_SESSION_HOURS` | `12` | How long a sign-in lasts |

**Users.** Sign-in is the same as the production entry tool: username + database (KOL / AHM), no password. The username is matched against the ERP's `UserMaster.UserName` or `LoginUserName` in that database (active, not blocked), and that user's `UserID` goes into `UserID`, `CreatedBy`, `ModifiedBy` and `DeletedBy`. There is no separate user list. As with the production tool, anyone who knows an ERP username can sign in as that user.

**Dry run.** While `ISSUE_TOOL_ALLOW_WRITES` is off, a dry run still performs the inserts before rolling them back. That uses up identity values (gaps in TransactionID) and holds row locks for the length of one save.

### Assumptions to correct after the first live test

Discovery (5 Oct 2026, see `docs/issue-tool-schema-notes.md`) confirmed the floor-warehouse flag, the department and process columns, the blank-string values, the numbering scope and that no template column is missing. Still marked `ASSUMPTION` in the code:

1. The remark is stored in `ItemTransactionMain.Narration` (the column exists; no capture had a remark).
2. The header `DepartmentID` of an allocated issue comes from the picklist line.
3. Slip Date is not stored (`DeliveryNoteDate` stayed NULL), so the API takes no slip date.
4. Delete recalculates stock with `@TransactionID = 0, @DeletedItemID = <item>`, once per item.
5. A substitute in a direct issue counts against the job's requirement for the same item group + stock unit.

Two deliberate differences from the brief:

- `UPDATE_ITEM_STOCK_VALUES` is called by the API right after the procedure commits, not from inside the procedure. A slow refresh can then never hold the numbering lock, or time out the request before the client has its voucher number.
- Dry runs are logged in `IssueTool_PostLog` with `IsDryRun = 1`, after their rollback. The idempotency check only looks at real posts.

### Go-live checklist

1. **Discovery reviewed.** `npm run issue-tool:discover` (and `-- --site AHM`). Section 1 lists no missing columns. Sections 6 and 7 are read, `@NumberPerCompany`, `@Blank` and the `TEMPLATE` columns in `002_usp_IssueTool_PostIssue.sql` are set accordingly, and `docs/issue-tool-schema-notes.md` is updated.
2. **Objects deployed** in order: `sql/issue-tool/001…`, `002…`, `003…`.
3. **Dry-run tests A and B pass.** `npm run issue-tool:acceptance` prints "Acceptance tests A and B pass": every field the brief confirms matches, and the would-be rows equal the ERP's IS17252_26_27 and IS17254_26_27 column by column.
4. **Frontend walk-through in dry run**, using the test checklist in the frontend repo.
5. **First real post** (ask before doing it). Set `ISSUE_TOOL_ALLOW_WRITES=true`, post one small issue, then compare it with an ERP-made issue of the same kind: `npm run issue-tool:compare -- <ourTransactionId> <erpTransactionId>`. Check the ItemMaster stock moved as the ERP's would (test A: PhysicalStock down, FloorStock up, by the quantity), and the picklist line is still `IsCompleted = 0`.
6. **Delete tested.** Delete that issue from History; header and lines are `IsDeletedTransaction = 1` with `DeletedBy` / `DeletedDate` set, `ModifiedBy` / `ModifiedDate` untouched, and stock is back.
