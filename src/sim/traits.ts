export interface Trait {
  level: number;
  xp: number;
}

export type TraitMap = Record<string, Trait>;

/** XP needed to advance from one level to the next grows with level. */
export function xpForNext(level: number): number {
  return 4 + (level - 1) * 3;
}

/** Keeps any agent-invented trait key with a sane level/xp pair. */
export function sanitizeTraits(raw: unknown): TraitMap {
  const out: TraitMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === 'object' && typeof (v as Trait).level === 'number') {
      const level = Math.min(20, Math.max(1, Math.floor((v as Trait).level)));
      const xp = Math.max(0, Math.floor((v as Trait).xp ?? 0));
      out[k] = { level, xp };
    }
  }
  return out;
}

export interface TraitGain {
  traits: TraitMap;
  levelUp: boolean;
  level: number;
  isNew: boolean;
}

/**
 * Grants XP to a named ability — creating it at level 1 if the agent
 * has never trained it before. Overflow XP carries into level-ups.
 */
export function grantXp(traits: TraitMap, trait: string, amount: number): TraitGain {
  const isNew = !traits[trait];
  const current = traits[trait] ?? { level: 1, xp: 0 };
  const next: TraitMap = { ...traits, [trait]: { ...current } };
  let xp = current.xp + amount;
  let level = current.level;
  let levelUp = false;
  while (xp >= xpForNext(level) && level < 20) {
    xp -= xpForNext(level);
    level += 1;
    levelUp = true;
  }
  next[trait] = { level, xp };
  return { traits: next, levelUp, level, isNew };
}

export function normalizeTraitName(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 28);
  if (name.length < 2 || !/^[a-z][a-z0-9 '-]*$/.test(name)) return null;
  return name;
}
