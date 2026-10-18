# Testing Smart Health Grid

## Quick start

```bash
npm ci
npm test                 # all tests (unit + database integration)
npm run test:unit        # fast pure-logic tests only (< 1 s)
npm run test:integration # database-backed workflow tests
npm run test:coverage    # all tests + coverage report (coverage/index.html)
npm run test:watch       # watch mode while developing
npm run lint
npm run typecheck
npm run build
npm run validate         # lint + typecheck + coverage + build (what CI runs)
```

**Prerequisites:** Node.js 20.9+ (CI uses 22). No database server, network, Supabase project
or credentials are needed — integration tests use an isolated in-memory Postgres (PGlite).

## Layout

| Path | Kind | What it covers |
| --- | --- | --- |
| `tests/unit/*.test.ts` | Unit | Pure business rules: forecasting, stock-out projection, risk scoring, attendance classification, redistribution and expiry maths, validation schemas, permissions, password hashing, DB error mapping, IST date handling, allocation windows, i18n, offline queue |
| `tests/allocation-engine.test.ts` | Unit | Nearest-first batch allocation (stability, ties, capacity, alternatives) |
| `tests/allocation-db.test.ts` | Integration | Allocation windows, concurrent triggers, retries, cancellation & reallocation, overbooking constraint, emergency routing |
| `tests/distribution.test.ts` | Unit + integration | Emergency-borrowing decisions; full loan lifecycle, dispatch/receipt, ledger, restoration, failures, permissions |
| `tests/workforce.test.ts` | Unit + integration | Geofence/identity rules, check-in/out replay protection, review flow, workload and redeployment safeguards |
| `tests/helpers/db.ts` | Fixture | `createTestDb()` — fresh in-memory DB with all migrations + deterministic synthetic seed |

## Fixtures and isolation

- `createTestDb()` applies every SQL migration in `supabase/migrations/` plus the Supabase
  compatibility shim, then seeds the deterministic synthetic dataset (fixed PRNG seed, dates
  relative to "today"). Each test file gets its own database; nothing touches `.data/` or any
  live database.
- `t.as(userId, fn)` runs queries as an authenticated user so **Row Level Security is
  enforced exactly as in production**; `t.sys(fn)` runs as the trusted system role.
- Unit tests pass explicit dates (e.g. `const T = "2026-10-18"`) instead of reading the clock.
- The Vitest config pins `TZ=Asia/Kolkata`, disables the background allocation scheduler and
  restores mocks/globals after every test.

## Mocking strategy

Mock only at external boundaries:
- Browser APIs (`localStorage`, `navigator.onLine`) are stubbed with `vi.stubGlobal` in the
  offline-queue tests.
- Supabase Auth and the Supabase SDK are not called in tests; database behaviour is tested
  against real Postgres (PGlite) running the same migrations and RLS policies.
- Business logic is never mocked away — assertions run against real calculations.

## Coverage

`npm run test:coverage` (V8 provider) reports on `src/lib/**` — the business-logic layer.
Excluded: translation dictionaries (data) and thin Supabase SDK wrappers (need a live project).
React pages/components are verified by lint, typecheck, the production build and the
`scripts/smoke.mts` page smoke test.

## Adding a test

1. Pure function? Add `tests/unit/<area>.test.ts`, import from `@/lib/...`, use fixed dates.
2. Database rule, RLS or SQL function? Use `createTestDb()` in `beforeAll`, `t.close()` in
   `afterAll`, and exercise it through `t.as(...)` to include authorization.
3. Cover normal, boundary, invalid, empty and permission-denied cases; never weaken an
   assertion to make a test pass.
