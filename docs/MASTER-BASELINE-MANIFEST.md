# MASTER BASELINE MANIFEST

Captured before any four-feature edit. Read-only record — not a staging instruction.

```
repository  /home/reksa/tinggalklik
branch      main
HEAD        9b8fecd99bcc74677c1805c18379241af04fddd1
staged      0
```

## Working-tree paths at baseline

`.cloud-attachments/` is excluded from this manifest by policy (not read, not hashed, not
staged). Every other path reported by `git status --porcelain` is listed verbatim.

```
 M __tests__/ticketing-checkin/check-in-wiring.test.ts
 M lib/ticketing/checkin/service.ts
?? PROJECT_PRE_FEATURE_AUDIT_REPORT.md
?? __tests__/ticketing-checkin/check-in-transaction.test.ts
?? __tests__/ticketing-checkin/pic-scan-api.test.ts
?? __tests__/ticketing-checkin/pic-scan-authz.test.ts
?? __tests__/ticketing-checkin/qr-payload-validation.test.ts
?? app/api/pic/events/
?? docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md
?? docs/PHASE_3A4_FINAL_COMMIT_READINESS_REPORT.md
?? docs/PHASE_3A5.1_FINAL_PRE_COMMIT_VERIFICATION_REPORT.md
?? docs/PHASE_3A5_CONTROLLED_STAGING_REPORT.md
?? docs/PHASE_3A6_CONTROLLED_COMMIT_REPORT.md
?? docs/PHASE_3B_QR_VALIDATION_DESIGN.md
?? docs/PHASE_3B_QR_VALIDATION_EXECUTION_REPORT.md
?? docs/PHASE_3C_CHECKIN_TRANSACTION_EXECUTION_REPORT.md
?? docs/PHASE_3C_TRANSACTION_DESIGN.md
?? docs/PHASE_3D_API_AUTHORIZATION_AUDIT.md
?? docs/PHASE_3D_API_DESIGN.md
?? docs/PHASE_3D_PIC_SCANNER_API_EXECUTION_REPORT.md
?? docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md
?? lib/ticketing/checkin/method.ts
?? lib/ticketing/checkin/qr-payload.ts
```

## Key artifact digests (sha256)

```
45ce3f549d698eaf8606ae0df4c24f3dcee1df224ec29424b772c5d8ef688ad5  lib/ticketing/checkin/service.ts
07d09594d29a546b7d74fff8b98651c28292ab3b2d65e1b36434b983424cc345  __tests__/ticketing-checkin/check-in-wiring.test.ts
389351ebd50e367666446573af615329d4ab5813142704ed86a378d323bae403  app/api/pic/events/[id]/check-in/route.ts
```

The two modified tracked files are the intentional Phase 3C changes (service guard refactor
and its wiring test). They are preserved, never reset, stashed, checked out or overwritten.
