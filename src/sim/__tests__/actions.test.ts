import { describe, expect, it } from 'vitest';
import { ACTION_DEFS, sanitizeAction } from '../actions.ts';
import type { ActionType } from '../actions.ts';
import { systemPrompt } from '../brain.ts';
import { ACTION_TYPES, step } from '../world.ts';
import { REPRESENTATIVE, mkAgent, mkSnapshot } from './fixtures.ts';

const types = Object.keys(ACTION_DEFS) as ActionType[];
const prompt = systemPrompt(mkAgent('a', 'Alder', 7, 8), []);

describe('H5 / R4.2 — every action in the table is complete', () => {
  it('H5: the table is not empty and every entry is keyed by its own type', () => {
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) expect(ACTION_DEFS[t].type).toBe(t);
  });

  for (const type of types) {
    it(`H5: ${type} has a catalog line that names it and shows up in the villager's prompt`, () => {
      const { catalog } = ACTION_DEFS[type];
      expect(catalog.trim().length).toBeGreaterThan(0);
      expect(catalog).toContain(`"type":"${type}"`);
      expect(prompt).toContain(`- ${catalog}`);
    });

    it(`H5: ${type} has a handler — step() answers a valid input and never "Unknown action"`, () => {
      const snap = mkSnapshot([mkAgent('a', 'Alder', 6, 7, ['wood']), mkAgent('b', 'Bramble', 7, 8)]);
      const result = step(snap, 'a', REPRESENTATIVE[type]);
      expect(result).toBeDefined();
      expect(typeof result.ok).toBe('boolean');
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).not.toMatch(/^Unknown action/);
      expect(Array.isArray(result.events)).toBe(true);
    });
  }

  it('H5: the representative-input fixture covers exactly the table', () => {
    expect(Object.keys(REPRESENTATIVE).sort()).toEqual([...types].sort());
    for (const t of types) expect(REPRESENTATIVE[t].type).toBe(t);
  });
});

describe('R3.1 — one source of truth', () => {
  it('R3.1: the schema enum (ACTION_TYPES) equals the ACTION_DEFS keys', () => {
    expect([...ACTION_TYPES]).toEqual(types);
  });

  it('R3.1: the prompt catalog lists the table, line for line and nothing else', () => {
    const lines = prompt.split('\n').filter((l) => l.startsWith('- {"type":'));
    expect(lines).toEqual(types.map((t) => `- ${ACTION_DEFS[t].catalog}`));
  });

  it('R3.1: the sanitizer keeps every known type that has valid data', () => {
    for (const t of types) {
      const out = sanitizeAction(t, JSON.parse(JSON.stringify(REPRESENTATIVE[t].data)));
      expect(out.type, t).toBe(t);
    }
  });

  it('R3.1: unknown and prototype keys become wait', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'teleport', '']) {
      expect(sanitizeAction(key, { x: 1 }), key).toEqual({ type: 'wait', data: {} });
    }
  });

  it('R3.1: data a type rejects (a train with no ability) becomes wait', () => {
    expect(sanitizeAction('train', {})).toEqual({ type: 'wait', data: {} });
  });

  it('R3.1: an unknown structure falls back to a house; coordinates are coerced to numbers', () => {
    expect(sanitizeAction('build', { structure: 'castle' })).toEqual({ type: 'build', data: { structure: 'house' } });
    expect(sanitizeAction('goto', { x: '3', y: 'north' })).toEqual({ type: 'goto', data: { x: 3, y: 0 } });
  });
});

describe('R5.4 — the prompt never explains a mechanic', () => {
  it('R5.4: the system prompt contains neither "rumor" nor "reacts to"', () => {
    const lower = prompt.toLowerCase();
    expect(lower).not.toContain('rumor');
    expect(lower).not.toContain('reacts to');
  });
});
