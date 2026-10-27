---
name: code-review-and-quality
description: Review discipline for every non-trivial change — five-axis review (correctness, design, security, performance, tests/verification), change-size guideline, and severity labels. Use before declaring any change done, and proactively when the user asks to "review", "check", "clean up", or "improve" code, or when a change touched multiple systems. Composes with the verify-before-ready skill: this skill judges the design, that one proves the build.
---

# Code Review and Quality

Review your own work the way a skeptical senior engineer would: read the finished change as a whole, in the files it actually lives in, before calling it done. The question is not "does it run" but "would a staff engineer approve this".

## The five axes

1. **Correctness.** Does it do what was asked, in every state — empty, loading, error, extreme? For this app specifically: does it hold for all territories and road tiles, all object kinds, a session with no history, a malformed AI reply, and an archived session being replayed?
2. **Design.** Does it follow the codebase's existing seams? The rules that matter here: simulation logic stays in `src/sim` and never imports rendering; rendering consumes the world through one shared source of truth (the ground-height rule is the canonical example — any feature that hardcodes a height or position instead of asking the shared rule is a defect); UI reuses the existing panel and palette conventions rather than inventing parallel ones.
3. **Security.** Re-run the security skill's checklist mentally for anything touching data access, the AI proxy, or viewer input.
4. **Performance.** For scene or data-flow changes, count the actual cost (draw calls, subscriptions, re-renders), per the performance skill.
5. **Verification.** Did the typecheck and build actually run and pass, and were the changed behaviors observed or reasoned through concretely? A summary that says "should work" without evidence fails this axis.

## Change size

Keep a single change to roughly one focused concern — about a hundred lines of real change is a healthy ceiling. When a request drifts into touching five unrelated concerns, land them as separate sequential changes: fix, then polish, then feature. A sprawling change cannot be reviewed honestly, by you or by anyone else.

## Severity labels

When reporting findings, label them: **defect** (will misbehave — fix now), **risk** (works but fragile — fix or flag), **nit** (style or polish — fix only if trivial). Don't inflate nits into defects, and never bury a defect among nits.

## Leftover check

A change is not done until what it replaced is gone: no dead exports, commented-out blocks, orphaned files, or "_old" variants. Check call sites before deleting anything, but do not leave the decision for later.

## Example

After adding a heat-map overlay, self-review catches: it reads positions from a per-frame React state (risk — will re-render the whole panel every tick, should read from a ref); it hardcodes ground level 1 for its markers (defect — raised terrain tiles will float the markers; use the shared height rule); and it left the demo array it was built against in place (leftover — delete).
