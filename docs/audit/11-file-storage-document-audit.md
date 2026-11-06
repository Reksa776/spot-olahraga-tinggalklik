# 11 — FILE STORAGE & DOCUMENT MANAGEMENT AUDIT

---

## 1. Storage architecture

All files are stored on the **local filesystem**, rooted at `UPLOAD_DIR` (default `./storage/uploads`). No S3/GCS/Azure/Cloudinary integration exists.

| Tree | Visibility | Purpose |
|---|---|---|
| `events/` | **Public** (`/api/uploads/events/[filename]`) | Processed event banners/gallery |
| `branding/` | **Public** (`/api/uploads/branding/[filename]`) | Application logo |
| `settlement-proof/` | **Private** | Payout transfer evidence |
| `refund-evidence/` | **Private** | Refund transfer evidence |

---

## 2. Event image pipeline

`lib/images/process.ts`, `lib/images/format.ts`, `lib/images/strip-metadata.ts`:

- max **5 MB**, re-checked on actual bytes;
- client MIME is not trusted; format detected by magic bytes (JPEG/PNG/WebP);
- metadata/EXIF is stripped in memory; the original bytes are never written;
- output is validated as the same container;
- filename generated server-side (random), so path traversal is structurally impossible;
- served with `X-Content-Type-Options: nosniff`, long cache, `inline`;
- public route reduces the filename to `basename` and rejects anything that is not already a bare basename.

**Purpose:** event imagery is public catalog content. This is appropriate for banners, not for participant documents.

---

## 3. Private financial evidence

### Settlement proof
`lib/ticketing/settlement/proof.ts`:

- `<UPLOAD_DIR>/settlement-proof`;
- 5 MB cap, magic bytes JPEG/PNG/WebP/PDF (`%PDF-`);
- server-generated filename; write-then-rename;
- served only through an authenticated, organizer-scoped route that re-checks the settlement tenant and `settlement.proof.upload` on every request;
- headers include `private, no-store`, `nosniff`, `Content-Disposition`.

### Refund evidence
`lib/ticketing/refunds/evidence.ts`:

- `<UPLOAD_DIR>/refund-evidence`;
- same 5 MB / magic-byte / server-name rules;
- served through an authenticated, tenant-scoped, OWN-scope route: the owning customer may read their own refund evidence; PICs cannot; cross-tenant is 404;
- DB stores key, name, size, MIME, uploader, timestamp.

These are the correct patterns to reuse for feature 4, but they are **financial evidence**, not a general document-distribution system.

---

## 4. Access-control matrix

| File class | Anonymous | Customer | Organizer staff | PIC | Admin |
|---|---|---|---|---|---|
| Event image | Yes | Yes | Yes | Yes | Yes |
| Branding logo | Yes | Yes | Yes | Yes | Yes |
| Settlement proof | No | No | Authorized tenant + permission | No | Platform permission |
| Refund evidence | No | Owning buyer only | Authorized tenant | No | Platform permission |
| Participant document (feature 4) | **Does not exist** | — | — | — | — |

---

## 5. Post-event documents today

The only post-event artifact is `Event.documentationUrl`:

- optional Google Drive link;
- validated as HTTPS and restricted to Drive hosts (`lib/events/validation.ts:98-120`);
- edited via `components/organizer/EventDocumentationManager.tsx`;
- shown publicly on `app/e/[slug]/page.tsx:320-337` only when `COMPLETED`;
- **no upload, no private storage, no recipient selection, no delivery, no expiry, no audit**.

Anyone with the URL can open the Drive file. It is organizer-authored public material, not a blast.

---

## 6. Feature 4 storage requirements

To support "PIC uploads a document and sends it to selected participants":

1. **Document model** — owner event/organizer, uploader, original name, server key, MIME, size, checksum, created/expiry, status.
2. **Private storage tree** — e.g. `<UPLOAD_DIR>/event-documents`, never under the public `events/` route.
3. **Access-controlled read** — either a stream route that authorizes per recipient/PIC, or a short-lived signed URL; never a public path.
4. **Recipient selection** — define participant = ticket holder or attendee; exclude refunded/void by policy.
5. **Delivery linkage** — one row per (document, recipient, channel) with unique key; reuse `Notification`/`NotificationDelivery` or add a document-delivery table.
6. **Expiry/retention** — retention policy and deletion job.
7. **Audit** — who uploaded, who sent, which recipients, outcome.
8. **Virus/malware scanning** — not present today; documents are higher risk than images.

**No such model, route or UI exists.** `docs/audit/14-feature-gap-analysis.md` treats this as the only feature likely to require a schema migration.

---

## 7. Findings

| # | Finding | Severity |
|---|---|---|
| F-1 | Public event images are correctly processed and metadata-stripped | Strength |
| F-2 | Private financial evidence has tenant/own-scope read routes | Strength |
| F-3 | Storage is local disk only; no horizontal scale or object-store redundancy | Medium |
| F-4 | No malware scanning for uploaded PDFs/images | Medium |
| F-5 | No document model or private document tree | **Critical for feature 4** |
| F-6 | `documentationUrl` is a public Drive link, not an access-controlled document | High for feature 4 |
| F-7 | No retention/expiry policy for documents | High (product/legal) |
| F-8 | Upload filenames are server-generated and magic-byte validated | Strength |
| F-9 | No signed-URL mechanism; private files are streamed through authorized routes | INFO (current scale is fine) |

---

## 8. Recommendations

1. Do not extend the public `events/` tree for participant documents.
2. Reuse the settlement/refund evidence pattern (server names, magic bytes, private route, no-store) but add a document-specific authorization decider.
3. Prefer an authorized streaming route over public/signed URLs at current scale; if signed URLs are chosen, keep expiry short and bind to the recipient.
4. Add malware scanning or at least PDF sanitisation before accepting documents.
5. Define retention and deletion before launch; documents may contain personal or sensitive event material.
6. Keep `documentationUrl` as public event material; do not conflate it with private distribution.
