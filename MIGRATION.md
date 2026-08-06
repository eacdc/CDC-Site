# Migration Brief: Cloudinary → Cloudflare R2

Hand this to Claude Code in each repo. It describes what changed, what to change,
and what must NOT change.

---

## 1. Context

All 15,985 assets have already been copied from Cloudinary to a **private**
Cloudflare R2 bucket. No data migration is needed in the app code — this is
purely a change of how images are addressed, served, and uploaded.

| | Before | After |
|---|---|---|
| Storage | Cloudinary | Cloudflare R2, bucket `cdc-media` |
| Access | Public URLs | Private bucket + short-lived presigned URLs |
| Transformations | `w_500,f_auto,q_auto` in URL | **None. Originals only.** |
| Uploads | Cloudinary upload API/widget | Presigned PUT direct to R2 |
| SDK | `cloudinary` | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` |

**The object keys are identical to the Cloudinary public_ids**, with the file
extension appended. A Cloudinary asset with public_id
`purchase-bills/2026/inv-4471` and format `jpg` is now the R2 object
`purchase-bills/2026/inv-4471.jpg`.

---

## 2. Critical constraints — do not violate

1. **Never expose R2 credentials to the browser.** No access key, secret, or
   account ID in frontend bundles, `NEXT_PUBLIC_*` vars, or client JS. The
   browser only ever receives presigned URLs minted server-side.
2. **Never let the client choose an upload key.** The server generates it. A
   client-supplied key allows overwriting existing invoices.
3. **No image transformations.** The library is photographed tax and purchase
   invoices — fine print, stamps, QR codes. Lossy re-encoding destroys
   legibility and breaks QR scanning. Serve originals. Do not add a resizing
   layer "for performance".
4. **Do not make the bucket public.** These are accounting documents.
5. **Authorise before minting.** The session/permission check happens in the
   route that issues a presigned URL, not after. Once issued, a presigned URL
   works for anyone holding it.

---

## 3. Install the shared module

Copy `r2-storage.js` into each repo (e.g. `lib/r2-storage.js`). Then:

```bash
npm uninstall cloudinary
npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

### Environment variables

Remove:
```
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
CLOUDINARY_URL
```

Add (set these in Render's dashboard, not in a committed file):
```
R2_ACCOUNT_ID=a710d464e4c350c7117cc64812bd2f4d
R2_BUCKET=cdc-media

# Read+write — only on services that accept uploads
R2_RW_ACCESS_KEY_ID=
R2_RW_SECRET_ACCESS_KEY=

# Read-only — on services that merely display images
R2_RO_ACCESS_KEY_ID=
R2_RO_SECRET_ACCESS_KEY=
```

---

## 4. Find every Cloudinary usage

Grep the repo for all of these:

```
res.cloudinary.com
cloudinary.com
require('cloudinary')
from 'cloudinary'
CLOUDINARY
cloudinary.uploader
cloudinary.url
cloudinary.image
upload_preset
cl_image_upload        # Cloudinary upload widget
cloudinary-core
cloudinary-react
next-cloudinary
```

Also check: `.env.example`, Dockerfiles, `next.config.js` image domains,
CSP headers, and any hardcoded URLs in seed data, email templates, or
PDF generation code.

Produce a list of every hit before changing anything.

---

## 5. Replace the read path

### Before
```js
const url = cloudinary.url(publicId, { secure: true });
// or
const url = `https://res.cloudinary.com/dzxhlml5w/image/upload/v1/${publicId}.jpg`;
```

### After
```js
import { viewUrl, viewUrls, downloadUrl } from '../lib/r2-storage.js';

const url = await viewUrl(key);                    // display in <img>
const url = await downloadUrl(key, 'invoice.jpg'); // forces save-as dialog
```

`viewUrl` is **async**. Every call site becomes `await`, which usually means
the enclosing function becomes async too. Follow that up the call stack and
fix it properly — do not paper over it with `.then()` inside JSX.

For lists, resolve once rather than per row:

```js
const bills = await db.collection('bills').find(query).toArray();
const signed = await viewUrls(bills.map(b => b.key));
const urlByKey = Object.fromEntries(signed.map(s => [s.key, s.url]));
```

### Expiry behaviour

Signed URLs expire (default 1 hour for viewing, 5 minutes for downloads).
Consequences to handle:

- Any page containing signed URLs must be **server-rendered per request**, not
  statically generated or cached longer than the expiry.
- If a page can stay open longer than an hour, add a refresh path: on `<img>`
  `onError`, re-request a fresh URL from the backend rather than showing a
  broken image.
- Never persist a signed URL to the database. **Store the key, sign on read.**

---

## 6. Replace the write path

Three steps. Do not collapse them.

```js
// Route 1 — mint the URL. Session check goes HERE.
app.post('/api/upload-url', requireAuth, async (req, res) => {
  const { contentType, contentLength } = req.body;
  try {
    const { key, url } = await createUploadUrl({
      folder: 'purchase-bills',
      contentType,
      contentLength,
    });
    res.json({ key, url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Route 2 — confirm and persist. Session check HERE too.
app.post('/api/upload-complete', requireAuth, async (req, res) => {
  const meta = await confirmUpload(req.body.key, req.body.size);
  await db.collection('bills').insertOne({
    key: meta.key,
    bytes: meta.bytes,
    contentType: meta.contentType,
    uploadedAt: new Date(),
  });
  res.json({ ok: true, key: meta.key });
});
```

Client side:

```js
const { key, url } = await fetch('/api/upload-url', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ contentType: file.type, contentLength: file.size }),
}).then(r => r.json());

const put = await fetch(url, {
  method: 'PUT',
  headers: { 'Content-Type': file.type },
  body: file,
});
if (!put.ok) throw new Error(`Upload failed: ${put.status}`);

await fetch('/api/upload-complete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key, size: file.size }),
});
```

**The `Content-Type` header on the PUT must exactly match what was declared
in step 1.** It is signed into the URL; a mismatch returns 403.

For server-side sources (WhatsApp webhooks, scheduled imports, scanner drop
folders) skip the presigned flow entirely and call `uploadBuffer()`.

---

## 7. Database migration

If records store **public_ids**, nothing to do — they are already valid keys,
minus the extension. Confirm whether your stored value includes the extension;
if not, the extension must be appended (it is stored on the asset record, or
can be recovered from `inventory.jsonl` in the migration folder).

If records store **full Cloudinary URLs**, write a one-off script:

```js
function cloudinaryUrlToKey(url) {
  const m = url.match(/\/(?:image|video|raw)\/(?:upload|private|authenticated)\/(.+)$/);
  if (!m) return null;
  const parts = m[1].split('/');
  // drop transformation segments like "w_500,c_fill,f_auto"
  while (parts.length && /^[a-z]{1,3}_/.test(parts[0])) parts.shift();
  // drop the version segment like "v1712345678"
  if (parts.length && /^v\d+$/.test(parts[0])) parts.shift();
  return parts.join('/');
}
```

Requirements for that script:
- **Dry-run mode first.** Print every old → new mapping, write to a CSV, and
  have a human review a sample before writing anything.
- Log every URL that returns `null` and stop if there are any — an unparsed
  URL is a record you are about to break.
- Cross-check the resulting keys against `inventory.jsonl` (15,985 entries)
  and report any key that does not exist in the bucket.
- Store the key in a **new field**, keep the old URL field for one release
  cycle so rollback is a config flip rather than a restore.

---

## 8. Acceptance criteria

Before merging, verify all of these:

- [ ] `grep -ri cloudinary` returns zero hits outside of migration scripts and comments
- [ ] `cloudinary` removed from `package.json`
- [ ] No R2 credential appears in any client bundle (`npm run build`, then grep the output)
- [ ] An invoice renders at full resolution; small print and GSTIN are legible
- [ ] Downloading gives a save-as dialog with a sensible filename, and the file is byte-identical to the original
- [ ] Upload of a valid JPEG succeeds end to end and creates a DB row
- [ ] Upload of a 40 MB file is rejected by the server before any PUT
- [ ] Upload of a `.exe` renamed to `.jpg` is rejected on content type
- [ ] Calling `/api/upload-url` without a session returns 401
- [ ] A signed URL still works after 1 minute and fails after its expiry
- [ ] Bucket Public Access is still Disabled

---

## 9. Rollback plan

The Cloudinary account remains live and unchanged throughout. Keep the old
URL field in the database and gate the read path behind a flag:

```js
const url = process.env.USE_R2 === 'true'
  ? await viewUrl(record.key)
  : record.cloudinaryUrl;
```

Roll out one site at a time. Only after all five have run clean for a week
should the Cloudinary account be cancelled and the legacy fields dropped.
