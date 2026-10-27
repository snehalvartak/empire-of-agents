---
name: debugging-and-error-recovery
description: Five-step triage for anything broken — reproduce, localize, reduce, fix, guard — with this project's concrete diagnostic paths (browser console for the 3D scene, edge function logs for the AI proxy, direct database queries for wrong world state). Use whenever a build or typecheck fails, a villager or system behaves unexpectedly, data looks wrong, an error appears, or the user says "it's broken", "doesn't work", "stuck", or "crashed". Do not start changing code on a guess.
---

# Debugging and Error Recovery

The rule: no fix without a diagnosis. Changing code until the symptom fades hides the bug and usually moves it. Work the five steps in order; most debugging fails at step one because the fixer never actually reproduced the problem.

## The five steps

1. **Reproduce.** Pin down exactly what happens, where, and when. "A villager is stuck" is not a reproduction; "the woodcutter stands at the town center forever after the mine depleted at tick 412" is. Read the feed, the console, and the current world state before theorizing.
2. **Localize.** Find the smallest failing piece. The simulation logic (`src/sim`), the rendering (`src/components/voxel`), the AI proxy (the edge function), and the database are separate layers — determine which layer owns the failure before opening files. The browser console tells you rendering and client errors; edge function logs tell you proxy errors; a direct SQL query tells you whether the data itself is wrong.
3. **Reduce.** Strip the problem to its core. If villagers behave oddly, check whether one villager's stored state is malformed before suspecting the brain. If the scene looks wrong, check whether it's the data (positions, heights) or the drawing (transforms, layers).
4. **Fix.** Fix the cause, not the symptom. A villager walking into the ground three times means the shared ground-height rule was bypassed — fix the rule usage, don't nudge that villager up. If a fix needs a comment explaining what bug it works around, it's probably a symptom patch.
5. **Guard.** Make the same failure impossible to silently recur. Untrusted inputs (viewer settings, AI replies, external data) get validated at the boundary; failure paths get a visible state, not a console-only error. In this app the classic guard is: a malformed or failed AI reply must send the villager to a safe idle, never freeze the simulation loop.

## Stop-the-line

If a build or typecheck fails, fix that failure before anything else — never stack new work on a red build. If an approach has failed twice for the same reason, stop and re-read the error and your assumption; the third identical attempt is not diligence, it's denial.

## Partial recovery

When a fix can't fully land (an external service is down, a data migration is risky), make the failure explicit and visible — an on-brand error state, a logged warning with context — and say so plainly in your summary. A silently degraded feature is worse than a loudly missing one.

## Example

The event feed stops updating. Wrong: restart everything, rewrite the subscription "just in case". Right: reproduce (which events stopped — all, or one type?), localize (check whether the database has the events at all — if yes, the subscription or rendering is at fault; if no, the writer is), then fix the owner layer and guard: if the writer can silently drop events on error, make it surface the failure instead.
