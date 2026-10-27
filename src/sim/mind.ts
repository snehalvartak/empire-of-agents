import { systemPrompt } from './brain.ts';
import { observe } from './world.ts';
import type { AgentState, WorldSnapshot } from './world.ts';

/**
 * Everything a villager's mind is given for one turn (SPEC R8.1): the system prompt (persona + soul,
 * skills, territories, chronicles, bonds, the action catalog) and the observation assembled fresh
 * from live state (R5.2). Pure and cache-free: it reads only the villager itself, the world
 * snapshot, the villager's own layered chronicles and its own recent action history, so nothing else
 * (no database row, no player text, no other villager's private layer) can reach the prompt.
 * `simulation.ts` calls this for every turn.
 */
export function buildMindInput(
  agent: AgentState,
  snapshot: WorldSnapshot,
  memories: string[],
  history: Array<{ label: string; result: string }> = []
): { system: string; observation: string } {
  return { system: systemPrompt(agent, memories), observation: observe(snapshot, agent, history) };
}
