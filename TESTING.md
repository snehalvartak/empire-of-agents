# Testing

- `npm run test` (Vitest, `src/**/*.test.ts`, node, no network/model/Supabase) — the deterministic spec checks: E3, G3, G4, G5, R8.4/B3, H5/R3.1/R4.2, B2/R4.1, H2/R5.2/R5.4.
- `npm run typecheck` (includes the tests), `npm run lint` (baseline: 0 errors / 0 warnings) and `npm run build` must all pass clean.
- `npm run harness` runs the live-model checks (B1, C1, C2); it needs `.env` and network access, costs money and varies run to run, so judge it over two runs.
- Not covered yet: A (build health is the three commands above), D, E1/E2, F, G1/G2, H1/H3/H4 (they need persistence or manifests that are not built).

- G5 (single driver, R7.6/R9.4) is covered by `src/sim/__tests__/driver.test.ts`: the pure lease rules in `src/sim/driver.ts` (`decideLease` table including the TTL boundary, `leaseCutoffIso`, the claim filter and its id safety, a source guard that the module reads no clock) and two competing drivers against an in-memory fake of the `sessions` row that parses the real filter string. What is **not** tested: the atomicity itself. It holds by construction because acquisition is one conditional `UPDATE ... WHERE id = ? AND (driver_id IS NULL OR driver_id = me OR heartbeat missing or stale) RETURNING *`, and Postgres serialises competing updates on a row; there is no database in this environment, so the unit tests do not run that statement against one, nor `Simulation.start()`/heartbeat/release (`simulation.ts` imports Supabase). Verify on a real database with two browser windows.
