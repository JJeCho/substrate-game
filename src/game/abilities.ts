import { ELEMENT_COLORS, STATUS_TICK_INTERVAL } from './constants';
import { Element, Modifier, StatusType } from './types';
import type { MineralData, Direction, StatusEffect } from './types';

export interface Ability {
  name: string;
  cooldown: number;
  maxCooldown: number;
  color: string;
  element: Element;
  modifier: Modifier;
}

export interface AbilityEffect {
  type: 'projectile' | 'dash' | 'aoe' | 'shield' | 'teleport' | 'wall' | 'beam' | 'summon';
  damage: number;
  speed: number;
  range: number;
  radius: number;
  duration: number;
  pierce: boolean;
  lifesteal: number;
  explodes: boolean;
  chain: number;
  statusEffect: StatusEffect | null;
  // Evolution-added fields
  leavesCloud?: boolean;
  afterimage?: boolean;
  reflectsProjectiles?: boolean;
  healsOnHit?: boolean;
  chainOnTeleport?: number;
  shieldExplodes?: boolean;
}

const BASE_COOLDOWNS: Record<number, number> = {
  [Element.Iron]: 2.0,
  [Element.Carbon]: 0.8,
  [Element.Sulfur]: 1.2,
  [Element.Silicon]: 2.5,
  [Element.Phosphorus]: 1.5,
  [Element.Mercury]: 1.2,
};

const BASE_TYPE: Record<number, AbilityEffect['type']> = {
  [Element.Iron]: 'shield',
  [Element.Carbon]: 'dash',
  [Element.Sulfur]: 'projectile',
  [Element.Silicon]: 'wall',
  [Element.Phosphorus]: 'aoe',
  [Element.Mercury]: 'teleport',
};

const RARITY_MULT: Record<number, number> = { 0: 1.0, 1: 1.3, 2: 1.7, 3: 2.5 };

const ELEMENT_ABILITY_NAMES: Record<number, string> = {
  [Element.Iron]: 'Guard',
  [Element.Carbon]: 'Rush',
  [Element.Sulfur]: 'Spit',
  [Element.Silicon]: 'Crystal',
  [Element.Phosphorus]: 'Pulse',
  [Element.Mercury]: 'Phase',
};

const MODIFIER_PREFIX: Record<number, string> = {
  [Modifier.Volatile]: 'Volatile',
  [Modifier.Crystalline]: 'Crystal',
  [Modifier.Parasitic]: 'Draining',
  [Modifier.Resonant]: 'Echoing',
  [Modifier.Feral]: 'Feral',
  [Modifier.Adaptive]: 'Shifting',
  [Modifier.Null]: 'Null',
  [Modifier.Primordial]: 'Primal',
};

export function createAbility(data: MineralData): Ability {
  const mult = RARITY_MULT[data.rarity];
  const baseCd = BASE_COOLDOWNS[data.element];
  // Feral modifier = faster cooldown, Crystalline = slower
  let cdMult = 1.0;
  if (data.modifier === Modifier.Feral) cdMult = 0.6;
  if (data.modifier === Modifier.Crystalline) cdMult = 1.3;

  const maxCooldown = Math.max(0.5, baseCd * cdMult / mult);

  return {
    name: `${MODIFIER_PREFIX[data.modifier]} ${ELEMENT_ABILITY_NAMES[data.element]}`,
    cooldown: 0,
    maxCooldown,
    color: ELEMENT_COLORS[data.element],
    element: data.element,
    modifier: data.modifier,
  };
}

export function getAbilityEffect(_ability: Ability, data: MineralData): AbilityEffect {
  const mult = RARITY_MULT[data.rarity];
  let baseType = BASE_TYPE[data.element];

  // Adaptive modifier overrides type to summon
  if (data.modifier === Modifier.Adaptive) baseType = 'summon';

  const effect: AbilityEffect = {
    type: baseType,
    damage: Math.round(10 * mult),
    speed: 8,
    range: 6,
    radius: 1.5,
    duration: 0.3,
    pierce: false,
    lifesteal: 0,
    explodes: false,
    chain: 0,
    statusEffect: null,
  };

  // Modifier twists
  applyModifierTwist(effect, data.modifier);

  // Element-based status effects
  applyElementStatus(effect, data.element, mult);

  return effect;
}

const FUSION_NAMES: Record<string, string> = {
  '0_1': 'Molten Edge', '0_2': 'Slag Burst', '0_3': 'Steel Lattice', '0_4': 'Iron Bloom', '0_5': 'Quicksilver Guard',
  '1_0': 'Ember Shell', '1_2': 'Acid Dash', '1_3': 'Glass Rush', '1_4': 'Bio Rush', '1_5': 'Phase Dash',
  '2_0': 'Corrosive Shield', '2_1': 'Napalm Spit', '2_3': 'Crystal Acid', '2_4': 'Plague Shot', '2_5': 'Venom Phase',
  '3_0': 'Fortress Wall', '3_1': 'Obsidian Barrier', '3_2': 'Toxic Crystal', '3_4': 'Living Wall', '3_5': 'Mirror Wall',
  '4_0': 'Iron Pulse', '4_1': 'Flame Pulse', '4_2': 'Blight Pulse', '4_3': 'Crystal Pulse', '4_5': 'Phase Pulse',
  '5_0': 'Iron Warp', '5_1': 'Blaze Warp', '5_2': 'Toxic Warp', '5_3': 'Crystal Warp', '5_4': 'Bio Warp',
};

/** Create a fused ability from two minerals. Primary element determines type, secondary adds bonus. */
export function createFusedAbility(primary: MineralData, secondary: MineralData): Ability {
  const fusionKey = `${primary.element}_${secondary.element}`;
  const name = FUSION_NAMES[fusionKey] || `${ELEMENT_ABILITY_NAMES[primary.element]}+${ELEMENT_ABILITY_NAMES[secondary.element]}`;

  // Fused abilities get boosted rarity scaling
  const combinedRarity = Math.min(3, Math.max(primary.rarity, secondary.rarity) + 1);
  const mult = RARITY_MULT[combinedRarity];
  const baseCd = BASE_COOLDOWNS[primary.element];

  let cdMult = 1.0;
  if (primary.modifier === Modifier.Feral || secondary.modifier === Modifier.Feral) cdMult = 0.6;
  if (primary.modifier === Modifier.Crystalline || secondary.modifier === Modifier.Crystalline) cdMult = Math.min(cdMult, 1.3);

  const maxCooldown = Math.max(0.4, baseCd * cdMult / mult);

  return {
    name,
    cooldown: 0,
    maxCooldown,
    color: ELEMENT_COLORS[primary.element],
    element: primary.element,
    modifier: primary.modifier,
  };
}

/** Get effect for a fused ability — stronger than single, with secondary element bonuses. */
export function getFusedAbilityEffect(data: MineralData): AbilityEffect {
  const combinedRarity = Math.min(3, data.rarity + 1);
  const mult = RARITY_MULT[combinedRarity];
  let baseType: AbilityEffect['type'] = BASE_TYPE[data.element];

  // Adaptive modifier overrides to summon
  if (data.modifier === Modifier.Adaptive) baseType = 'summon';

  // Certain fusions produce beam type
  if (data.element === Element.Phosphorus && data.secondElement === Element.Silicon) baseType = 'beam';
  if (data.element === Element.Iron && data.secondElement === Element.Carbon) baseType = 'beam';

  const effect: AbilityEffect = {
    type: baseType,
    damage: Math.round(15 * mult),  // Base higher than normal (10 → 15)
    speed: 9,
    range: 7,
    radius: 2.0,
    duration: 0.4,
    pierce: false,
    lifesteal: 0,
    explodes: false,
    chain: 0,
    statusEffect: null,
  };

  // Primary modifier twist
  applyModifierTwist(effect, data.modifier);

  // Primary element status
  applyElementStatus(effect, data.element, mult);

  // Secondary element bonus
  if (data.secondElement !== undefined) {
    switch (data.secondElement) {
      case Element.Iron:
        // Adds tankiness — lifesteal
        effect.lifesteal += 0.15;
        break;
      case Element.Carbon:
        // Adds speed
        effect.speed *= 1.4;
        break;
      case Element.Sulfur:
        // Adds explosion
        if (!effect.explodes) {
          effect.explodes = true;
          effect.radius *= 1.5;
        }
        break;
      case Element.Silicon:
        // Adds pierce
        effect.pierce = true;
        break;
      case Element.Phosphorus:
        // Adds chain
        effect.chain += 2;
        break;
      case Element.Mercury:
        // Adds range
        effect.range *= 1.5;
        break;
    }
  }

  // Secondary modifier bonus
  if (data.secondModifier !== undefined) {
    applyModifierTwist(effect, data.secondModifier, 0.5);
  }

  return effect;
}

function applyModifierTwist(effect: AbilityEffect, modifier: number, scale: number = 1.0): void {
  switch (modifier) {
    case Modifier.Volatile:
      effect.explodes = true;
      effect.radius *= 1 + 1 * scale;
      effect.damage = Math.round(effect.damage * (1 - 0.2 * scale));
      break;
    case Modifier.Parasitic:
      effect.lifesteal += 0.3 * scale;
      break;
    case Modifier.Resonant:
      effect.chain += Math.round(2 * scale);
      break;
    case Modifier.Feral:
      effect.speed *= 1 + 0.5 * scale;
      effect.damage = Math.round(effect.damage * (1 + 0.3 * scale));
      break;
    case Modifier.Null:
      effect.damage = Math.round(effect.damage * (1 - 0.5 * scale));
      break;
    case Modifier.Primordial:
      effect.damage = Math.round(effect.damage * (1 + 0.5 * scale));
      effect.pierce = true;
      break;
  }
}

function applyElementStatus(effect: AbilityEffect, element: number, mult: number): void {
  switch (element) {
    case Element.Sulfur:
      effect.statusEffect = { type: StatusType.Poison, duration: 4, tickTimer: STATUS_TICK_INTERVAL, tickDamage: Math.round(2 * mult), slowFactor: 1 };
      break;
    case Element.Carbon:
      effect.statusEffect = { type: StatusType.Burn, duration: 2, tickTimer: STATUS_TICK_INTERVAL, tickDamage: Math.round(4 * mult), slowFactor: 1 };
      break;
    case Element.Mercury:
      effect.statusEffect = { type: StatusType.Slow, duration: 3, tickTimer: 0, tickDamage: 0, slowFactor: 0.5 };
      break;
  }
}

const TYPE_VERBS: Record<string, string> = {
  projectile: 'Shoots',
  dash: 'Dash',
  aoe: 'AoE pulse',
  shield: 'Shield',
  teleport: 'Teleport',
  wall: 'Wall',
  beam: 'Beam',
  summon: 'Summon',
};

/** Get a short human-readable description of what an ability does. */
export function getAbilityDescription(data: MineralData): string {
  const effect = data.fused ? getFusedAbilityEffect(data) : getAbilityEffect(createAbility(data), data);
  const parts: string[] = [];

  parts.push(`${TYPE_VERBS[effect.type] || effect.type} ${effect.damage}dmg`);

  if (effect.explodes) parts.push('explodes');
  if (effect.pierce) parts.push('pierces');
  if (effect.lifesteal > 0) parts.push(`${Math.round(effect.lifesteal * 100)}% steal`);
  if (effect.chain > 0) parts.push(`chains ×${effect.chain}`);
  if (effect.statusEffect) {
    const sNames = ['poison', 'burn', 'slow'];
    parts.push(sNames[effect.statusEffect.type] || 'status');
  }

  return parts.join(', ');
}

export function facingToDelta(facing: Direction): { dx: number; dy: number } {
  switch (facing) {
    case 'up': return { dx: 0, dy: -1 };
    case 'down': return { dx: 0, dy: 1 };
    case 'left': return { dx: -1, dy: 0 };
    case 'right': return { dx: 1, dy: 0 };
  }
}
