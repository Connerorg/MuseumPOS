# Museum Ticketing & Sales Management System

Museum point-of-sale application for admissions, merchandise, ticket barcodes, employee controls, inventory, cash sessions, reconciliation, refunds and reporting.

## Important status

The interface and server workflows are being implemented, but this is **not yet approved for real customer transactions**. The Supabase connector available to the developer currently lists the organization but no accessible projects, so migrations have not been applied or tested against the museum's actual database. GitHub CI checks the Next.js code only; it does not execute PostgreSQL migrations or prove end-to-end operation.

## Stack

- Next.js App Router, React, TypeScript
- Supabase Auth and PostgreSQL
- Vercel deployment from GitHub `main`
- IndexedDB local queue and PWA shell caching for offline cash entry

## Current implementation

- Individual Supabase Auth sign-in and employee profile lookup.
- PostgreSQL pgcrypto PIN hashing, failed-attempt lockout, and 15-minute server-side PIN unlock.
- Authenticated bootstrap API that loads active ticket types, products, POS devices, categories and open cash sessions.
- Transactional online cash checkout: server-side price resolution, sale/payment/cash-ledger/audit writes, unique ticket issuance, tracked stock reduction and idempotency key.
- Single-use barcode/ticket-code redemption with row locking.
- Cash session open/close with expected-vs-counted cash variance and server-side session ownership rules.
- Manager/administrator-controlled inventory adjustments with reason, stock validation and audit record.
- Date-filtered financial report API restricted to supervisory roles.
- Full-sale cash refund request, independent manager approval/rejection, and cash refund completion. Completion requires an open cash session, verifies available till cash, updates the sale and ticket status, records cash movement and audit details, and can restock returned tracked items when explicitly confirmed.
- PWA manifest/service worker, IndexedDB offline cash queue, idempotent sync endpoint and cached price-snapshot validation. Conflicts remain queued for manager review.
- Card checkout/refunds are not integrated. The UI explicitly limits checkout to cash.

These workflows depend on applying migrations in timestamp order and configuring Supabase environment variables. They have not been tested against a live or local Postgres instance in this environment.

## Environment setup

1. Use Node.js 22 or 24.
2. Copy `.env.example` to `.env.local`.
3. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the development Supabase project values.
4. Set `SUPABASE_SERVICE_ROLE_KEY` as a server-only secret in local environment and Vercel project settings. Never expose it via `NEXT_PUBLIC_*` or browser code.
5. Apply every SQL file under `supabase/migrations` to a **development/test** Supabase database in timestamp order. Do not apply to production until reviewed and tested.
6. Provision Supabase Auth users with matching active `employee_profiles` rows; ensure at least one manager/administrator can set employee PINs.
7. Register an active POS device in `pos_devices`. Seed/verify authoritative prices and tracked products before testing checkout.
8. Run:
   ```sh
   npm install
   npm run lint
   npx tsc --noEmit
   npm run build
   ```
9. Test all workflows using non-production data before enabling sales.

## API routes

- `GET /api/pos/bootstrap` — authenticated employee profile, active catalogue, devices and open sessions.
- `POST /api/employee/pin` — verify PIN and unlock for 15 minutes.
- `POST /api/employee/pin/set` — manager/administrator sets or resets an employee PIN.
- `POST /api/cash-sessions` — open or close a cash session.
- `POST /api/checkout/cash` — online cash checkout.
- `POST /api/offline/sync` — idempotent offline cash reconciliation with cached-price validation.
- `POST /api/tickets/redeem` — one-time ticket redemption.
- `POST /api/inventory/adjust` — supervisor/manager/admin stock movement.
- `GET /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` — supervisory financial summary.
- `GET /api/refunds`, `POST /api/refunds` — list eligible sales/refunds and request a full-sale cash refund.
- `PATCH /api/refunds/decision` — manager/administrator approval or rejection.
- `POST /api/refunds/complete` — complete an approved cash refund against an open till session.

Operational routes require a valid Supabase Auth session and a recent PIN unlock. The database RPCs are restricted to the service role and rely on the server routes to verify the user session.

## Outstanding production blockers

- Connect the correct Supabase project, apply migrations to a disposable development database, run SQL/security advisors and test all database functions.
- Add migration-level automated tests and end-to-end tests for concurrent checkout, duplicate retries, PIN lockouts, refunds, inventory races, offline conflicts and session reconciliation.
- Confirm tax treatment and legal receipt requirements with management/accounting.
- Select and integrate the card terminal only when payment confirmation can be independently verified.
- Complete audit review, reporting verification, operational recovery procedures, and device-level PWA/offline acceptance tests.
- Verify the current Vercel production deployment and environment variables from the Vercel dashboard.

A green build is not proof of a functioning POS. Do not accept real payments until database migrations, security review, tax/receipt rules and end-to-end tests are complete.
