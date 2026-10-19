# Museum Ticketing & Sales Management System

A local-first point-of-sale foundation for museum admission, merchandise, cash management, and ticket issuance.

## Current status

This repository is under active development. It is not production-ready and has not been deployed. Tax treatment, receipt requirements, and card terminal integration remain intentionally unconfigured.

## Stack

- Next.js App Router, React, TypeScript
- Supabase Auth and PostgreSQL
- PWA/offline cash queue planned with IndexedDB
- Vercel project `museumpos` (no deployment yet)

## Safety decisions

- Each employee has an individual Supabase Auth identity plus a separate POS PIN unlock.
- Offline sales are cash-only. Card payments require independently confirmed terminal results.
- Never expose Supabase service-role credentials to the browser.
- Prices and financial records must be validated by trusted server-side operations.
- Confirm tax and receipt rules with management/accounting before enabling production checkout.

## Development

The first implementation milestone is a local development build and database tests. Do not run production migrations or deploy this project without explicit approval.
