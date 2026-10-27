---
name: verify-before-ready
description: Verification checklist to run BEFORE telling the user a change is done or "ready" — compile, inspect real persisted state, and re-read edited files. Use after every code or database change, even small ones, whenever you are about to say something works, is fixed, or is ready. Trigger phrases include "is it done", "did that work", "make sure it's ready", and any request that ends with a fix.
---

# Verify Before Ready

Never declare work finished based on intention — declare it finished based on checks you actually ran this turn. In this project, "looks right in the code" has repeatedly diverged from "true in the database" (old rows silently overriding new code), so verification must touch the real state, not just the source.

## The checklist

Run these before any "it's done" message:

1. **Compile check.** Run the TypeScript check and the production build. A change is not done while either fails. Fix failures before reporting; if you cannot, say so plainly.
2. **Re-read what you changed.** Re-read the edited regions (not from memory — the actual current file) and confirm the change landed where you intended and did not break neighboring logic. Earlier file reads are stale after edits.
3. **Check real persisted state.** If the change involves database data (agents, traits, goals, structures, civ, settings), query the live database and confirm the rows actually match what you expect. Code that only writes correctly on future turns does not fix existing rows — repair or clear the stored data when the request implies the current state should change.
4. **Trace one full flow by hand.** Follow the user-visible path end to end through the code: entry point → load → action → persistence → render. Confirm there is no dead end (e.g. a button that can never enable, a list nothing populates).
5. **Report honestly.** In the final message, state what was verified and how. If something was NOT or COULD NOT be verified (e.g. no browser available for UI, Safari on real hardware), say that explicitly and name the symptom the user should watch for.

## Why each step exists

- Step 1 catches breakage a confident summary hides. Builds pass less often than you expect.
- Step 2 exists because edits sometimes apply to a spot adjacent to the intended one, or reassignments (const → let) are missed.
- Step 3 exists because this project's database outlives code versions: preset skills, stale positions, and old events persisted after the code stopped creating them. The database is the source of truth the user sees.
- Step 4 exists because "the default villagers exist" was coded before it was confirmed, and empty-state bugs hide exactly there.
- Step 5 exists because unverified claims ("the page now loads in Safari") erode trust more than admitted gaps.

## Example

Bad: "Fixed the empty world issue — new sessions will now get the two default villagers." (No database query, no build, no check that existing rows with preset traits were handled.)

Good: "I added the seeding logic, ran the type check and build (both pass), then queried the agents table: it was empty, so defaults will seed on next load. I also found preset traits stored by an older version — current code never writes those — and cleared them. Verified: build, live rows. Not verified: actual browser load, since I have no browser here; reload and tell me if anything looks off."
