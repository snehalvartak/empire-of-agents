import type { KeyMoment, TimelineAgent, TimelineEvent } from '@/components/PaperViews';

/** Category colors for activity bars, keyed by event type. */
export function categoryColor(type: string): string {
  if (type === 'gather') return '#9ccc3f';
  if (type === 'build') return '#5b8f3a';
  if (type === 'deposit') return '#3b82c4';
  if (type === 'say') return '#f0a04a';
  if (type === 'chat') return '#e0679a';
  if (type === 'advance_age') return '#e2b04a';
  if (type === 'train' || type === 'level_up') return '#f2d24b';
  if (type === 'discover') return '#4cc9d4';
  if (type === 'eat') return '#d98e5f';
  if (type === 'wait') return '#6b675e';
  if (type === 'move' || type === 'goto') return '#8a8375';
  if (type === 'remember' || type === 'thought') return '#7f9fc4';
  return '#b5ab97';
}

export const CATEGORY_LEGEND: Array<[string, string]> = [
  ['gather', 'Gathering'],
  ['build', 'Building'],
  ['deposit', 'Depositing'],
  ['say', 'Speaking'],
  ['chat', 'Chatting'],
  ['advance_age', 'Age advance'],
  ['level_up', 'Ability'],
  ['discover', 'Discovery'],
  ['eat', 'Eating / resting'],
];

/** Rule-based detection of firsts: first build, age advance, discovery, ability, chat (F2.4). */
export function detectKeyMoments(
  events: TimelineEvent[],
  agents: TimelineAgent[]
): KeyMoment[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const targets: Array<{ type: string; label: string; tone: KeyMoment['tone'] }> = [
    { type: 'build', label: 'First structure raised', tone: 'grass' },
    { type: 'advance_age', label: 'The empire advances', tone: 'gold' },
    { type: 'discover', label: 'A rule of the world discovered', tone: 'water' },
    { type: 'level_up', label: 'Ability invented', tone: 'gold' },
    { type: 'chat', label: 'First conversation', tone: 'stone' },
    { type: 'pick_up', label: 'First creature taken', tone: 'ember' },
  ];
  const moments: KeyMoment[] = [];
  for (const t of targets) {
    const e = events.find((e) => e.type === t.type && typeof e.tick === 'number');
    if (!e) continue;
    const agent = e.agent_id ? byId.get(e.agent_id) : undefined;
    moments.push({
      kind: t.type,
      label: t.label,
      tone: t.tone,
      tick: e.tick ?? 0,
      agentName: agent?.name ?? 'The empire',
      agentColor: agent?.color ?? '#8a6d3b',
      quote: e.message.replace(/^.*?: /, ''),
    });
  }
  return moments.sort((a, b) => a.tick - b.tick).slice(0, 8);
}
