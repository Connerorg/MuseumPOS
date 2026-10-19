# Museum Ticketing & Sales Management System

Museum point-of-sale application for admission tickets, merchandise sales, barcode admission, employee controls, inventory, cash sessions, reconciliation and reporting.

## Current implementation status

The application is still under development and must not be used to take real customer payments yet. The home screen remains a demo interface and is not yet wired to the new server APIs. Supabase migrations and the full workflow have not been executed and verified end-to-end. A push to `main` can trigger the connected Vercel production build, but a successful build alone does not mean the POS is operational or production-safe.

## Stack

- Next.js App Router, React, TypeScript
- Supabase Auth and PostgreSQL
- Vercel deployment from GitHub `main`
- IndexedDB demo queue in the current UI; reliable offline synchronization is not yet implemented

## Implemented server-side foundation

- Authenticated server routes for cash checkout, employee PIN verification and manager PIN setup, cash-session open/close, and ticket redemption.
- Database transaction for online cash checkout: validates active employee/device/session, resolves prices from database catalogue, creates sale and payment records, issues unique tickets, records inventory movements, updates tracked stock, records cash movements and writes an audit entry.
- Idempotency key support for checkout retries.
- PIN hashes stored using PostgreSQL pgcrypto, with failed-attempt lockout and a short-lived server-side PIN unlock.
- Ticket redemption locks the ticket row and allows a valid ticket to be redeemed only once.
- Card checkout is intentionally rejected. A terminal integration and independent payment confirmation are required before card checkout can be enabled.
- Tax treatment is marked unconfigured; tax and receipt rules must be confirmed by management/accounting before real sales.

These features depend on applying the Supabase migrations and configuring server environment variables. They have not yet been verified against a running database.

## Local setup

1. Use Node.js 22 or 24 and npm.
2. Copy `.env.example` to `.env.local`.
3. Configure a dedicated development Supabase project URL and anon key. Set the service-role key only in server-side environment variables; never expose it to browser code.
4. Apply the migrations to a disposable local/development Supabase database in timestamp order.
5. Provision employee Auth users and matching `employee_profiles` rows. A manager/administrator must set employee PINs through the server endpoint.
6. Register an active POS device in `pos_devices` before opening a cash session.
7. Run `npm install`, `npm run lint`, `npx tsc --noEmit`, and `npm run build`.
8. Open `http://localhost:3000`.

## API routes added

All routes require a valid Supabase Auth session. Operational routes also require a recent successful PIN unlock. They require the migrations and server environment variables to be present.

- `POST /api/employee/pin` — verify the signed-in employee PIN and unlock for 15 minutes.
- `POST /api/employee/pin/set` — manager/administrator sets or resets an active employee PIN.
- `POST /api/cash-sessions` — `action: "open"` with device ID and opening float cents, or `action: "close"` with session ID and counted cash cents.
- `POST /api/checkout/cash` — online cash checkout only.
- `POST /api/tickets/redeem` — redeem a ticket barcode or ticket code once.

These APIs are not yet connected to the demo UI. The API surface does not replace acceptance, concurrency, authorization, migration, and recovery testing.

## Remaining work before production

- Wire the UI to real employee sign-in/PIN unlock, catalogue, checkout, receipt and admission scanning.
- Complete and test inventory management, refund approvals, cash-up/reconciliation, reporting and audit review workflows.
- Implement idempotent offline cash synchronization and conflict handling; the current IndexedDB queue is a demo and does not sync.
- Choose and integrate the card terminal only after independent terminal confirmation can be enforced.
- Confirm tax and receipt requirements with management/accounting.
- Run database migrations and tests against a clean development database; run lint, TypeScript and production build; test concurrency, security, and error recovery.
- Configure the actual Vercel environment variables and verify the resulting deployment logs and runtime behavior.

Do not treat a green Vercel build as proof of a functioning POS. Do not apply unverified migrations to a live database or accept real payments until the end-to-end checks pass.
