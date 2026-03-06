export const TileType = {
  Wall: 0,
  Floor: 1,
  Corridor: 2,
  Stairs: 3,
  TrapFloor: 4,
  Lava: 5,
  Water: 6,
  LockedDoor: 7,
  CrackedWall: 8,
} as const;

export type TileType = (typeof TileType)[keyof typeof TileType];

export interface Room {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type GameMap = TileType[][];

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface DungeonResult {
  map: GameMap;
  rooms: TaggedRoom[];
}

export const Element = {
  Iron: 0,
  Carbon: 1,
  Sulfur: 2,
  Silicon: 3,
  Phosphorus: 4,
  Mercury: 5,
} as const;

export type Element = (typeof Element)[keyof typeof Element];

export const Modifier = {
  Volatile: 0,
  Crystalline: 1,
  Parasitic: 2,
  Resonant: 3,
  Feral: 4,
  Adaptive: 5,
  Null: 6,
  Primordial: 7,
} as const;

export type Modifier = (typeof Modifier)[keyof typeof Modifier];

export const Rarity = {
  Common: 0,
  Uncommon: 1,
  Rare: 2,
  Primordial: 3,
} as const;

export type Rarity = (typeof Rarity)[keyof typeof Rarity];

export const StatusType = {
  Poison: 0,
  Burn: 1,
  Slow: 2,
} as const;

export type StatusType = (typeof StatusType)[keyof typeof StatusType];

export interface StatusEffect {
  type: StatusType;
  duration: number;
  tickTimer: number;
  tickDamage: number;
  slowFactor: number;
}

export const RoomType = {
  Normal: 0,
  Treasure: 1,
  Trap: 2,
  MineralRich: 3,
  Shrine: 4,
  Shop: 5,
  Secret: 6,
} as const;

export type RoomType = (typeof RoomType)[keyof typeof RoomType];

export interface TaggedRoom extends Room {
  roomType: RoomType;
}

export interface MineralData {
  element: Element;
  modifier: Modifier;
  rarity: Rarity;
  fused?: boolean;
  secondElement?: Element;
  secondModifier?: Modifier;
}

export const BuffType = {
  DamageUp: 0,
  SpeedUp: 1,
  Regen: 2,
  CooldownDown: 3,
  Shield: 4,
} as const;

export type BuffType = (typeof BuffType)[keyof typeof BuffType];

export interface ActiveBuff {
  type: BuffType;
  duration: number;
  magnitude: number;
}

export const BossType = {
  IronGuardian: 0,
  SulfurWyrm: 1,
  MercuryPhantom: 2,
} as const;

export type BossType = (typeof BossType)[keyof typeof BossType];
