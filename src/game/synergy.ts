import { Element, Modifier } from './types';
import type { MineralData } from './types';
import { ELEMENT_NAMES, MODIFIER_NAMES } from './constants';
import { checkEvolutions } from './evolutions';
import type { ActiveEvolution } from './evolutions';

export interface Synergy {
  name: string;
  description: string;
  color: string;
  /** Gold border for evolutions */
  isEvolution?: boolean;
}

export interface SynergyBonuses {
  synergies: Synergy[];
  speedMult: number;
  damageMult: number;
  maxHpBonus: number;
  cooldownMult: number;
  lifestealBonus: number;
  // New fields from cross-element combos
  statusDurationMult: number;
  aoeRadiusMult: number;
  projectileSpeedMult: number;
  burnDamageMult: number;
  // Evolutions
  evolutions: ActiveEvolution[];
}

interface CrossElementCombo {
  elements: [number, number];
  name: string;
  description: string;
  color: string;
  apply: (r: SynergyBonuses) => void;
}

const CROSS_ELEMENT_COMBOS: CrossElementCombo[] = [
  {
    elements: [Element.Carbon, Element.Sulfur],
    name: 'Thermite',
    description: 'Burn tick +50%',
    color: '#ff6622',           // red + yellow → orange
    apply: r => { r.burnDamageMult += 0.5; },
  },
  {
    elements: [Element.Iron, Element.Mercury],
    name: 'Amalgam',
    description: '+15 max HP, slow on hit',
    color: '#7766ee',           // blue + purple → indigo
    apply: r => { r.maxHpBonus += 15; },
  },
  {
    elements: [Element.Phosphorus, Element.Sulfur],
    name: 'Catalyst',
    description: 'Status duration +50%',
    color: '#88ee33',           // green + yellow → lime
    apply: r => { r.statusDurationMult += 0.5; },
  },
  {
    elements: [Element.Silicon, Element.Carbon],
    name: 'Overclock',
    description: '-20% cooldowns, +10% speed',
    color: '#ff6699',           // cyan + red → pink
    apply: r => { r.cooldownMult -= 0.2; r.speedMult += 0.1; },
  },
  {
    elements: [Element.Phosphorus, Element.Mercury],
    name: 'Bioweapon',
    description: 'Lifesteal procs poison',
    color: '#66ddaa',           // green + purple → teal
    apply: r => { r.lifestealBonus += 0.05; },
  },
  {
    elements: [Element.Iron, Element.Phosphorus],
    name: 'Reactor',
    description: 'AoE radius +30%',
    color: '#33ccaa',           // blue + green → aqua
    apply: r => { r.aoeRadiusMult += 0.3; },
  },
  {
    elements: [Element.Iron, Element.Silicon],
    name: 'Alloy',
    description: '+25 max HP, -10% cooldowns',
    color: '#44bbff',           // blue + cyan → sky blue
    apply: r => { r.maxHpBonus += 25; r.cooldownMult -= 0.1; },
  },
  {
    elements: [Element.Carbon, Element.Mercury],
    name: 'Quickfire',
    description: '+20% speed, +30% proj speed',
    color: '#ee44aa',           // red + purple → magenta
    apply: r => { r.speedMult += 0.2; r.projectileSpeedMult += 0.3; },
  },
];

/** Evaluate active synergies from the player's mutation slots. */
export function evaluateSynergies(
  mutations: (MineralData | null)[],
  discoveredEvolutions: Set<string>,
): SynergyBonuses {
  const result: SynergyBonuses = {
    synergies: [],
    speedMult: 1.0,
    damageMult: 1.0,
    maxHpBonus: 0,
    cooldownMult: 1.0,
    lifestealBonus: 0,
    statusDurationMult: 1.0,
    aoeRadiusMult: 1.0,
    projectileSpeedMult: 1.0,
    burnDamageMult: 1.0,
    evolutions: [],
  };

  const active = mutations.filter((m): m is MineralData => m !== null);
  if (active.length < 1) return result;

  // Collect all elements and modifiers present
  const elemSet = new Set<number>();
  const elemCounts = new Map<number, number>();
  const modCounts = new Map<number, number>();

  for (const m of active) {
    elemSet.add(m.element);
    elemCounts.set(m.element, (elemCounts.get(m.element) || 0) + 1);
    modCounts.set(m.modifier, (modCounts.get(m.modifier) || 0) + 1);
    if (m.secondElement !== undefined) elemSet.add(m.secondElement);
  }

  // --- Tier 1: Element stacking (2+ same) ---
  if (active.length >= 2) {
    for (const [elem, count] of elemCounts) {
      if (count >= 2) {
        const name = ELEMENT_NAMES[elem];
        switch (elem) {
          case Element.Iron:
            result.maxHpBonus += count === 2 ? 15 : 30;
            result.synergies.push({ name: `${name} Shell`, description: `+${count === 2 ? 15 : 30} max HP`, color: '#4488ff' });
            break;
          case Element.Carbon:
            result.speedMult += count === 2 ? 0.15 : 0.3;
            result.synergies.push({ name: `${name} Flow`, description: `+${count === 2 ? 15 : 30}% speed`, color: '#ff3333' });
            break;
          case Element.Sulfur:
            result.damageMult += count === 2 ? 0.2 : 0.4;
            result.synergies.push({ name: `${name} Burn`, description: `+${count === 2 ? 20 : 40}% damage`, color: '#dddd00' });
            break;
          case Element.Silicon:
            result.cooldownMult -= count === 2 ? 0.15 : 0.25;
            result.synergies.push({ name: `${name} Lattice`, description: `${count === 2 ? 15 : 25}% faster cooldowns`, color: '#00eedd' });
            break;
          case Element.Phosphorus:
            result.lifestealBonus += count === 2 ? 0.1 : 0.2;
            result.synergies.push({ name: `${name} Glow`, description: `+${count === 2 ? 10 : 20}% lifesteal`, color: '#33ff66' });
            break;
          case Element.Mercury:
            result.speedMult += count === 2 ? 0.1 : 0.2;
            result.cooldownMult -= count === 2 ? 0.1 : 0.15;
            result.synergies.push({ name: `${name} Flux`, description: 'faster movement + cooldowns', color: '#cc55ff' });
            break;
        }
      }
    }

    // Modifier synergies (2+ matching)
    for (const [mod, count] of modCounts) {
      if (count >= 2) {
        const name = MODIFIER_NAMES[mod];
        switch (mod) {
          case Modifier.Volatile:
            result.damageMult += 0.15;
            result.synergies.push({ name: `${name} Instability`, description: '+15% damage (all)', color: '#ff6644' });
            break;
          case Modifier.Parasitic:
            result.lifestealBonus += 0.15;
            result.synergies.push({ name: `${name} Hunger`, description: '+15% lifesteal', color: '#aa44aa' });
            break;
          case Modifier.Feral:
            result.speedMult += 0.1;
            result.damageMult += 0.1;
            result.synergies.push({ name: `${name} Rage`, description: '+10% speed & damage', color: '#ff8844' });
            break;
          case Modifier.Crystalline:
            result.maxHpBonus += 20;
            result.synergies.push({ name: `${name} Armor`, description: '+20 max HP', color: '#88ccff' });
            break;
          case Modifier.Primordial:
            result.damageMult += 0.25;
            result.synergies.push({ name: `${name} Power`, description: '+25% damage', color: '#ffcc00' });
            break;
        }
      }
    }
  }

  // --- Tier 2: Cross-element combos (2 different specific elements) ---
  if (active.length >= 2) {
    for (const combo of CROSS_ELEMENT_COMBOS) {
      const [e1, e2] = combo.elements;
      if (elemSet.has(e1) && elemSet.has(e2)) {
        combo.apply(result);
        result.synergies.push({
          name: combo.name,
          description: combo.description,
          color: combo.color,
        });
      }
    }
  }

  // --- Tier 3: Evolutions ---
  const evolutions = checkEvolutions(mutations, discoveredEvolutions);
  result.evolutions = evolutions;

  // Add evolution entries to synergy display
  for (const evo of evolutions) {
    result.synergies.push({
      name: evo.recipe.name,
      description: evo.recipe.description,
      color: evo.recipe.color,
      isEvolution: true,
    });
  }

  // Berserker passive is handled in game.ts at runtime (HP threshold check)

  return result;
}
