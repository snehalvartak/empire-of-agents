/**
 * Fair turn rotation (SPEC R7.5): round-robin in join order, driven by a cursor
 * rather than `tick mod count`, so a roster change never skips or repeats anyone.
 *
 * `agentIds` is the roster in join order (new villagers are appended at the end).
 * `lastActorId` / `lastActorIndex` are who acted last and the index they occupied
 * then. Returns the index of the next actor, or -1 for an empty roster.
 *
 * - no last actor yet: index 0
 * - last actor still present: the villager after them, wrapping
 * - last actor removed: their successor, i.e. whoever now sits at their old index, wrapping
 */
export function pickNextActor(agentIds: string[], lastActorId: string | null, lastActorIndex: number): number {
  const n = agentIds.length;
  if (n === 0) return -1;
  if (lastActorId === null) return 0;
  const at = agentIds.indexOf(lastActorId);
  if (at >= 0) return (at + 1) % n;
  return Math.max(0, lastActorIndex) % n;
}
