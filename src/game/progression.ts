export interface RunRecord {
  floor: number;
  kills: number;
  bossKills: number;
  evolutions: number;
  points: number;
  timestamp: number;
}

export interface MetaProgress {
  totalRuns: number;
  bestFloor: number;
  totalKills: number;
  substratePoints: number;
  upgrades: Record<string, number>;
  discoveredEvolutions: string[];
  runHistory: RunRecord[];
}

export interface UpgradeDef {
  id: string;
  name: string;
  maxLevel: number;
  costPerLevel: number;
  description: (level: number) => string;
}

export const UPGRADES: UpgradeDef[] = [
  {
    id: 'tough',
    name: 'Tough Substrate',
    maxLevel: 5,
    costPerLevel: 3,
    description: (l) => `+${l * 5} starting max HP`,
  },
  {
    id: 'adaptation',
    name: 'Quick Adaptation',
    maxLevel: 3,
    costPerLevel: 5,
    description: (l) => `-${l * 10}s mutation decay`,
  },
  {
    id: 'affinity',
    name: 'Mineral Affinity',
    maxLevel: 3,
    costPerLevel: 4,
    description: (l) => `+${l * 5}% rarity chance`,
  },
  {
    id: 'startmut',
    name: 'Starting Mutation',
    maxLevel: 3,
    costPerLevel: 8,
    description: (l) => `Start with ${['Common', 'Uncommon', 'Rare'][l - 1] || 'Common'} mutation`,
  },
  {
    id: 'tenacity',
    name: 'Tenacity',
    maxLevel: 3,
    costPerLevel: 6,
    description: (l) => `+${l} base tendril damage`,
  },
];

const STORAGE_KEY = 'substrate_meta';

function defaultProgress(): MetaProgress {
  return {
    totalRuns: 0,
    bestFloor: 0,
    totalKills: 0,
    substratePoints: 0,
    upgrades: {},
    discoveredEvolutions: [],
    runHistory: [],
  };
}

export function loadProgress(): MetaProgress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProgress();
    const data = JSON.parse(raw);
    // Merge with defaults to handle missing fields
    return { ...defaultProgress(), ...data };
  } catch {
    return defaultProgress();
  }
}

export function saveProgress(progress: MetaProgress): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // localStorage might be unavailable
  }
}

export function calculateRunReward(
  floor: number,
  kills: number,
  bossesKilled: number,
  evolutionsFound: number,
): number {
  let points = 0;
  points += floor * 2;             // 2 per floor reached
  points += Math.floor(kills / 5); // 1 per 5 kills
  points += bossesKilled * 5;      // 5 per boss
  points += evolutionsFound * 3;   // 3 per evolution discovered
  return Math.max(1, points);      // Always at least 1
}

export function getUpgradeLevel(progress: MetaProgress, upgradeId: string): number {
  return progress.upgrades[upgradeId] || 0;
}

export function canBuyUpgrade(progress: MetaProgress, upgrade: UpgradeDef): boolean {
  const level = getUpgradeLevel(progress, upgrade.id);
  if (level >= upgrade.maxLevel) return false;
  return progress.substratePoints >= upgrade.costPerLevel;
}

export function buyUpgrade(progress: MetaProgress, upgrade: UpgradeDef): boolean {
  if (!canBuyUpgrade(progress, upgrade)) return false;
  progress.substratePoints -= upgrade.costPerLevel;
  progress.upgrades[upgrade.id] = (progress.upgrades[upgrade.id] || 0) + 1;
  return true;
}
