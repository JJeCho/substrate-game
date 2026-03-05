import { Element, Modifier } from './types';
import type { MineralData } from './types';

export interface EvolutionRecipe {
  id: string;
  name: string;
  description: string;
  color: string;
  /** Required elements across any equipped mutations */
  requireElements?: number[];
  /** Required modifiers across any equipped mutations */
  requireModifiers?: number[];
  /** Which ability type this transforms, or 'passive' for global effect */
  target: 'projectile' | 'dash' | 'shield' | 'wall' | 'aoe' | 'teleport' | 'passive';
}

export interface ActiveEvolution {
  recipe: EvolutionRecipe;
  /** First time discovering this evolution in this session */
  justDiscovered: boolean;
}

export const EVOLUTION_RECIPES: EvolutionRecipe[] = [
  {
    id: 'toxic_miasma',
    name: 'Toxic Miasma',
    description: 'Projectiles leave poison clouds on impact',
    color: '#88cc22',
    requireElements: [Element.Sulfur],
    requireModifiers: [Modifier.Parasitic],
    target: 'projectile',
  },
  {
    id: 'arc_storm',
    name: 'Arc Storm',
    description: 'Teleport creates chain lightning',
    color: '#bb66ff',
    requireElements: [Element.Mercury],
    requireModifiers: [Modifier.Resonant],
    target: 'teleport',
  },
  {
    id: 'molten_core',
    name: 'Molten Core',
    description: 'Shield explodes on expiration',
    color: '#5599ff',
    requireElements: [Element.Iron],
    requireModifiers: [Modifier.Volatile],
    target: 'shield',
  },
  {
    id: 'phantom_strike',
    name: 'Phantom Strike',
    description: 'Dash leaves a damaging afterimage',
    color: '#ff4444',
    requireElements: [Element.Carbon],
    requireModifiers: [Modifier.Adaptive],
    target: 'dash',
  },
  {
    id: 'crystal_fortress',
    name: 'Crystal Fortress',
    description: 'Walls last longer and reflect projectiles',
    color: '#00ffee',
    requireElements: [Element.Silicon],
    requireModifiers: [Modifier.Crystalline],
    target: 'wall',
  },
  {
    id: 'life_engine',
    name: 'Life Engine',
    description: 'AoE pulses heal 25% of damage dealt',
    color: '#33ff66',
    requireElements: [Element.Phosphorus],
    requireModifiers: [Modifier.Parasitic],
    target: 'aoe',
  },
  {
    id: 'berserker',
    name: 'Berserker',
    description: 'Below 30% HP: +80% damage, -40% cooldowns',
    color: '#ff4400',
    requireModifiers: [Modifier.Feral, Modifier.Volatile],
    target: 'passive',
  },
  {
    id: 'plague_tide',
    name: 'Plague Tide',
    description: 'Status effects spread to nearby enemies',
    color: '#aacc44',
    requireElements: [Element.Sulfur, Element.Mercury],
    target: 'passive',
  },
];

/**
 * Check which evolutions are active based on equipped mutations.
 * An evolution is active when all its required elements AND modifiers
 * are found across any of the equipped mutations.
 */
export function checkEvolutions(
  mutations: (MineralData | null)[],
  alreadyDiscovered: Set<string>,
): ActiveEvolution[] {
  const active = mutations.filter((m): m is MineralData => m !== null);
  if (active.length < 1) return [];

  // Collect all elements and modifiers present across mutations
  const elements = new Set<number>();
  const modifiers = new Set<number>();

  for (const m of active) {
    elements.add(m.element);
    modifiers.add(m.modifier);
    if (m.secondElement !== undefined) elements.add(m.secondElement);
    if (m.secondModifier !== undefined) modifiers.add(m.secondModifier);
  }

  const result: ActiveEvolution[] = [];

  for (const recipe of EVOLUTION_RECIPES) {
    // Check element requirements
    if (recipe.requireElements) {
      const hasAll = recipe.requireElements.every(e => elements.has(e));
      if (!hasAll) continue;
    }

    // Check modifier requirements
    if (recipe.requireModifiers) {
      const hasAll = recipe.requireModifiers.every(m => modifiers.has(m));
      if (!hasAll) continue;
    }

    const justDiscovered = !alreadyDiscovered.has(recipe.id);
    result.push({ recipe, justDiscovered });
  }

  return result;
}
