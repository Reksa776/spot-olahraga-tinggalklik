/**
 * The ticketing namespace's import path for the product lockup.
 *
 * The implementation moved to `components/Brand.tsx` in Phase 10, when the auth, admin and
 * back-office chrome started rendering the same mark — the lockup is a product-level component,
 * not a ticketing one, and leaving it here would have had the auth layer importing from a
 * feature namespace. This file stays as a re-export so the Phase 9 imports (`SiteHeader`,
 * `SiteFooter`, and the Phase 9 suite that reads this exact path) keep working unchanged.
 *
 * ONE implementation, two import paths.
 */
export { default } from "@/components/Brand";
