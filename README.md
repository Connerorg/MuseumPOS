# Museum Ticketing & Sales Management System

Local-first point-of-sale foundation for museum admission, merchandise, cash management, ticket issuance and reconciliation.

## Status

Early development preview. Not production-ready, not deployed, and not connected to a live database or payment terminal. Tax and receipt treatment require management/accounting confirmation. Card terminal integration remains undecided.

## Stack

- Next.js App Router, React, TypeScript
- Supabase Auth and PostgreSQL
- PWA/offline queue planned with IndexedDB
- Vercel project `museumpos` (deployment not started)

## Security decisions

- Individual Supabase Auth identity plus a separate POS PIN unlock.
- Offline sales are cash-only. Card payments require independently confirmed terminal results.
- Never expose Supabase service-role credentials to browser code.
- Financial records must be created through trusted server-side operations.
- Tax and receipt rules must be confirmed before real checkout.

## Local setup

1. Install Node.js 22 or 24 and npm.
2. Copy `.env.example` to `.env.local` and fill in a dedicated **development** Supabase project URL and anon key. Do not use production credentials.
3. Run `npm install`.
4. Run `npm run dev`.
5. Open `http://localhost:3000`.

The UI uses a demo catalogue and browser-local IndexedDB queue. A queued item is **not** a real sale and does not issue a valid ticket. The Supabase migration is an initial draft; inspect and test locally before applying to any database.

## Planned milestones

1. Validate migrations and RLS locally.
2. Implement Auth-backed employee profiles, secure PIN verification, lockouts and server-side authorization.
3. Implement atomic checkout, ticket issuance, inventory movements and idempotent offline synchronization.
4. Add cash sessions/cash-up, reporting and supervisor workflows.
5. Confirm tax/receipt rules and choose a card terminal integration.
6. Run security, concurrency, offline recovery and acceptance tests.

Never run production migrations or deploy without explicit approval.
