import type { ActionInput, ActionResult, AgentState, TerritoryId } from './world.ts';

/**
 * The chronicle rows an executed action produces, pure (SPEC R3.3, R8.4): every result, success or
 * failure, becomes at least one row, and a plan that stops early says where. `simulation.ts` writes
 * whatever these functions return, in this order, so nothing the world answers is dropped.
 */

/** One row of the chronicle feed, in the shape `logEvent` writes. */
export interface ChronicleRow {
  agent_id: string | null;
  island: TerritoryId | null;
  type: string;
  message: string;
}

/**
 * The rows for one executed step, in the order they are written:
 * 1. the result itself, always: type = the action type, message = "Name: <world's plain-language answer>"
 *    (a private `remember` is summarized by the world's own line, `You record in the empire chronicles: "..."`);
 * 2. when a chat pushed the target's oldest pending message out of its inbox, the loss (R7.4), if `target` is known;
 * 3. the villager's thought, on the first step of a turn only (R8.3).
 * `agent.island` must already be the villager's territory after the step.
 */
export function eventsForResult(
  agent: Pick<AgentState, 'id' | 'name' | 'island'>,
  action: Pick<ActionInput, 'type'>,
  result: Pick<ActionResult, 'message' | 'chat'>,
  opts: { thought?: string; isFirst?: boolean; target?: { id: string; name: string; island: TerritoryId } } = {}
): ChronicleRow[] {
  const rows: ChronicleRow[] = [
    { agent_id: agent.id, island: agent.island, type: action.type, message: `${agent.name}: ${result.message}` },
  ];
  const dropped = result.chat?.dropped;
  if (dropped && opts.target) {
    rows.push({
      agent_id: opts.target.id,
      island: opts.target.island,
      type: 'system',
      message: `${opts.target.name} had too many unheard words pending; ${dropped.fromName}'s "${dropped.message.slice(0, 80)}" was lost.`,
    });
  }
  if (opts.thought && opts.isFirst) {
    rows.push({ agent_id: agent.id, island: agent.island, type: 'thought', message: `${agent.name} thinks: ${opts.thought}` });
  }
  return rows;
}

/**
 * The row that says a plan stopped early (R8.4): `endedAt` is the index of the failing step (see
 * `runSteps`), `total` the number of steps. Null when the plan ran to the end or was a single action.
 */
export function planEndRow(
  agent: Pick<AgentState, 'id' | 'name' | 'island'>,
  endedAt: number | null,
  total: number
): ChronicleRow | null {
  if (endedAt === null || endedAt >= total - 1) return null;
  return {
    agent_id: agent.id,
    island: agent.island,
    type: 'system',
    message: `${agent.name}'s plan ends at step ${endedAt + 1} of ${total}; the remaining steps are not attempted.`,
  };
}
