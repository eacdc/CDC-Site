# This folder belongs in its own repository

The Supplier Portal frontend was asked for as a **separate repo**. It is
checked in here only so the code is not lost — the session that wrote it ran in
an ephemeral container, and creating a repository under the `eacdc`
organisation was refused:

```
POST https://api.github.com/orgs/eacdc/repos → 404 Not Found
```

That is a permissions result, not a missing organisation: the GitHub App this
session authenticates through can push to all 30-odd existing `eacdc`
repositories but cannot create new ones. Granting it `administration: write` on
the org, or simply creating the empty repo by hand, resolves it.

## Moving it out

Create an **empty** repo (no README, no .gitignore — the folder already has
both), then:

```sh
# from the root of a CDC-Site checkout, on this branch
cp -r supplier-portal-frontend /tmp/cdc-supplier-portal
cd /tmp/cdc-supplier-portal
rm HANDOVER.md

git init -b main
git add -A
git commit -m "CDC Supplier Portal frontend"
git remote add origin git@github.com:eacdc/cdc-supplier-portal.git
git push -u origin main

npm install
npm run dev        # http://localhost:5174
```

Then delete this folder from CDC-Site — the backend repo should not carry a
copy of a frontend that lives elsewhere:

```sh
git rm -r supplier-portal-frontend
git commit -m "Move the Supplier Portal frontend to its own repository"
```

## What is in it

See `README.md` in this folder. In short: React + Vite + Tailwind, talking to
`/api/supplier-portal` in this backend. Item search and detail, quote upload and
review, the keyboard-driven mapping queue, supplier grouping, PO check, a
tablet-first receiving flow, and seven reports.

`npm run build` and `npm run lint` both pass. Every screen has been rendered
against the fixture server in `.mock/`, which is also the easiest way to run the
UI without a backend:

```sh
node .mock/server.mjs   # serves enough data on :3001 to render every screen
npm run dev
```
