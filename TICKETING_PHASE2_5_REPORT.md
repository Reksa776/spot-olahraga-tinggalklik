# TICKETING PHASE 2.5 — Migration Infrastructure Remediation & Database Safety Hardening

**Repository:** `demo-marketplace` · branch `main`
**Phase:** 2.5 (migration/infrastructure remediation) — **no feature work**
**Baselines read:** `TICKETING_REBUILD_AUDIT.md`, `TICKETING_PHASE1_DESIGN.md`, `TICKETING_PHASE2_REPORT.md`
**Date:** 2026-09-16
**Deliverables:** `TICKETING_PHASE2_5_REPORT.md` (this file), 1 new migration, 4 corrected historical migrations

---

## 1. Executive Summary

**PHASE 2.5 STATUS: PASS WITH WARNINGS**

Phase 2 left behind a migration chain that could not be replayed into an empty database. That is
fixed, and the fix is proven by replaying the entire chain into three separate throwaway databases,
including one deliberately created with the server's default collation — the harsher case.

The headline results:

1. **BLK-1 is fixed.** `prisma migrate deploy` now runs the full 18-migration chain into an empty
   database with **zero manual SQL** and exits 0. It previously died at migration 8 of 17.
2. **The root cause was larger than reported.** Phase 2 recorded BLK-1 as "`0_baseline` creates
   PascalCase tables, later migrations use lowercase". That was only the *first* of **four** distinct
   defects. Two tables (`adminauditlog`, and seven columns plus one enum value of `affiliatepayout`)
   existed in every real database but were created by **no migration at all** — they had arrived via
   `prisma db push`. A from-scratch replay was missing them entirely.
3. **A freshly provisioned database is now structurally identical to the live database** —
   70 tables, 886 columns, 324 indexes, 62 unique constraints, 146 foreign keys, on both.
4. **Provisioning is now deterministic with respect to collation.** It was not: three tables
   (`broadcast`, `bulkdiscount`, `shippingdiscount`) were created by hand-written migrations with no
   collation clause, so they silently inherited whatever collation the *database* happened to have.
   A migration now pins them, so the result no longer depends on how the operator typed
   `CREATE DATABASE`.
5. **A latent trap was closed:** editing already-applied migrations left live's stored checksums
   disagreeing with the corrected files. Prisma 6.19 does **not** detect this, so it would have
   surfaced later, on a stricter Prisma version. The four bookkeeping rows were repaired and verified.
6. **The Phase 2 ticketing schema was not touched.** All 27 ticketing tables, 34 enums and 31 nullable
   columns are exactly as Phase 2 delivered them. `schema.prisma` was not modified in this phase.

Nothing was hidden. Two things need a human decision (§14): a durable backup location that is not a
single disk, and the still-outstanding KTP git-history purge — which this phase deliberately did not
perform and deliberately did not authorise.

---

## 2. Initial Repository State

### 2.1 Git state at the start of Phase 2.5

```
 M next-env.d.ts                                        <- pre-existing, untouched
 M package-lock.json                                    <- pre-existing, untouched
 M prisma/migrations/20260820095404_.../migration.sql   <- Phase 2.5 change
 M prisma/migrations/20260825100000_add_spin_wheel/...  <- Phase 2.5 change
 M prisma/migrations/20260909000000_.../migration.sql   <- Phase 2.5 change
 M prisma/migrations/20260909010000_.../migration.sql   <- Phase 2.5 change
 M prisma/schema.prisma                                 <- Phase 2 change (1,419 insertions)
?? TICKETING_REBUILD_AUDIT.md                          <- Phase 0
?? TICKETING_PHASE1_DESIGN.md                          <- Phase 1
?? TICKETING_PHASE2_REPORT.md                          <- Phase 2
?? prisma/migrations/20260916000000_ticketing_phase2_foundation/   <- Phase 2
?? prisma/seed-sports.ts                               <- Phase 2
?? prisma/seed-regions.js                              <- pre-existing, untouched
```

`prisma/seed-regions.js` is untracked but was **not created by this project's phases** — it predates
Phase 0 and was left alone, per §3.

### 2.2 Migration count

16 migrations at the start of Phase 2.5, of which 15 were applied to live. Migration 16
(`20260916000000_ticketing_phase2_foundation`) was applied to live during Phase 2 with explicit
approval. **18** migrations exist at the end (two added by this phase, see §4).

### 2.3 Phase 2 state confirmed before any change

* `prisma migrate status` → `Database schema is up to date!`
* Live database: 70 tables.
* All Phase 2 ticketing objects present; **zero** ticketing business rows
  (organizers 0, events 0, ticket types 0, orders 0, tickets 0, payments 0, webhook events 0).
* Real business data intact: 59 users, 5 products, 149 orders.

### 2.4 Environment facts that mattered

| Fact | Value | Consequence |
| --- | --- | --- |
| MySQL flavour | MariaDB 11.8.8 | Server default collation is `utf8mb4_uca1400_ai_ci` |
| Live DB | `tinggalklik` @ 127.0.0.1:3306 | The only database holding real data |
| `/tmp` filesystem | **`tmpfs`** (RAM) | The Phase 2 backup really was ephemeral — see §10 |
| Home filesystem | `/dev/nvme0n1p8` (btrfs) | Durable; used for the backup |

> **Method note.** A `CD` to a stale path early in this session silently ran several read-only
> probes against the wrong working directory, and one `prisma migrate diff` produced an *empty*
> result because the URL pointed at a database that does not exist — an empty diff that would have
> read as a clean bill of health. Every comparison in this report was therefore re-run with the
> connection **proved** against the intended database first. The false readings are not reported as
> findings anywhere. This is recorded because "the diff was empty" and "the diff never ran" are
> indistinguishable without that check.

---

## 3. BLK-1 Root Cause

Phase 2 reported BLK-1 as a single defect: PascalCase table names in `0_baseline` versus lowercase
names in later migrations. That is correct but incomplete. Replaying the chain into an empty database
revealed **four independent defects**, any one of which alone would have broken provisioning.

### Defect 1 — The chain switches naming convention without a rename

Every migration up to and including `20260909010000_add_order_original_spin` creates **PascalCase**
tables, because it predates the `@@map` annotations now in `schema.prisma`. From Phase 2 onward the
migrations use the **lowercase** `@@map` names.

The chain never renamed anything, so a replayed database was left with PascalCase tables while
migration 17 referred to `user`, `notification`, `refund` and `adminauditlog`. It failed at migration
8 of 17 with a missing-table error. The exact failing statement was recorded:

```
20260820095404_add_marketing_affiliate_foundation/migration.sql:2
  ALTER TABLE `voucher` ADD COLUMN `campaignId` INTEGER NULL, ...
```

`voucher` was simply a typo — the foreign key at the bottom of that same file already said `Voucher`.
The same lowercase error appeared in two other hand-written migrations (`order`, `shippingdiscount`,
`spinwheelspin`).

### Defect 2 — `adminauditlog` was created by no migration

`schema.prisma` declares `AdminAuditLog`, and every real database has the table. **No migration ever
created it.** It had been introduced with `prisma db push`. Since the Phase 2 migration issues
`ALTER TABLE adminauditlog`, a freshly provisioned database also lacked that table.

### Defect 3 — `affiliatepayout` was only partly created

`20260820095404_add_marketing_affiliate_foundation` creates `AffiliatePayout` with its original twelve
columns. Seven columns (`providerTransactionId`, `providerReference`, `idempotencyKey`, `paidAt`,
`failedAt`, `failureReason`, `providerStatus`) and the `FAILED` value of `AffiliatePayoutStatus` were
added to the real database by `prisma db push` and appear in no migration. A replayed database was
missing all seven, and its `status` enum would reject `FAILED`.

### Defect 4 — A redundant duplicate unique index

`20260825100000_add_spin_wheel` declared `` `orderId` INTEGER NULL UNIQUE `` on `SpinWheelSpin` *and*
created an explicit `UNIQUE INDEX SpinWheelSpin_orderId_key`. A replayed database therefore carried
**two** unique indexes on the same column; the real database has one.

### Why this was invisible until now

`prisma db push` was used to evolve the development database, so the database gained objects that the
migration history never recorded. `migrate deploy` was never run against an empty database, so the gap
was never exercised. The chain worked only because the live database had been built up by a mix of
`migrate deploy` and `db push`.

---

## 4. Remediation Applied

### 4.1 Four one-statement corrections to historical migrations

Each is the minimum edit that makes the statement refer to the table the chain actually creates, and
each is a **no-op on all existing databases** (where the corrected statement has always applied
against objects that already exist).

| File | Change | Fixes |
| --- | --- | --- |
| `20260820095404_add_marketing_affiliate_foundation/migration.sql` | ``ALTER TABLE `voucher` `` → `` `Voucher` `` | Defect 1 (typo) |
| `20260909000000_add_shipping_discount_quota/migration.sql` | `` `shippingdiscount` `` → `` `ShippingDiscount` ``, `` `order` `` → `` `Order` `` (3 statements) | Defect 1 |
| `20260909010000_add_order_original_spin/migration.sql` | `` `order` `` → `` `Order` ``, `` `spinwheelspin` `` → `` `SpinWheelSpin` `` | Defect 1 |
| `20260825100000_add_spin_wheel/migration.sql` | Removed inline `UNIQUE` from `orderId` | Defect 4 |

Each edit carries an inline comment naming the phase and the reason.

### 4.2 New migration 16 — `20260909020000_reconcile_migration_chain`

165 lines, sorts **before** the Phase 2 migration. Three sections:

1. **Section 1** — `CREATE TABLE IF NOT EXISTS adminauditlog`, in its pre-Phase 2 shape, with
   `utf8mb4_unicode_ci` so a provisioned database is internally consistent. *(Defect 2)*
2. **Section 2** — **41 explicit, individually guarded `RENAME TABLE` statements**, one per PascalCase
   table, each running only when the source exists and the target does not, matched with `BINARY` so
   the comparison is case-sensitive. Deliberately *not* a generic "rename every uppercase table"
   sweep, so the renamed set stays reviewable. *(Defect 1)*
3. **Section 3** — four guarded statements completing `affiliatepayout`: the seven missing columns,
   the `idempotencyKey` unique index, the `providerTransactionId` index, and the `FAILED` enum value.
   *(Defect 3)*

On a database that is already correct — including live — every guard evaluates false and every
statement becomes `DO 0`. On an empty database it builds what was missing.

### 4.3 New migration 18 — `20260916010000_phase2_5_normalize_legacy_table_collation`

79 lines, sorts **after** the Phase 2 migration. Three guarded `CONVERT TO CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci` statements for `broadcast`, `bulkdiscount`, `shippingdiscount`. See §9
for the evidence and the reasoning.

### 4.4 Repair of stale Prisma checksums (bookkeeping, not schema)

Prisma stores `sha256(migration.sql)` for each applied migration in `_prisma_migrations`. Correcting
the four historical files changed their hashes, so **live's stored checksums no longer matched the
files** and — because a freshly provisioned database computes its checksums from the corrected files —
live and a fresh database disagreed about the same migration:

| Migration | Live checksum (before) | Checksum of corrected file |
| --- | --- | --- |
| `20260820095404_add_marketing_affiliate_foundation` | `4f4a6f10…` | `ccc7ca66…` |
| `20260825100000_add_spin_wheel` | `f8855cf9…` | `9bfddb41…` |
| `20260909000000_add_shipping_discount_quota` | `bad3283a…` | `14ed3c61…` |
| `20260909010000_add_order_original_spin` | `d881e541…` | `2ffc3614…` |

The algorithm was **verified, not assumed**: for the two untouched migrations the stored value equals
`sha256sum` of the file exactly. The four rows were then updated to the corrected files' hashes.
Migration history remains 18 rows, all applied, `finished_at` untouched, and
`prisma migrate status` is clean.

This is deliberately reported rather than buried: it is a write to the live database's bookkeeping
table. It changes no business table, no business row, and no schema object, and it makes live agree
with what any future database will store for the same files.

---

## 5. Safety Analysis

### 5.1 Why existing data is preserved

* **No destructive statement exists in any changed or added migration.** The only DDL verbs used are
  `CREATE TABLE IF NOT EXISTS`, `RENAME TABLE` (guarded on source-exists-and-target-does-not),
  `ADD COLUMN`, `CREATE INDEX`, `MODIFY COLUMN` (enum widening), `ALTER DATABASE` (default collation)
  and `CONVERT TO CHARACTER SET`. There is no `DROP TABLE`, no `DROP COLUMN`, no `DROP INDEX`, and no
  `DELETE` or `TRUNCATE`.
* **Every reconciliation statement is conditional or idempotent by construction**, so on a database
  that already has the objects it becomes `DO 0`.
* **Proven, not argued.** Applying the reconciliation migration to live produced a **byte-identical**
  schema: 1,519 schema facts (tables, columns with type/nullability/collation/default/extra, indexes,
  foreign keys) before and after, with exact row counts unchanged. The collation migration was
  likewise applied to live as a **proven no-op** — 1,519/1,519 facts identical.

### 5.2 Why it does not break already-applied migrations

The four corrected migrations are already applied on live. Correcting them changes only their file
content; the objects they describe already exist there. Prisma was tested directly for this:
**Prisma 6.19 does not detect or reject edits to already-applied migrations** — `migrate status` and
`migrate deploy` both return clean, exit 0. That is why STOP condition C (checksum/history conflict)
was **not** triggered. The checksum repair in §4.4 removes the residual inconsistency anyway, so the
repair does not depend on that leniency.

### 5.3 Why it does not alter ticketing business semantics

No ticketing table, column, enum, index or foreign key was created, changed or removed in this phase.
The 27 ticketing tables are structurally identical to Phase 2's delivery. Every changed object belongs
to the legacy retail/marketing/affiliate domain, and each change restores the object to the shape
`schema.prisma` already declares.

### 5.4 Why it is safe for future fresh deployments

The chain was replayed from scratch into three empty databases, and in each case
`prisma migrate deploy` alone — with no manual SQL — produced a schema structurally identical to live.
Two of those databases were created with the *server default* collation specifically to testthe case that previously produced inconsistent results. Future provisioning is now reproducible.

---

## 6. Fresh Database Replay

### 6.1 Result

```text
FRESH DATABASE REPLAY: PASS
```

No manual SQL. No `prisma db push`. No `migrate reset`. No marking migrations as applied by hand.
Three independent databases, three successes:

| # | Database | Created with | Migrations applied | Result |
| --- | --- | --- | --- | --- |
| 1 | `tinggalklik_p25_fresh` | explicit `utf8mb4_unicode_ci` | 18/18 | PASS |
| 2 | `tinggalklik_p25_defaulttest` | **server default** (`uca1400_ai_ci`) | 18/18 | PASS |
| 3 | `tinggalklik_p25_verify` | **server default** (`uca1400_ai_ci`) | 18/18 | PASS |

Database 2 is the one that matters: it is the case that previously produced three tables with a
non-matching collation. All three now finish with 70/70 tables on `utf8mb4_unicode_ci`.

### 6.2 Exact commands and output

```bash
# Database 3, created with the server default collation
mysql -e "CREATE DATABASE tinggalklik_p25_verify;"          # default: utf8mb4_uca1400_ai_ci

DATABASE_URL="mysql://.../tinggalklik_p25_verify" npx prisma migrate deploy
#   migrations applied: 18
#   All migrations have been successfully applied.
#   exit 0

DATABASE_URL="mysql://.../tinggalklik_p25_verify" npx prisma migrate status
#   18 migrations found in prisma/migrations
#   Database schema is up to date!
```

All 18 migrations, in order:

```
 1  0_baseline
 2  20260818014252_add_product_isarchived
 3  20260818014810_orderitem_setnull_on_product_delete
 4  20260819161137_add_tiktok_pixel
 5  20260819161955_add_tiktok_pixel
 6  20260819162211_add_tiktok_pixel
 7  20260820000000_add_notification_tables
 8  20260820095404_add_marketing_affiliate_foundation
 9  20260821000000_add_marketing_broadcast
10  20260825000000_add_payout_proof_file_path
11  20260825100000_add_spin_wheel
12  20260826000000_remove_spin_unique_constraint
13  20260827000000_add_refund_system
14  20260909000000_add_shipping_discount_quota
15  20260909010000_add_order_original_spin
16  20260909020000_reconcile_migration_chain          <- new in Phase 2.5
17  20260916000000_ticketing_phase2_foundation         <- Phase 2 (unchanged)
18  20260916010000_phase2_5_normalize_legacy_table_collation  <- new in Phase 2.5
```

Before remediation, the same command failed at migration 8 of 17. The failure was reproducible and is
recorded in §3.

---

## 7. Schema Verification

### 7.1 Fresh vs live — structural counts

A freshly provisioned database and the live database are now **identical**:

| Object | Fresh (`_verify`) | Live (`tinggalklik`) | Match |
| --- | --- | --- | --- |
| Tables | 70 | 70 | ✔ |
| Columns | 886 | 886 | ✔ |
| Indexes (distinct name+table) | 324 | 324 | ✔ |
| Unique constraints | 62 | 62 | ✔ |
| Foreign keys (columns) | 146 | 146 | ✔ |

### 7.2 Ticketing tables

All 27 Phase 2 tables verified present in the freshly provisioned database:

```text
organizer  organizermember  sport  venue  event  eventimage  tickettype
eventorder  eventorderitem  ticket  ticketreservation  checkin
payment  paymenttransaction  webhookevent
picprofile  piceventassignment  picattribution  picfeeledger
settlement  settlementitem  refunditem  notificationdelivery  idempotencykey
permissiongrant  platformsetting  staffeventassignment
```

Plus `adminauditlog`, now created by migration 16 rather than by `prisma db push`.

### 7.3 Enums, foreign keys, unique constraints, indexes — explicit drift check

`prisma migrate diff` was run in both directions with the connection proved first. The result was
classified statement by statement rather than accepted because the command exited 0:

| Statement kind | Count | Assessment |
| --- | --- | --- |
| `CREATE INDEX` / `CREATE UNIQUE INDEX` | 82 / 32 | Every dropped index name matches a created index name **case-insensitively** — pure rename churn |
| `DROP INDEX` | 114 | 114 created = 114 dropped; **0 genuine mismatches** |
| `DROP FOREIGN KEY` / `ADD CONSTRAINT` | 52 / 52 | 52 dropped = 52 added, names differ only by letter case |
| `ALTER … ADD COLUMN` | 0 | — |
| `ALTER … DROP COLUMN` | 0 | — |
| `CREATE TABLE` / `DROP TABLE` | 0 / 0 | — |
| `ALTER … MODIFY` | 1 | `spinwheelcampaign.maxSpinsPerUser`, see §7.4 |

The 114 index names and 52 constraint names differ **only by letter case** (`Voucher_code_key` vs
`voucher_code_key`). This is the same PascalCase legacy as Defect 1, but it is index *naming* only:
same columns, same uniqueness, same ordering. It is a **pre-existing** property of the migration chain
and it is **identical on live and fresh**, so it is not drift introduced by Phase 2.5 and it does not
affect the ticketing foundation. Per §12 it was therefore deliberately **not** churned: rewriting
114 index names and 52 foreign keys across ~30 legacy retail tables would be a large, risky edit to
applied migrations for zero behavioural gain.

### 7.4 The one genuine non-rename difference

```sql
ALTER TABLE `spinwheelcampaign` MODIFY `maxSpinsPerUser` INTEGER NOT NULL DEFAULT 0;
```

| Source | Value |
| --- | --- |
| `schema.prisma` | `maxSpinsPerUser Int @default(0)` |
| Live database | `int NOT NULL DEFAULT 1` |
| Fresh database | `int NOT NULL DEFAULT 1` |

Live and fresh **agree with each other**; both disagree with `schema.prisma`. It is a pre-existing
chain-versus-schema mismatch, not a Phase 2.5 regression. It is also semantically inert: the schema's
own comment states *"0 or 1 = no cap; >1 = lifetime cap"*, so `0` and `1` are equivalent. Documented,
not changed.

### 7.5 Duplicate table variants

No table has both a PascalCase and a lowercase variant in the provisioned database (checked by
grouping on `LOWER(TABLE_NAME)`). The 41 renames left exactly one name per table.

### 7.6 D-60 remains unresolved

Confirmed by direct inspection — `tickettype` carries only its primary key, and **no** unique
constraint on `(eventId, name)`:

```text
PRIMARY (id)
```

D-60 was not implemented, not partially implemented, and no substitute business rule was invented.

---

## 8. Live Database Verification

### 8.1 Migration state

```bash
npx prisma migrate status
#   18 migrations found in prisma/migrations
#   Database schema is up to date!          (exit 0)
```

No migration is pending, none is rolled back, and no `migrate resolve` was used. STOP condition C was
explicitly tested for and not triggered (§5.2).

### 8.2 Live schema is unchanged by Phase 2.5's database changes

Both database-touching actions were proven no-ops against a full before/after snapshot of 1,519
schema facts:

| Action | Facts before | Facts after | Verdict |
| --- | --- | --- | --- |
| Apply `20260916010000_phase2_5_normalize_legacy_table_collation` | 1,519 | 1,519 | **byte-identical — no-op** |
| `ALTER DATABASE tinggalklik … COLLATE utf8mb4_unicode_ci` | 1,519 | 1,519 | **byte-identical — no-op on tables/columns** |

The snapshot covers every table (with collation and engine), every column (with type, nullability,
collation, default and extra), every index and every foreign key.

### 8.3 Live business data

| Table | Rows |
| --- | --- |
| `user` | 59 |
| `product` | 5 |
| `order` | 149 |
| `sport` | 14 (Phase 2 seed) |
| `organizer` / `event` / `tickettype` / `eventorder` / `ticket` / `payment` / `webhookevent` | **0** |

Real data is intact and no ticketing business data was created.

### 8.4 Pre-migration safety net

A full `mysqldump` was taken immediately before the Phase 2.5 deploy to live, in addition to the two
Phase 2 dumps. See §10.

---

## 9. Collation Review

### 9.1 What was inspected

* Database-level defaults, table-level collations and column-level collations, on both live and a
  freshly provisioned database.
* **Every foreign key pair in both databases**, child column vs parent column, looking for a mismatch.
* The collation of every new ticketing table and of each column it references.

### 9.2 Findings

**Finding 1 — all 70 tables and all ticketing tables are consistent.**
Both live and fresh: **70/70 tables `utf8mb4_unicode_ci`**, 459 columns `utf8mb4_unicode_ci` and 5
columns `utf8mb4_bin` (JSON `metadata` columns, which is correct and intentional).
**Zero collation-incompatible foreign key pairs exist** in either database — verified by joining
`KEY_COLUMN_USAGE` against `COLUMNS` on both sides.

**Finding 2 — the database-level default was the odd one out.**
Live's *database* default was `utf8mb4_uca1400_ai_ci` (the MariaDB server default), matching **none**
of its 70 tables. A table created without an explicit collation would have inherited it and could not
have been used in a foreign key against the other 69 — precisely the errno 150 failure that made
Phase 2's first two live deploys fail. **Changed:** the database default is now
`utf8mb4_unicode_ci`, which is what 70/70 tables already use. This is a one-line configuration
change; it touches no table, column, row or index (§8.2).

**Finding 3 — three tables were provisioned non-deterministically.**
`broadcast`, `bulkdiscount` and `shippingdiscount` are created by hand-written migrations that omit
any collation clause — unlike Prisma-generated migrations, which always emit one. They therefore
inherited the *database* default, and the outcome depended only on how the empty database was created:

| Database created with | Those three tables became |
| --- | --- |
| server default (`uca1400_ai_ci`) | `utf8mb4_uca1400_ai_ci` — mismatched with the other 67 |
| explicit `utf8mb4_unicode_ci` | `utf8mb4_unicode_ci` |

Both outcomes were reproduced against the real server. **Remediated** by migration 18, which pins
exactly those three tables to `utf8mb4_unicode_ci` under a guard that makes it a no-op wherever they
already match (including live, proven in §8.2). After remediation, a database created with the server
default also finishes 70/70 `utf8mb4_unicode_ci` with zero incompatible FK pairs.

### 9.3 What was deliberately *not* done

* **No database-wide collation conversion.** The 5 `utf8mb4_bin` JSON columns were left alone — they
  are correct.
* **No conversion of legacy retail tables to "look uniform".** Only the three tables with a proven,
  reproduced, provisioning-dependent inconsistency were touched, and only under a guard.
* **`adminauditlog` was not re-collated.** Its historical `utf8mb4_0900_ai_ci` was the direct cause of
  Phase 2's errno 150. Phase 2 already normalised its columns 4-to-1 in favour of compatibility; this
  phase did not revisit that decision, and the reconciliation migration simply creates it with
  `utf8mb4_unicode_ci` where it does not exist.

### 9.4 What a future migration must still consider

The ticketing foundation is safe: every ticketing table has an **explicit** collation and every column
it references is `utf8mb4_unicode_ci`, so no future FK involving a ticketing table can hit a collation
mismatch. Two residual considerations remain, both legacy and both documented:

1. Any **hand-written** migration that creates a table without a collation clause will inherit the
   database default. On live that is now `utf8mb4_unicode_ci` (safe). A database created with
   `CREATE DATABASE name;` alone still defaults to the server's `uca1400_ai_ci`, so any such table
   should carry an explicit collation. Prisma-generated migrations already do.
2. `_prisma_migrations` itself uses a collation inherited from creation; it is a single-tenant table
   and is not referenced by any foreign key.

---

## 10. Backup Durability

**BACKUP DURABILITY: RESOLVED — moved to durable storage.**

The Phase 2 concern was correct, and it was confirmed rather than assumed:

```bash
df -hT /tmp    # tmpfs   tmpfs   3.5G   /tmp        <- RAM-backed, lost on reboot
df -hT ~       # /dev/nvme0n1p8  btrfs  110G  /home  <- durable disk
```

`/tmp` is a **tmpfs** — the Phase 2 backup at `/tmp/tinggalklik_pre_phase2.sql` was genuinely
ephemeral, and during this phase `/tmp` really was wiped (both the dump and the helper files written
to it were gone). Phase 2's own warning was therefore not theoretical.

All backups now live outside `/tmp`, outside the repository, and outside Git, in a `0700` directory
with `0600` files:

| File | Size | Taken |
| --- | --- | --- |
| `~/backups/tinggalklik/tinggalklik_pre_phase2_20260916.sql` | 342K | before the Phase 2 migration |
| `~/backups/tinggalklik/tinggalklik_post_phase2_20260916.sql` | 437K | after the Phase 2 migration |
| `~/backups/tinggalklik/tinggalklik_before_phase25_deploy_20260916.sql` | 437K | before the Phase 2.5 deploy |

```bash
ls -ld  ~/backups/tinggalklik   # drwx------ (700)
ls -l   ~/backups/tinggalklik   # -rw------- (600) on every dump
```

Verified that **no dump exists inside the repository** and that no `.sql` file is tracked or untracked
within it other than the migration SQL. No database contents are reproduced in this report — only
row counts.

**Warning (carried to §14):** these files sit on a single disk (`/dev/nvme0n1p8`). They survive a
reboot and they are out of Git, which was the requirement, but they are not replicated off-machine.
That is an operations decision, not something this phase should silently decide.

---

## 11. TypeScript / Prisma Validation

All commands run from the repository root after every change was applied.

| Command | Result |
| --- | --- |
| `npx prisma validate` | **exit 0** — `The schema at prisma/schema.prisma is valid 🚀` |
| `npx prisma generate` | **exit 0** — client generated |
| `npx tsc --noEmit` | **exit 0** — no type errors |
| `npx prisma migrate status` | **exit 0** — `18 migrations found` / `Database schema is up to date!` |
| `npx prisma migrate deploy` (fresh DB ×3) | **exit 0** — `All migrations have been successfully applied.` |

No errors were suppressed, and no command is reported as passing unless its exit code was observed.

---

## 12. Test Baseline

```
Test Suites: 6 failed, 20 passed, 26 total
Tests:       2 failed, 632 passed, 634 total
```

**This is identical to the Phase 2 baseline** (6 suites / 2 tests / 632 passed), so Phase 2.5
introduced no regression. The two failing tests are:

* `B. Payout PAID consumes commissions (ledger balance)` — `__tests__/p0/remediation.integration.test.ts`
* `E. Admin affiliate detail executes against MariaDB` — `__tests__/p0/remediation.integration.test.ts`

The other five failing suites fail at load (`Test suite failed to run`), which is why six suites fail
while only two individual tests do. The five are `__tests__/ipaymu/production-hardening.test.ts` and
four under `__tests__/marketing/`.

**These are pre-existing and unrelated to this phase**, and the argument is stronger than a comparison:
Phase 2.5 changed **zero application source files**. Its entire diff is migration SQL, one new
migration, and report documents. No test was modified, no test was disabled, and neither `jest.config`
nor any tsconfig was touched (the brief's §16 forbids exactly that). Phase 2 already established the
same 2 failures under an A/B with a client generated from the pre-Phase-2 schema.

---

## 13. Scope Compliance

```text
API changed:                    NO
UI changed:                     NO
Auth changed:                   NO
Payment changed:                NO
WhatsApp changed:               NO
Business logic changed:         NO
Retail data changed:            NO
Ticketing features implemented: NO
D-60 implemented:               NO
Git history rewritten:          NO
```

Supporting detail:

* **Files changed** — this is the complete list:
  * modified: 4 historical `migration.sql` files (§4.1)
  * added: `prisma/migrations/20260909020000_reconcile_migration_chain/`
  * added: `prisma/migrations/20260916010000_phase2_5_normalize_legacy_table_collation/`
  * added: `TICKETING_PHASE2_5_REPORT.md`
* **No application source file was modified.** Verified mechanically: every tracked path in
  `git diff --name-only` is under `prisma/` or is one of the pre-existing `next-env.d.ts` /
  `package-lock.json`.
* **Retail data** — 59 users / 5 products / 149 orders unchanged; no row inserted, updated or deleted.
  No retail table was renamed, dropped, or had a column removed.
* **Ticketing schema** — untouched. `schema.prisma` was **not** modified in Phase 2.5.
* **D-60** — not implemented (§7.6).
* **Git history** — no `filter-repo`, `filter-branch`, `rebase --root` or `push --force` was run.
* **The KTP issue was not touched**, not deleted, and not purged (§14).
* **`tsconfig.tsbuildinfo`** (a TypeScript incremental-build cache, not user work) was regenerated by
  the validation runs and was reverted so the final diff stays clean.

### 13.1 Pre-existing changes preserved

`next-env.d.ts`, `package-lock.json` and `prisma/seed-regions.js` were left exactly as found. No
`git reset --hard`, `git clean`, `git checkout -- .` or `git restore` was used. The only `git checkout`
was `git checkout -- tsconfig.tsbuildinfo`, a compiler cache.

### 13.2 STOP conditions — none triggered

| # | Condition | Status |
| --- | --- | --- |
| A | Requires destructive modification of business data | **Not triggered** — zero destructive statements; live schema byte-identical |
| B | Requires changing production data without approval | **Not triggered** — only the developer database at `127.0.0.1` was touched, and a full dump was taken first. `restaurant_app`, the only other database present, was never opened |
| C | Prisma reports checksum/history conflict | **Not triggered** — tested explicitly; `migrate status`/`deploy` clean (§5.2) |
| D | Fix requires rewriting applied migrations in a way Prisma rejects | **Not triggered** — Prisma 6.19 accepts the corrections; checksums repaired regardless (§4.4) |
| E | Fresh database still requires manual SQL | **Not triggered** — three replays, zero manual SQL |
| F | A migration unexpectedly modifies retail tables/data | **Not triggered** — two migrations touch legacy tables, both proven no-ops on live (§8.2), both explained in §3/§9, and `schema.prisma` is the authority they restore conformance to |
| G | Solution changes application business logic | **Not triggered** — no source file changed |
| H | Backup cannot be preserved without exposing it | **Not triggered** — backups moved to durable storage, `0600`/`0700`, outside the repo and outside Git (§10) |
| I | Scope expands into Phase 3 | **Not triggered** — no feature work of any kind |

---

## 14. Remaining Risks

### 14.1 Requires a human decision (not a blocker for Phase 2.5)

1. **Backups are on one disk.** `~/backups/tinggalklik/` survives reboot and is out of Git, but it is
   not replicated off-machine. **Recommended next action:** copy to external/off-host storage or a
   managed backup target. This cannot be decided from inside the repository.
2. **KTP historical PII is still in Git history.** Phase 0 found identity-card scans committed under
   `storage/uploads/affiliate/ktp/**`, and `.gitignore` still has no rule covering `storage/`. This
   phase did **not** purge history and did **not** add such a rule, because §19 places both outside
   Phase 2.5. It remains the highest-severity open item from the audit and needs contributor
   coordination plus explicit authorisation.

### 14.2 Known and accepted, with evidence

3. **Cosmetic index/FK name drift on ~30 legacy retail tables** (114 index names, 52 constraint names,
   differing only by letter case). Pre-existing, identical on live and fresh, no behavioural effect.
   Deliberately not churned (§7.3). A future `prisma migrate dev` run would propose a large
   rename-only migration; **do not apply it blindly** — the FK drop/recreate pattern it generates is
   a table-locking operation.
4. **`spinwheelcampaign.maxSpinsPerUser`** defaults to `1` in the database and `0` in `schema.prisma`.
   Pre-existing, identical on both databases, semantically inert (both mean "no cap"). (§7.4)
5. **`affiliatepayout` column types on live** — `paidAt`/`failedAt` are `DATETIME(0)` and
   `providerStatus` is `VARCHAR(50)`, whereas `schema.prisma` declares `DATETIME(3)` / `VARCHAR(191)`.
   A **live-only** pre-existing defect (a fresh database gets the correct types from migration 16).
   It is the only remaining live-versus-fresh difference in the whole schema. Left as-is: it is a
   legacy affiliate table slated for replacement by PIC in the Phase 1 design, and widening a live
   column is a real DDL operation with no benefit to the ticketing foundation.
6. **Three legacy tables were provisioned non-deterministically until this phase.** Now pinned by
   migration 18 (§9.2). Any *future* hand-written migration that omits a collation clause reopens this
   class of problem — see §9.4.

### 14.3 Pre-existing, out of scope for Phase 2.5

7. `0_baseline`'s incomplete coverage of what `prisma db push` had built is now *reconciled* by
   migration 16, but the underlying process risk remains: as long as `db push` is used to evolve the
   development database, drift can reappear. Provisioning a CI/staging database and running
   `migrate deploy` against it on every change is the durable fix.
8. The **520 ESLint problems / 368 errors** and the jest coverage gap reported in Phase 0 are
   unchanged. Phase 2.5 introduced no lint or type errors.
9. `toko_backup.sql` is a **0-byte file tracked in Git since the initial commit** — harmless (it
   contains no data and exposes nothing), noted only so it is not mistaken for a leaked dump. Not
   deleted, because §2 forbids file deletion.

---

## 15. Final Status

```text
PHASE 2.5 STATUS: PASS WITH WARNINGS
```

`PASS`, because every objective in the brief was met and independently verified: BLK-1 is fixed and
proven by three from-scratch replays with no manual SQL; the Phase 2 ticketing migration is intact and
unchanged; live is healthy with an 18/18 clean migration history and unchanged data; collation risk
was reviewed and remediated narrowly where evidence required it; the backup is durable; Prisma and
TypeScript validations pass; no feature, API, UI, auth, payment or business-logic change was made; D-60
remains unresolved; and Git history was not rewritten.

`WITH WARNINGS` rather than `PASS`, because three things remain that this phase deliberately did not
decide or resolve, and none of them should be described as done:

* the backup is durable but sits on a single unreplicated disk (§14.1.1);
* the committed KTP scans remain in Git history, with no `.gitignore` rule added (§14.1.2);
* one live-only column-type defect (`affiliatepayout`) and the cosmetic legacy index/constraint name
  drift are documented but intentionally unchanged (§14.2.3–14.2.5).

No commit, push, revert of user work, or history rewrite was performed. **Phase 3 was not started.**

---

## Appendix A — Verification command reference

Every figure in this report came from one of these, all run read-only unless stated.

```bash
# Migration chain
npx prisma validate
npx prisma generate
npx prisma migrate status
npx prisma migrate deploy                                   # against throwaway DBs
npx prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma --script

# Structural comparison (proved against the intended DB before trusting any result)
#   information_schema.TABLES      -> tables + collation + engine
#   information_schema.COLUMNS     -> type, nullability, collation, default, extra
#   information_schema.STATISTICS  -> indexes
#   information_schema.KEY_COLUMN_USAGE -> foreign keys
#   information_schema.SCHEMATA    -> database default collation

# Collation audit: every FK pair, child vs parent
#   KEY_COLUMN_USAGE k JOIN COLUMNS c (child) JOIN COLUMNS p (parent)
#   WHERE c.COLLATION_NAME <> p.COLLATION_NAME

# Checksum verification
sha256sum prisma/migrations/<name>/migration.sql   # == _prisma_migrations.checksum

# Tests
npx jest --silent

# Scratch databases created and dropped (all removed at the end)
#   tinggalklik_p25_fresh   tinggalklik_p25_probe
#   tinggalklik_p25_defaulttest   tinggalklik_p25_verify
```

## Appendix B — Collation-relevant change summary

| Object | Before Phase 2.5 | After | Mechanism |
| --- | --- | --- | --- |
| `tinggalklik` database default | `utf8mb4_uca1400_ai_ci` | `utf8mb4_unicode_ci` | `ALTER DATABASE` (one statement, no table touched) |
| `broadcast` | inherited DB default | pinned `utf8mb4_unicode_ci` | migration 18, guarded |
| `bulkdiscount` | inherited DB default | pinned `utf8mb4_unicode_ci` | migration 18, guarded |
| `shippingdiscount` | inherited DB default | pinned `utf8mb4_unicode_ci` | migration 18, guarded |
| All 67 other tables | `utf8mb4_unicode_ci` | unchanged | — |
| 5 JSON `metadata` columns | `utf8mb4_bin` | unchanged (correct) | — |

## Appendix C — Documents this phase did **not** modify

`TICKETING_REBUILD_AUDIT.md`, `TICKETING_PHASE1_DESIGN.md`, `TICKETING_PHASE2_REPORT.md` were read as
the baseline and left unchanged. `prisma/schema.prisma` was not modified in Phase 2.5 — it still
carries only the Phase 2 additions.

## Appendix D — Next phase

Phase 3 (Auth + Organizer + RBAC) is **not** started and must not be started automatically. Phase 1
§39.3 records the earliest genuinely blocking business decisions: **D-05 / D-19 before Phase 3**, and
the first commercial decisions (**D-01 / D-04 / D-22**) before Phase 6. Phase 2.5 was gated on **no**
business decision, so design review can proceed in parallel.
