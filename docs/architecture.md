# Architecture and implementation boundaries

## Confirmed decisions

- Individual Supabase Auth identities; POS PIN is a separate unlock factor.
- Offline queue is cash-only. Card sales require an independently confirmed terminal result.
- Tax and receipt treatment remain unconfigured pending management/accounting approval.
- Card terminal vendor/integration is undecided; isolate it behind a payment adapter.
- No production deployment or remote migrations without explicit approval.

## Trust boundaries

1. Browser components may use only Supabase publishable/anon credentials.
2. Service-role credentials are server-only and must not be sent to the client.
3. Employee role and active status are loaded from protected database records, never trusted from user-editable metadata.
4. Sales, payments, refunds, ticket issuance/redemption and stock movements must be implemented as transactional server-side operations with idempotency.
5. The current UI is a demo: IndexedDB entries are not sales, receipts or admission tickets.

## Offline design

Each local queue item will require a random client transaction UUID, a unique idempotency key, device identity, immutable line-item/price snapshots, and local creation time. The server must revalidate employee/device authorization and current policy on sync, deduplicate retries, reject conflicts, and return a durable server receipt. A local queue item must remain visibly pending until the server acknowledges it. Offline employee sessions need expiry and explicit device revocation behavior.

## Still required before real checkout

- PIN hashing/verification endpoint with rate limiting and lockout, plus audit logging.
- Server authorization and role-specific policies.
- Atomic checkout/payment/ticket/stock procedures and tests.
- Secure cash-session opening, movement, closing and two-person refund approval.
- Receipt numbering and tax policy.
- Card terminal decision and reconciliation process.
- Barcode redemption concurrency tests.
- Offline sync replay/idempotency tests and data retention policy.
- Local migration test run, dependency lockfile, browser/device acceptance tests and security review.
