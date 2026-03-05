export const MAP_WIDTH = 80;
export const MAP_HEIGHT = 50;
export const TILE_SIZE = 14;

export const MIN_LEAF_SIZE = 10;
export const MIN_ROOM_SIZE = 4;
export const MIN_ROOM_PADDING = 2;

export const PLAYER_SPEED = 8; // tiles per second (was 5 — faster pace)
export const VISION_RADIUS = 9; // tiles
export const PLAYER_MAX_HP = 100;
export const MUTATION_SLOTS = 4;
export const COMBO_WINDOW = 3; // seconds to chain kills

export const MUTATION_DECAY_TIME = 180; // seconds (3 minutes)

export const COLORS = {
  wall: '#1a1a2e',
  floor: '#4a4a6a',
  corridor: '#3a3a5a',
  stairs: '#e0a030',
  background: '#0a0a12',
  player: '#e2e2e2',
  hpBar: '#e53170',
  hpBarBg: '#2a0a15',
  slotEmpty: '#1a1a2e',
  slotBorder: '#444466',
  text: '#ccccdd',
} as const;

export const ELEMENT_COLORS: Record<number, string> = {
  0: '#4488ff', // Iron - blue
  1: '#ff3333', // Carbon - bright red
  2: '#dddd00', // Sulfur - yellow
  3: '#00eedd', // Silicon - cyan
  4: '#33ff66', // Phosphorus - green
  5: '#cc55ff', // Mercury - purple
};

export const ELEMENT_NAMES: Record<number, string> = {
  0: 'Iron',
  1: 'Carbon',
  2: 'Sulfur',
  3: 'Silicon',
  4: 'Phosphorus',
  5: 'Mercury',
};

export const MODIFIER_NAMES: Record<number, string> = {
  0: 'Volatile',
  1: 'Crystalline',
  2: 'Parasitic',
  3: 'Resonant',
  4: 'Feral',
  5: 'Adaptive',
  6: 'Null',
  7: 'Primordial',
};

export const RARITY_NAMES: Record<number, string> = {
  0: 'Common',
  1: 'Uncommon',
  2: 'Rare',
  3: 'Primordial',
};

export const RARITY_GLOW: Record<number, number> = {
  0: 0.3,
  1: 0.6,
  2: 0.9,
  3: 1.3,
};

export const RARITY_COLORS: Record<number, string> = {
  0: '#888899', // Common — grey
  1: '#44cc66', // Uncommon — green
  2: '#4488ff', // Rare — blue
  3: '#ff9900', // Primordial — orange/gold
};

export const RARITY_SIZES: Record<number, number> = {
  0: 0.20,  // Common — smallest
  1: 0.27,  // Uncommon — slightly bigger
  2: 0.33,  // Rare — noticeably bigger
  3: 0.40,  // Primordial — largest
};

export const STATUS_COLORS: Record<number, string> = {
  0: '#88cc22',   // Poison - green
  1: '#ff6622',   // Burn - orange-red
  2: '#9999cc',   // Slow - pale blue
};

export const STATUS_NAMES: Record<number, string> = {
  0: 'Poison',
  1: 'Burn',
  2: 'Slow',
};

export const STATUS_TICK_INTERVAL = 0.5;

export const BUFF_COLORS: Record<number, string> = {
  0: '#ff4444',   // DamageUp - red
  1: '#44ddff',   // SpeedUp - cyan
  2: '#44ff44',   // Regen - green
  3: '#dddd44',   // CooldownDown - yellow
  4: '#8888ff',   // Shield - blue
};

export const BUFF_NAMES: Record<number, string> = {
  0: 'Damage Up',
  1: 'Speed Up',
  2: 'Regen',
  3: 'Quick Cast',
  4: 'Fortify',
};
