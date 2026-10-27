---
name: performance-optimization
description: Measure-first performance rules for this app's two cost centers — the Three.js voxel scene (render loop, object counts, labels, bubbles) and the live data flow (realtime event updates, feed and roster re-renders). Use whenever the user reports lag, slowness, dropped frames, or stutters, and proactively whenever adding objects to the world, per-frame animation work, 3D labels, large lists, or realtime subscriptions — even if they only say "make it smoother".
---

# Performance Optimization

This app runs a Three.js voxel world and a realtime-updated chronicle side by side. Frame budget is the currency: everything in the render loop competes for the same 16ms. Never guess which part is slow — form a hypothesis, confirm it by reading the code path or timing it in the console, then fix that and only that.

## The 3D scene

- Per-frame work in the render loop is sacred. Anything that can be computed once belongs outside the loop: geometry, materials, colors, label sprites, vectors. Creating geometry or materials per frame leaks and stutters — reuse shared instances (this codebase keeps a shared material cache in the voxel builders for exactly this reason).
- Object count beats polygon count for voxel scenes. Each block is a separate mesh, so seeding "more scenery" multiplies draw calls. When adding world content, prefer a modest count of composite objects over scattering hundreds of single boxes, and reuse the existing box geometry instead of allocating new ones per object where practical.
- 3D labels and bubbles are the quiet killers: each is a rendered texture. Cap them by distance or state — only the selected villager and nearby speakers get labels, not all thirteen.
- Animation updates (legs, arms, bobbing) should read from a clock already ticking in the loop, not start timers of their own.

## The data flow

- Realtime events arrive one per villager action. Batch or debounce state updates so a burst of ten events causes one React commit, not ten full re-renders of the feed and roster.
- Long lists (the feed caps at 500 events) must virtualize or window — render only what's visible. The same applies to the roster as the population grows.
- Subscriptions should select narrow columns and clean up on unmount; a forgotten channel keeps re-rendering a dead screen.

## Verification

This environment has no profiling dashboard, so verify concretely: run the typecheck and production build for structural regressions, then reason through the changed code path's per-frame or per-event cost in numbers ("was 500 meshes, now 620, +24 draw calls") rather than claiming "should be fast". State what you measured or counted; do not claim frame rates you did not observe.

## Example

"Add birds flying over the island." Wrong: a new mesh per bird created in the animation frame, each with its own material — 12 birds = 12 allocations per frame. Right: build the bird geometry and material once at scene setup, move the flock by updating a small set of positions inside the existing loop, and skip birds beyond camera distance.
