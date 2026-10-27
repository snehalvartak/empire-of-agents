# Testing

- `npm run test` (Vitest, `src/**/*.test.ts`, node, no network/model/Supabase) — the deterministic spec checks: E3, G3, G4, R8.4/B3, H5/R3.1/R4.2, B2/R4.1, H2/R5.2/R5.4.
- `npm run typecheck` (includes the tests), `npm run lint` (baseline: 0 errors / 0 warnings) and `npm run build` must all pass clean.
- `npm run harness` runs the live-model checks (B1, C1, C2); it needs `.env` and network access, costs money and varies run to run, so judge it over two runs.
- Not covered yet: A (build health is the three commands above), D, E1/E2, F, G1/G2/G5, H1/H3/H4 (they need persistence or manifests that are not built).
