import { MAP_WIDTH, MAP_HEIGHT } from './constants';
import { TileType, RoomType } from './types';
import type { Point, GameMap, DungeonResult, TaggedRoom } from './types';

// ── Seeded PRNG (Mulberry32) ────────────────────────────────────────────────

function createRng(seed: number) {
  let s = seed | 0;
  const next = (): number => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randInt = (min: number, max: number): number =>
    Math.floor(next() * (max - min + 1)) + min;
  const shuffle = <T>(arr: T[]): void => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  };
  return { next, randInt, shuffle };
}
type Rng = ReturnType<typeof createRng>;

// ── Biome System ────────────────────────────────────────────────────────────

const Biome = {
  Excavation: 0,
  FungalCaves: 1,
  CrystalLab: 2,
  Volcanic: 3,
} as const;
type Biome = (typeof Biome)[keyof typeof Biome];

function getBiome(floor: number): Biome {
  const cycle = (floor - 1) % 12;
  if (cycle < 2) return Biome.Excavation;
  if (cycle < 5) return Biome.FungalCaves;
  if (cycle < 8) return Biome.CrystalLab;
  return Biome.Volcanic;
}

// ── Layout Archetype System ─────────────────────────────────────────────────

type LayoutArchetype = 'scattered' | 'ring' | 'hub' | 'linear' | 'cavern' | 'arena';

interface LayoutResult {
  rooms: RoomDef[];
  connections: [number, number][] | null;  // null = use Delaunay/MST, [] = skip corridors (cavern)
  bossRoomIdx: number;                     // -1 if none
}

// Per-biome weight tables: [scattered, ring, hub, linear, cavern, arena]
const ARCHETYPE_LIST: LayoutArchetype[] = ['scattered', 'ring', 'hub', 'linear', 'cavern', 'arena'];
const ARCHETYPE_WEIGHTS: Record<number, number[]> = {
  [Biome.Excavation]:  [0.30, 0.15, 0.15, 0.15, 0.10, 0.15],
  [Biome.FungalCaves]: [0.10, 0.10, 0.10, 0.10, 0.50, 0.10],
  [Biome.CrystalLab]:  [0.25, 0.20, 0.15, 0.15, 0.10, 0.15],
  [Biome.Volcanic]:    [0.25, 0.15, 0.15, 0.20, 0.10, 0.15],
};
const BOSS_ARCHETYPE_WEIGHTS: Record<number, number[]> = {
  [Biome.Excavation]:  [0.10, 0.10, 0.30, 0.10, 0.05, 0.35],
  [Biome.FungalCaves]: [0.05, 0.05, 0.20, 0.05, 0.35, 0.30],
  [Biome.CrystalLab]:  [0.10, 0.10, 0.25, 0.10, 0.05, 0.40],
  [Biome.Volcanic]:    [0.10, 0.10, 0.25, 0.10, 0.05, 0.40],
};

function selectArchetype(rng: Rng, biome: Biome, isBoss: boolean): LayoutArchetype {
  const weights = isBoss ? BOSS_ARCHETYPE_WEIGHTS[biome] : ARCHETYPE_WEIGHTS[biome];
  const roll = rng.next();
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (roll < cumulative) return ARCHETYPE_LIST[i];
  }
  return 'scattered';
}

// ── Utility ─────────────────────────────────────────────────────────────────

type RoomShape = 'rect' | 'circle' | 'cross' | 'L' | 'organic';

interface RoomDef {
  x: number; y: number; width: number; height: number;
  shape: RoomShape;
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < MAP_WIDTH && y >= 0 && y < MAP_HEIGHT;
}

function roomCenter(r: { x: number; y: number; width: number; height: number }): Point {
  return { x: Math.floor(r.x + r.width / 2), y: Math.floor(r.y + r.height / 2) };
}

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function clampRoom(r: RoomDef): void {
  r.x = Math.max(2, Math.min(MAP_WIDTH - r.width - 2, r.x));
  r.y = Math.max(2, Math.min(MAP_HEIGHT - r.height - 2, r.y));
}

function roomsOverlap(a: RoomDef, b: RoomDef, margin: number): boolean {
  return a.x < b.x + b.width + margin && a.x + a.width + margin > b.x &&
         a.y < b.y + b.height + margin && a.y + a.height + margin > b.y;
}

function pickShape(rng: Rng, biome: Biome): RoomShape {
  if (biome === Biome.FungalCaves) return rng.next() < 0.5 ? 'organic' : 'rect';
  if (biome === Biome.CrystalLab) {
    const r = rng.next();
    return r < 0.3 ? 'cross' : r < 0.55 ? 'circle' : 'rect';
  }
  if (biome === Biome.Volcanic) return rng.next() < 0.4 ? 'circle' : 'rect';
  return rng.next() < 0.2 ? 'L' : 'rect';
}

function rollRoomSize(rng: Rng, cycle: number): { w: number; h: number } {
  const sizeRoll = rng.next();
  if (sizeRoll < 0.12) {
    // Closet (12%)
    return { w: rng.randInt(3, 5), h: rng.randInt(3, 5) };
  } else if (sizeRoll > 0.88) {
    // Great hall (12%)
    const max = Math.min(18, 13 + cycle);
    return { w: rng.randInt(12, max), h: rng.randInt(10, max) };
  }
  // Normal (76%)
  const max = Math.min(14, 9 + cycle);
  return { w: rng.randInt(5, max), h: rng.randInt(5, max) };
}

// ── Room Carving ────────────────────────────────────────────────────────────

function carveRoomShape(map: GameMap, room: RoomDef, rng: Rng, isBossArena: boolean): void {
  if (isBossArena) { carveBossArena(map, room, rng); return; }
  switch (room.shape) {
    case 'rect': carveRect(map, room); break;
    case 'circle': carveCircle(map, room); break;
    case 'cross': carveCross(map, room); break;
    case 'L': carveL(map, room, rng); break;
    case 'organic': carveOrganic(map, room, rng); break;
  }
}

function carveRect(map: GameMap, r: RoomDef): void {
  for (let y = r.y; y < r.y + r.height; y++)
    for (let x = r.x; x < r.x + r.width; x++)
      if (inBounds(x, y)) map[y][x] = TileType.Floor;
}

function carveCircle(map: GameMap, r: RoomDef): void {
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const rx = r.width / 2 - 0.5, ry = r.height / 2 - 0.5;
  for (let y = r.y; y < r.y + r.height; y++)
    for (let x = r.x; x < r.x + r.width; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1.0 && inBounds(x, y)) map[y][x] = TileType.Floor;
    }
}

function carveCross(map: GameMap, r: RoomDef): void {
  const armH = Math.max(3, Math.floor(r.height * 0.45));
  const armW = Math.max(3, Math.floor(r.width * 0.45));
  const hY = r.y + Math.floor((r.height - armH) / 2);
  for (let y = hY; y < hY + armH; y++)
    for (let x = r.x; x < r.x + r.width; x++)
      if (inBounds(x, y)) map[y][x] = TileType.Floor;
  const vX = r.x + Math.floor((r.width - armW) / 2);
  for (let y = r.y; y < r.y + r.height; y++)
    for (let x = vX; x < vX + armW; x++)
      if (inBounds(x, y)) map[y][x] = TileType.Floor;
}

function carveL(map: GameMap, r: RoomDef, rng: Rng): void {
  const halfW = Math.max(3, Math.floor(r.width * 0.55));
  const halfH = Math.max(3, Math.floor(r.height * 0.55));
  const corner = rng.randInt(0, 3);
  const hx = (corner === 0 || corner === 2) ? r.x : r.x + r.width - halfW;
  const hy = (corner === 0 || corner === 1) ? r.y : r.y + r.height - halfH;
  for (let y = hy; y < hy + halfH; y++)
    for (let x = r.x; x < r.x + r.width; x++)
      if (inBounds(x, y)) map[y][x] = TileType.Floor;
  for (let y = r.y; y < r.y + r.height; y++)
    for (let x = hx; x < hx + halfW; x++)
      if (inBounds(x, y)) map[y][x] = TileType.Floor;
}

function carveOrganic(map: GameMap, r: RoomDef, rng: Rng): void {
  const w = r.width, h = r.height;
  let grid: boolean[][] = Array.from({ length: h }, () =>
    Array.from({ length: w }, () => rng.next() < 0.55)
  );
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const ny = cy + dy, nx = cx + dx;
      if (ny >= 0 && ny < h && nx >= 0 && nx < w) grid[ny][nx] = true;
    }
  for (let iter = 0; iter < 4; iter++) {
    const next = grid.map(row => [...row]);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        let neighbors = 0;
        for (let dy2 = -1; dy2 <= 1; dy2++)
          for (let dx2 = -1; dx2 <= 1; dx2++)
            if (!(dx2 === 0 && dy2 === 0) && grid[y + dy2][x + dx2]) neighbors++;
        next[y][x] = grid[y][x] ? neighbors >= 4 : neighbors >= 5;
      }
    grid = next;
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (grid[y][x] && inBounds(r.x + x, r.y + y)) map[r.y + y][r.x + x] = TileType.Floor;
}

function carveBossArena(map: GameMap, r: RoomDef, rng: Rng): void {
  carveRect(map, r);
  const cx = r.x + Math.floor(r.width / 2), cy = r.y + Math.floor(r.height / 2);
  const pdx = Math.max(2, Math.floor(r.width / 4)), pdy = Math.max(2, Math.floor(r.height / 4));
  const offsets = [[-pdx, -pdy], [pdx - 1, -pdy], [-pdx, pdy - 1], [pdx - 1, pdy - 1]];
  for (const [ox, oy] of offsets)
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++)
        if (inBounds(cx + ox + dx, cy + oy + dy))
          map[cy + oy + dy][cx + ox + dx] = TileType.Wall;
  if (rng.next() < 0.3 && inBounds(cx, cy)) map[cy][cx] = TileType.Wall;
}

// ── Layout: Scattered (original algorithm) ──────────────────────────────────

function layoutScattered(rng: Rng, biome: Biome, floor: number, isBoss: boolean): LayoutResult {
  const cycle = Math.floor((floor - 1) / 12);
  const baseCount = 6 + Math.min(cycle * 2, 6);
  const targetCount = baseCount + rng.randInt(0, 2);
  const rooms: RoomDef[] = [];
  const MARGIN = 3;
  let greatHalls = 0;

  for (let attempt = 0; attempt < targetCount * 30 && rooms.length < targetCount; attempt++) {
    const { w, h } = rollRoomSize(rng, cycle);
    if (w >= 12 && greatHalls >= 1) continue; // max 1 great hall
    const x = rng.randInt(2, MAP_WIDTH - w - 2);
    const y = rng.randInt(2, MAP_HEIGHT - h - 2);
    const room: RoomDef = { x, y, width: w, height: h, shape: pickShape(rng, biome) };
    if (rooms.some(r => roomsOverlap(r, room, MARGIN))) continue;
    rooms.push(room);
    if (w >= 12) greatHalls++;
  }

  let bossRoomIdx = -1;
  if (isBoss && rooms.length > 2) {
    let bestArea = 0;
    for (let i = 1; i < rooms.length; i++) {
      const area = rooms[i].width * rooms[i].height;
      if (area > bestArea) { bestArea = area; bossRoomIdx = i; }
    }
    const r = rooms[bossRoomIdx];
    r.width = Math.max(r.width, 12); r.height = Math.max(r.height, 12);
    clampRoom(r);
    r.shape = 'rect';
  }

  return { rooms, connections: null, bossRoomIdx };
}

// ── Layout: Ring ────────────────────────────────────────────────────────────

function layoutRing(rng: Rng, biome: Biome, floor: number, isBoss: boolean): LayoutResult {
  const cycle = Math.floor((floor - 1) / 12);
  const count = 6 + rng.randInt(0, 3);
  const rooms: RoomDef[] = [];
  const connections: [number, number][] = [];

  const centerX = MAP_WIDTH / 2 + rng.randInt(-4, 4);
  const centerY = MAP_HEIGHT / 2 + rng.randInt(-3, 3);
  const radiusX = MAP_WIDTH * 0.28 + rng.next() * 4;
  const radiusY = MAP_HEIGHT * 0.28 + rng.next() * 3;

  // Place rooms around ellipse
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (rng.next() - 0.5) * 0.4;
    const { w, h } = (i === 0 || (isBoss && i === Math.floor(count / 2)))
      ? { w: rng.randInt(7, 10), h: rng.randInt(7, 10) }
      : rollRoomSize(rng, cycle);
    const rx = Math.round(centerX + Math.cos(angle) * radiusX - w / 2);
    const ry = Math.round(centerY + Math.sin(angle) * radiusY - h / 2);
    const room: RoomDef = { x: rx, y: ry, width: w, height: h, shape: pickShape(rng, biome) };
    clampRoom(room);
    rooms.push(room);
  }

  // Ring connections
  for (let i = 0; i < count; i++) {
    connections.push([i, (i + 1) % count]);
  }

  // 1-2 cross-connections through center
  const crossCount = 1 + (rng.next() < 0.5 ? 1 : 0);
  for (let c = 0; c < crossCount && count >= 5; c++) {
    const a = rng.randInt(0, count - 1);
    const b = (a + Math.floor(count / 2) + rng.randInt(-1, 1) + count) % count;
    if (a !== b) connections.push([Math.min(a, b), Math.max(a, b)]);
  }

  // Optional interior room
  if (rng.next() < 0.4 && count >= 5) {
    const { w, h } = { w: rng.randInt(5, 8), h: rng.randInt(5, 8) };
    const ir: RoomDef = {
      x: Math.round(centerX - w / 2), y: Math.round(centerY - h / 2),
      width: w, height: h, shape: pickShape(rng, biome),
    };
    clampRoom(ir);
    const idx = rooms.length;
    rooms.push(ir);
    connections.push([idx, 0]);
    connections.push([idx, Math.floor(count / 2)]);
  }

  let bossRoomIdx = -1;
  if (isBoss && rooms.length > 2) {
    bossRoomIdx = Math.floor(count / 2); // opposite side of start
    const r = rooms[bossRoomIdx];
    r.width = Math.max(r.width, 12); r.height = Math.max(r.height, 12);
    clampRoom(r);
    r.shape = 'rect';
  }

  return { rooms, connections, bossRoomIdx };
}

// ── Layout: Hub-and-Spoke ───────────────────────────────────────────────────

function layoutHub(rng: Rng, biome: Biome, floor: number, isBoss: boolean): LayoutResult {
  const rooms: RoomDef[] = [];
  const connections: [number, number][] = [];
  const spokeCount = 5 + rng.randInt(0, 3);

  // Hub room (index 0 won't be start — we'll swap later)
  const hubW = rng.randInt(10, 16);
  const hubH = rng.randInt(8, 14);
  const hub: RoomDef = {
    x: Math.round(MAP_WIDTH / 2 - hubW / 2) + rng.randInt(-3, 3),
    y: Math.round(MAP_HEIGHT / 2 - hubH / 2) + rng.randInt(-2, 2),
    width: hubW, height: hubH, shape: biome === Biome.CrystalLab ? 'cross' : 'rect',
  };
  clampRoom(hub);

  // Start room is first spoke, hub is second. Swap so rooms[0] = start.
  // We'll build: [start_spoke, hub, spoke2, spoke3, ...]
  const spokes: RoomDef[] = [];
  const spokeDistance = 16 + rng.randInt(0, 8);

  for (let i = 0; i < spokeCount; i++) {
    const angle = (i / spokeCount) * Math.PI * 2 + (rng.next() - 0.5) * 0.3;
    const { w, h } = rollRoomSize(rng, Math.floor((floor - 1) / 12));
    const sx = Math.round(hub.x + hubW / 2 + Math.cos(angle) * spokeDistance - w / 2);
    const sy = Math.round(hub.y + hubH / 2 + Math.sin(angle) * spokeDistance - h / 2);
    const spoke: RoomDef = { x: sx, y: sy, width: w, height: h, shape: pickShape(rng, biome) };
    clampRoom(spoke);
    spokes.push(spoke);
  }

  // rooms = [start_spoke, hub, rest_of_spokes...]
  rooms.push(spokes[0]);  // index 0 = start
  rooms.push(hub);        // index 1 = hub
  for (let i = 1; i < spokes.length; i++) rooms.push(spokes[i]);

  // All spokes connect to hub (index 1)
  connections.push([0, 1]); // start → hub
  for (let i = 1; i < spokes.length; i++) {
    connections.push([i + 1, 1]); // spoke → hub
  }

  // Adjacent spoke-to-spoke connections (40% each)
  for (let i = 0; i < spokeCount; i++) {
    if (rng.next() < 0.4) {
      const a = i === 0 ? 0 : i + 1;
      const b = ((i + 1) % spokeCount) === 0 ? 0 : ((i + 1) % spokeCount) + 1;
      if (a !== b) connections.push([Math.min(a, b), Math.max(a, b)]);
    }
  }

  let bossRoomIdx = -1;
  if (isBoss) {
    bossRoomIdx = 1; // hub = boss arena
    rooms[1].width = Math.max(rooms[1].width, 12);
    rooms[1].height = Math.max(rooms[1].height, 12);
    clampRoom(rooms[1]);
    rooms[1].shape = 'rect';
  }

  return { rooms, connections, bossRoomIdx };
}

// ── Layout: Linear Gauntlet ─────────────────────────────────────────────────

function layoutLinear(rng: Rng, biome: Biome, floor: number, isBoss: boolean): LayoutResult {
  const cycle = Math.floor((floor - 1) / 12);
  const rooms: RoomDef[] = [];
  const connections: [number, number][] = [];
  const mainCount = 6 + rng.randInt(0, 3);

  // Pick start and end corners
  const corners: Point[] = [
    { x: 8, y: 6 }, { x: MAP_WIDTH - 12, y: 6 },
    { x: 8, y: MAP_HEIGHT - 10 }, { x: MAP_WIDTH - 12, y: MAP_HEIGHT - 10 },
  ];
  const startCorner = corners[rng.randInt(0, 3)];
  // End is diagonal opposite
  const endCorner = {
    x: startCorner.x < MAP_WIDTH / 2 ? MAP_WIDTH - 12 : 8,
    y: startCorner.y < MAP_HEIGHT / 2 ? MAP_HEIGHT - 10 : 6,
  };

  // Generate waypoints along a meandering path
  for (let i = 0; i < mainCount; i++) {
    const t = i / (mainCount - 1);
    const baseX = startCorner.x + (endCorner.x - startCorner.x) * t;
    const baseY = startCorner.y + (endCorner.y - startCorner.y) * t;
    // Perpendicular offset for meandering
    const perpX = -(endCorner.y - startCorner.y);
    const perpY = endCorner.x - startCorner.x;
    const perpLen = Math.sqrt(perpX * perpX + perpY * perpY) || 1;
    const offset = (rng.next() - 0.5) * 16;
    const wx = Math.round(baseX + (perpX / perpLen) * offset);
    const wy = Math.round(baseY + (perpY / perpLen) * offset);

    const { w, h } = (i === 0 || i === mainCount - 1)
      ? { w: rng.randInt(7, 10), h: rng.randInt(7, 10) }
      : rollRoomSize(rng, cycle);
    const room: RoomDef = { x: wx - Math.floor(w / 2), y: wy - Math.floor(h / 2), width: w, height: h, shape: pickShape(rng, biome) };
    clampRoom(room);
    rooms.push(room);
  }

  // Sequential connections
  for (let i = 0; i < mainCount - 1; i++) {
    connections.push([i, i + 1]);
  }

  // 1-2 branch rooms off main path
  let branches = 0;
  for (let i = 1; i < mainCount - 1 && branches < 2; i++) {
    if (rng.next() < 0.4) {
      const mainRoom = rooms[i];
      const mc = roomCenter(mainRoom);
      const angle = rng.next() * Math.PI * 2;
      const branchDist = 12 + rng.randInt(0, 5);
      const bw = rng.randInt(5, 8), bh = rng.randInt(5, 8);
      const br: RoomDef = {
        x: Math.round(mc.x + Math.cos(angle) * branchDist - bw / 2),
        y: Math.round(mc.y + Math.sin(angle) * branchDist - bh / 2),
        width: bw, height: bh, shape: pickShape(rng, biome),
      };
      clampRoom(br);
      const brIdx = rooms.length;
      rooms.push(br);
      connections.push([i, brIdx]);
      branches++;
    }
  }

  let bossRoomIdx = -1;
  if (isBoss && mainCount >= 4) {
    bossRoomIdx = Math.floor(mainCount / 2);
    const r = rooms[bossRoomIdx];
    r.width = Math.max(r.width, 12); r.height = Math.max(r.height, 12);
    clampRoom(r);
    r.shape = 'rect';
  }

  return { rooms, connections, bossRoomIdx };
}

// ── Layout: Cavern ──────────────────────────────────────────────────────────

function layoutCavern(_rng: Rng, _biome: Biome, _floor: number, isBoss: boolean): LayoutResult {
  // Cavern: generateDungeon will call carveCavernAndIdentifyRooms instead
  return { rooms: [], connections: [], bossRoomIdx: isBoss ? 1 : -1 };
}

function carveCavernAndIdentifyRooms(map: GameMap, rng: Rng, isBoss: boolean): RoomDef[] {
  // 1. Cellular automata cave generation
  const grid: boolean[][] = Array.from({ length: MAP_HEIGHT }, (_, y) =>
    Array.from({ length: MAP_WIDTH }, (_, x) => {
      if (x <= 1 || x >= MAP_WIDTH - 2 || y <= 1 || y >= MAP_HEIGHT - 2) return false;
      return rng.next() < 0.45;
    })
  );

  // 5 iterations of smoothing (B5678/S45678)
  for (let iter = 0; iter < 5; iter++) {
    const next = grid.map(row => [...row]);
    for (let y = 2; y < MAP_HEIGHT - 2; y++) {
      for (let x = 2; x < MAP_WIDTH - 2; x++) {
        let neighbors = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (grid[y + dy][x + dx]) neighbors++;
        next[y][x] = neighbors >= 5;
      }
    }
    grid[0] = next[0]; // copy rows
    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        grid[y][x] = next[y][x];
      }
    }
  }

  // Ensure 2-tile wall border
  for (let y = 0; y < MAP_HEIGHT; y++)
    for (let x = 0; x < MAP_WIDTH; x++)
      if (x <= 1 || x >= MAP_WIDTH - 2 || y <= 1 || y >= MAP_HEIGHT - 2)
        grid[y][x] = false;

  // 2. Flood-fill to find largest connected region
  const regionId = new Int32Array(MAP_WIDTH * MAP_HEIGHT).fill(-1);
  let maxRegion = -1, maxRegionSize = 0;
  let currentRegion = 0;

  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (!grid[y][x] || regionId[y * MAP_WIDTH + x] >= 0) continue;
      // BFS flood fill
      const queue: number[] = [y * MAP_WIDTH + x];
      regionId[y * MAP_WIDTH + x] = currentRegion;
      let size = 0;
      while (queue.length > 0) {
        const k = queue.shift()!;
        size++;
        const cx = k % MAP_WIDTH, cy = Math.floor(k / MAP_WIDTH);
        for (const [ddx, ddy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          const nx = cx + ddx, ny = cy + ddy;
          if (!inBounds(nx, ny) || !grid[ny][nx]) continue;
          const nk = ny * MAP_WIDTH + nx;
          if (regionId[nk] >= 0) continue;
          regionId[nk] = currentRegion;
          queue.push(nk);
        }
      }
      if (size > maxRegionSize) { maxRegionSize = size; maxRegion = currentRegion; }
      currentRegion++;
    }
  }

  // Apply to map: only largest region becomes floor
  for (let y = 0; y < MAP_HEIGHT; y++)
    for (let x = 0; x < MAP_WIDTH; x++)
      if (regionId[y * MAP_WIDTH + x] === maxRegion)
        map[y][x] = TileType.Floor;

  // 3. Identify chambers: find clusters of open space
  const visited = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  const chambers: { x: number; y: number; width: number; height: number }[] = [];

  for (let y = 3; y < MAP_HEIGHT - 3; y++) {
    for (let x = 3; x < MAP_WIDTH - 3; x++) {
      if (map[y][x] !== TileType.Floor || visited[y * MAP_WIDTH + x]) continue;

      // Check if this is an "open" area (at least 3x3 of floor)
      let isOpen = true;
      for (let dy = -1; dy <= 1 && isOpen; dy++)
        for (let dx = -1; dx <= 1 && isOpen; dx++)
          if (map[y + dy][x + dx] !== TileType.Floor) isOpen = false;
      if (!isOpen) continue;

      // Flood-fill this open area to find the chamber
      const chamberTiles: Point[] = [];
      const cq: number[] = [y * MAP_WIDTH + x];
      visited[y * MAP_WIDTH + x] = 1;
      while (cq.length > 0) {
        const k = cq.shift()!;
        const cx = k % MAP_WIDTH, cy = Math.floor(k / MAP_WIDTH);
        chamberTiles.push({ x: cx, y: cy });
        for (const [ddx, ddy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          const nx = cx + ddx, ny = cy + ddy;
          if (!inBounds(nx, ny) || visited[ny * MAP_WIDTH + nx]) continue;
          if (map[ny][nx] !== TileType.Floor) continue;
          // Check openness: at least 2 floor neighbors
          let floorNeighbors = 0;
          for (const [dx2, dy2] of [[0, -1], [0, 1], [-1, 0], [1, 0]])
            if (inBounds(nx + dx2, ny + dy2) && map[ny + dy2][nx + dx2] === TileType.Floor) floorNeighbors++;
          if (floorNeighbors < 2) continue;
          visited[ny * MAP_WIDTH + nx] = 1;
          cq.push(ny * MAP_WIDTH + nx);
        }
      }

      // Only register as chamber if large enough
      if (chamberTiles.length < 16) continue;

      // Compute bounding box
      let minX = MAP_WIDTH, minY = MAP_HEIGHT, maxX = 0, maxY = 0;
      for (const t of chamberTiles) {
        if (t.x < minX) minX = t.x;
        if (t.y < minY) minY = t.y;
        if (t.x > maxX) maxX = t.x;
        if (t.y > maxY) maxY = t.y;
      }
      chambers.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
    }
  }

  // Sort by position (top-left to bottom-right) for consistency
  chambers.sort((a, b) => (a.y + a.x * 0.1) - (b.y + b.x * 0.1));

  // Convert to RoomDefs
  const rooms: RoomDef[] = chambers.slice(0, 12).map(c => ({
    x: c.x, y: c.y, width: Math.min(c.width, 20), height: Math.min(c.height, 16),
    shape: 'organic' as RoomShape,
  }));

  // Boss floor: expand the largest chamber
  if (isBoss && rooms.length > 1) {
    let bestIdx = 1, bestArea = 0;
    for (let i = 1; i < rooms.length; i++) {
      const area = rooms[i].width * rooms[i].height;
      if (area > bestArea) { bestArea = area; bestIdx = i; }
    }
    // Just tag it; the cave already carved the space
    rooms[bestIdx].shape = 'rect';
  }

  return rooms;
}

// ── Layout: Arena ───────────────────────────────────────────────────────────

function layoutArena(rng: Rng, biome: Biome, _floor: number, isBoss: boolean): LayoutResult {
  const rooms: RoomDef[] = [];
  const connections: [number, number][] = [];

  // Large central arena
  const arenaW = rng.randInt(18, 24);
  const arenaH = rng.randInt(14, 18);
  const arena: RoomDef = {
    x: Math.round(MAP_WIDTH / 2 - arenaW / 2) + rng.randInt(-2, 2),
    y: Math.round(MAP_HEIGHT / 2 - arenaH / 2) + rng.randInt(-2, 2),
    width: arenaW, height: arenaH, shape: 'rect',
  };
  clampRoom(arena);

  // Antechamber rooms around the arena
  const antechamberCount = 4 + rng.randInt(0, 2);
  const antechambers: RoomDef[] = [];

  for (let i = 0; i < antechamberCount; i++) {
    const angle = (i / antechamberCount) * Math.PI * 2 + (rng.next() - 0.5) * 0.5;
    const dist = Math.max(arenaW, arenaH) / 2 + 5 + rng.randInt(0, 4);
    const aw = rng.randInt(5, 8), ah = rng.randInt(5, 8);
    const ac: RoomDef = {
      x: Math.round(arena.x + arenaW / 2 + Math.cos(angle) * dist - aw / 2),
      y: Math.round(arena.y + arenaH / 2 + Math.sin(angle) * dist - ah / 2),
      width: aw, height: ah, shape: pickShape(rng, biome),
    };
    clampRoom(ac);
    antechambers.push(ac);
  }

  // rooms[0] = first antechamber (start), rooms[1] = arena, rooms[2..] = other antechambers
  rooms.push(antechambers[0]);
  rooms.push(arena);
  for (let i = 1; i < antechambers.length; i++) rooms.push(antechambers[i]);

  // All antechambers connect to arena
  connections.push([0, 1]); // start → arena
  for (let i = 1; i < antechambers.length; i++) connections.push([i + 1, 1]);

  // Adjacent antechambers connect to each other (partial ring)
  for (let i = 0; i < antechamberCount - 1; i++) {
    if (rng.next() < 0.3) {
      const a = i === 0 ? 0 : i + 1;
      const b = i + 2;
      if (b < rooms.length) connections.push([a, b]);
    }
  }

  const bossRoomIdx = isBoss ? 1 : -1; // arena is always boss room on boss floors

  return { rooms, connections, bossRoomIdx };
}

function carveArenaStructures(map: GameMap, arena: RoomDef, rng: Rng, biome: Biome): void {
  // Pillar grid
  const spacing = 4 + rng.randInt(0, 1);
  for (let y = arena.y + 2; y < arena.y + arena.height - 2; y += spacing) {
    for (let x = arena.x + 2; x < arena.x + arena.width - 2; x += spacing) {
      if (rng.next() < 0.6 && inBounds(x, y)) { // 60% of pillars remain
        map[y][x] = TileType.Wall;
        if (inBounds(x + 1, y)) map[y][x + 1] = TileType.Wall;
        if (inBounds(x, y + 1)) map[y + 1][x] = TileType.Wall;
        if (inBounds(x + 1, y + 1)) map[y + 1][x + 1] = TileType.Wall;
      }
    }
  }

  // Moat (30% chance)
  if (rng.next() < 0.3) {
    const moatType = biome === Biome.Volcanic ? TileType.Lava : TileType.Water;
    const inset = 2;
    // Top and bottom edges
    for (let x = arena.x + inset; x < arena.x + arena.width - inset; x++) {
      if (rng.next() < 0.8) { // leave some gaps (bridges)
        if (inBounds(x, arena.y + inset)) map[arena.y + inset][x] = moatType;
        if (inBounds(x, arena.y + arena.height - inset - 1)) map[arena.y + arena.height - inset - 1][x] = moatType;
      }
    }
    // Left and right edges
    for (let y = arena.y + inset; y < arena.y + arena.height - inset; y++) {
      if (rng.next() < 0.8) {
        if (inBounds(arena.x + inset, y)) map[y][arena.x + inset] = moatType;
        if (inBounds(arena.x + arena.width - inset - 1, y)) map[y][arena.x + arena.width - inset - 1] = moatType;
      }
    }
  }

  // Wall islands (25% chance, 1-2 islands)
  if (rng.next() < 0.25) {
    const islandCount = rng.randInt(1, 2);
    for (let i = 0; i < islandCount; i++) {
      const ix = arena.x + rng.randInt(4, arena.width - 6);
      const iy = arena.y + rng.randInt(4, arena.height - 6);
      for (let dy = 0; dy < 3; dy++)
        for (let dx = 0; dx < 3; dx++)
          if (inBounds(ix + dx, iy + dy) && rng.next() < 0.7)
            map[iy + dy][ix + dx] = TileType.Wall;
    }
  }
}

// ── Delaunay Triangulation (Bowyer-Watson) ──────────────────────────────────

interface Tri { a: number; b: number; c: number; }

function circumcircleContains(points: Point[], tri: Tri, p: Point): boolean {
  const ax = points[tri.a].x, ay = points[tri.a].y;
  const bx = points[tri.b].x, by = points[tri.b].y;
  const cx2 = points[tri.c].x, cy2 = points[tri.c].y;
  const d = 2 * (ax * (by - cy2) + bx * (cy2 - ay) + cx2 * (ay - by));
  if (Math.abs(d) < 1e-10) return false;
  const ux = ((ax * ax + ay * ay) * (by - cy2) + (bx * bx + by * by) * (cy2 - ay) + (cx2 * cx2 + cy2 * cy2) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx2 - bx) + (bx * bx + by * by) * (ax - cx2) + (cx2 * cx2 + cy2 * cy2) * (bx - ax)) / d;
  const dx = ax - ux, dy = ay - uy;
  const r2 = dx * dx + dy * dy;
  const pdx = p.x - ux, pdy = p.y - uy;
  return pdx * pdx + pdy * pdy <= r2;
}

function delaunayTriangulation(points: Point[]): [number, number][] {
  if (points.length < 2) return [];
  if (points.length === 2) return [[0, 1]];
  if (points.length === 3) return [[0, 1], [1, 2], [0, 2]];

  const n = points.length;
  const superPts: Point[] = [
    { x: -MAP_WIDTH * 2, y: -MAP_HEIGHT * 2 },
    { x: MAP_WIDTH * 3, y: -MAP_HEIGHT * 2 },
    { x: MAP_WIDTH / 2, y: MAP_HEIGHT * 4 },
  ];
  const allPts = [...points, ...superPts];
  const s0 = n, s1 = n + 1, s2 = n + 2;
  let triangles: Tri[] = [{ a: s0, b: s1, c: s2 }];

  for (let i = 0; i < n; i++) {
    const p = allPts[i];
    const bad: Tri[] = [];
    for (const tri of triangles)
      if (circumcircleContains(allPts, tri, p)) bad.push(tri);

    const edges: [number, number][] = [];
    for (const tri of bad) {
      const triEdges: [number, number][] = [[tri.a, tri.b], [tri.b, tri.c], [tri.c, tri.a]];
      for (const [ea, eb] of triEdges) {
        const shared = bad.some(other =>
          other !== tri && (other.a === ea || other.b === ea || other.c === ea) &&
          (other.a === eb || other.b === eb || other.c === eb)
        );
        if (!shared) edges.push([ea, eb]);
      }
    }
    triangles = triangles.filter(t => !bad.includes(t));
    for (const [ea, eb] of edges) triangles.push({ a: ea, b: eb, c: i });
  }

  triangles = triangles.filter(t => t.a < n && t.b < n && t.c < n);
  const edgeSet = new Set<string>();
  const result: [number, number][] = [];
  for (const t of triangles) {
    for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.a, t.c]] as [number, number][]) {
      const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); result.push([Math.min(a, b), Math.max(a, b)]); }
    }
  }
  return result;
}

// ── Minimum Spanning Tree (Prim's) ─────────────────────────────────────────

function minimumSpanningTree(points: Point[], edges: [number, number][]): [number, number][] {
  if (points.length <= 1) return [];
  const n = points.length;
  const inMST = new Array(n).fill(false);
  inMST[0] = true;
  const mst: [number, number][] = [];

  const adj: Map<number, { to: number; weight: number }[]> = new Map();
  for (let i = 0; i < n; i++) adj.set(i, []);
  for (const [a, b] of edges) {
    const w = dist(points[a], points[b]);
    adj.get(a)!.push({ to: b, weight: w });
    adj.get(b)!.push({ to: a, weight: w });
  }

  for (let count = 0; count < n - 1; count++) {
    let bestWeight = Infinity;
    let bestEdge: [number, number] | null = null;
    for (let i = 0; i < n; i++) {
      if (!inMST[i]) continue;
      for (const e of adj.get(i)!) {
        if (!inMST[e.to] && e.weight < bestWeight) { bestWeight = e.weight; bestEdge = [i, e.to]; }
      }
    }
    if (bestEdge) { inMST[bestEdge[1]] = true; mst.push([Math.min(bestEdge[0], bestEdge[1]), Math.max(bestEdge[0], bestEdge[1])]); }
  }

  for (let i = 0; i < n; i++) {
    if (!inMST[i]) {
      let nearest = 0, nearestDist = Infinity;
      for (let j = 0; j < n; j++) {
        if (inMST[j]) { const d = dist(points[i], points[j]); if (d < nearestDist) { nearestDist = d; nearest = j; } }
      }
      inMST[i] = true;
      mst.push([Math.min(i, nearest), Math.max(i, nearest)]);
    }
  }
  return mst;
}

function addLoopEdges(rng: Rng, mst: [number, number][], allEdges: [number, number][], fraction: number): [number, number][] {
  const mstSet = new Set(mst.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`));
  const extras = allEdges.filter(([a, b]) => !mstSet.has(`${Math.min(a, b)}-${Math.max(a, b)}`));
  rng.shuffle(extras);
  return [...mst, ...extras.slice(0, Math.ceil(extras.length * fraction))];
}

// ── Corridor Algorithms ─────────────────────────────────────────────────────

function carveCorridorL(map: GameMap, a: Point, b: Point, rng: Rng, wide: boolean): void {
  let x = a.x, y = a.y;
  const width = wide ? 2 : 1;
  const setTile = (tx: number, ty: number) => {
    if (inBounds(tx, ty) && map[ty][tx] === TileType.Wall) map[ty][tx] = TileType.Corridor;
  };

  if (rng.next() > 0.5) {
    while (x !== b.x) { for (let w = 0; w < width; w++) setTile(x, y + w); x += x < b.x ? 1 : -1; }
    while (y !== b.y) { for (let w = 0; w < width; w++) setTile(x + w, y); y += y < b.y ? 1 : -1; }
  } else {
    while (y !== b.y) { for (let w = 0; w < width; w++) setTile(x + w, y); y += y < b.y ? 1 : -1; }
    while (x !== b.x) { for (let w = 0; w < width; w++) setTile(x, y + w); x += x < b.x ? 1 : -1; }
  }
  setTile(b.x, b.y);
}

function carveCorridorDrunk(map: GameMap, a: Point, b: Point, rng: Rng): void {
  let x = a.x, y = a.y;
  let maxSteps = MAP_WIDTH * 3;
  while ((x !== b.x || y !== b.y) && maxSteps-- > 0) {
    if (inBounds(x, y) && map[y][x] === TileType.Wall) map[y][x] = TileType.Corridor;
    if (rng.next() < 0.65) {
      if (rng.next() < 0.5 && x !== b.x) x += x < b.x ? 1 : -1;
      else if (y !== b.y) y += y < b.y ? 1 : -1;
      else x += x < b.x ? 1 : -1;
    } else {
      if (rng.next() < 0.5) x += rng.next() < 0.5 ? 1 : -1;
      else y += rng.next() < 0.5 ? 1 : -1;
    }
    x = Math.max(1, Math.min(MAP_WIDTH - 2, x));
    y = Math.max(1, Math.min(MAP_HEIGHT - 2, y));
  }
  if (inBounds(b.x, b.y) && map[b.y][b.x] === TileType.Wall) map[b.y][b.x] = TileType.Corridor;
}

function carveCorridorWinding(map: GameMap, a: Point, b: Point, rng: Rng): void {
  const W = MAP_WIDTH, H = MAP_HEIGHT;
  const costMap = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      costMap[y * W + x] = (map[y][x] === TileType.Wall) ? 1 + rng.next() * 3 : 8;

  const INF = 1e9;
  const gCost = new Float32Array(W * H).fill(INF);
  const from = new Int32Array(W * H).fill(-1);
  const visited = new Uint8Array(W * H);
  const startK = a.y * W + a.x;
  const goalK = b.y * W + b.x;
  gCost[startK] = 0;

  const openList: number[] = [startK];
  let maxIter = 3000;

  while (openList.length > 0 && maxIter-- > 0) {
    let bestIdx = 0;
    for (let i = 1; i < openList.length; i++)
      if (gCost[openList[i]] < gCost[openList[bestIdx]]) bestIdx = i;
    const cur = openList[bestIdx];
    openList.splice(bestIdx, 1);

    if (cur === goalK) break;
    if (visited[cur]) continue;
    visited[cur] = 1;

    const cx = cur % W, cy = Math.floor(cur / W);
    for (const [ddx, ddy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = cx + ddx, ny = cy + ddy;
      if (nx < 1 || nx >= W - 1 || ny < 1 || ny >= H - 1) continue;
      const nk = ny * W + nx;
      if (visited[nk]) continue;
      const ng = gCost[cur] + costMap[nk];
      if (ng < gCost[nk]) { gCost[nk] = ng; from[nk] = cur; openList.push(nk); }
    }
  }

  let cur = goalK;
  while (cur !== startK && cur !== -1) {
    const cx = cur % W, cy = Math.floor(cur / W);
    if (map[cy][cx] === TileType.Wall) map[cy][cx] = TileType.Corridor;
    cur = from[cur];
  }
}

function carveConnection(map: GameMap, a: Point, b: Point, rng: Rng, biome: Biome, isMainPath: boolean): void {
  switch (biome) {
    case Biome.Excavation: carveCorridorL(map, a, b, rng, isMainPath); break;
    case Biome.FungalCaves: carveCorridorDrunk(map, a, b, rng); break;
    case Biome.CrystalLab: carveCorridorWinding(map, a, b, rng); break;
    case Biome.Volcanic: carveCorridorL(map, a, b, rng, true); break;
  }
}

// ── Corridor Vestibules ─────────────────────────────────────────────────────

function carveVestibules(map: GameMap, rng: Rng): void {
  const candidates: Point[] = [];
  for (let y = 3; y < MAP_HEIGHT - 3; y++) {
    for (let x = 3; x < MAP_WIDTH - 3; x++) {
      if (map[y][x] !== TileType.Corridor) continue;
      let openNeighbors = 0;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]])
        if (map[y + dy][x + dx] === TileType.Corridor || map[y + dy][x + dx] === TileType.Floor) openNeighbors++;
      if (openNeighbors >= 3 && rng.next() < 0.25) candidates.push({ x, y });
    }
  }
  for (const p of candidates) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (inBounds(p.x + dx, p.y + dy) && map[p.y + dy][p.x + dx] === TileType.Wall)
          map[p.y + dy][p.x + dx] = TileType.Corridor;
  }
}

// ── Biome Post-Processing ───────────────────────────────────────────────────

function postProcessFungal(map: GameMap, rng: Rng): void {
  const changes: Point[] = [];
  for (let y = 1; y < MAP_HEIGHT - 1; y++) {
    for (let x = 1; x < MAP_WIDTH - 1; x++) {
      if (map[y][x] !== TileType.Wall) continue;
      let openCount = 0;
      if (map[y - 1][x] !== TileType.Wall) openCount++;
      if (map[y + 1][x] !== TileType.Wall) openCount++;
      if (map[y][x - 1] !== TileType.Wall) openCount++;
      if (map[y][x + 1] !== TileType.Wall) openCount++;
      if (openCount >= 2 && rng.next() < 0.25) changes.push({ x, y });
    }
  }
  for (const p of changes) map[p.y][p.x] = TileType.Floor;
}

function postProcessCrystal(map: GameMap, rng: Rng): void {
  const visited = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);

  for (let sy = 2; sy < MAP_HEIGHT - 2; sy += 2) {
    for (let sx = 2; sx < MAP_WIDTH - 2; sx += 2) {
      if (map[sy][sx] !== TileType.Wall || visited[sy * MAP_WIDTH + sx]) continue;
      let wallCount = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (inBounds(sx + dx, sy + dy) && map[sy + dy][sx + dx] === TileType.Wall) wallCount++;
      if (wallCount < 20) continue;
      if (rng.next() > 0.25) continue; // 25% chance (up from 15%)

      const stack: Point[] = [{ x: sx, y: sy }];
      map[sy][sx] = TileType.Corridor;
      visited[sy * MAP_WIDTH + sx] = 1;
      let depth = 0;
      const maxDepth = 30 + rng.randInt(0, 20); // Deeper mazes (up from 20+15)

      while (stack.length > 0 && depth < maxDepth) {
        const cur = stack[stack.length - 1];
        const dirs: [number, number][] = [[0, -2], [0, 2], [-2, 0], [2, 0]];
        rng.shuffle(dirs);
        let carved = false;
        for (const [ddx, ddy] of dirs) {
          const nx = cur.x + ddx, ny = cur.y + ddy;
          if (!inBounds(nx, ny) || nx < 2 || nx >= MAP_WIDTH - 2 || ny < 2 || ny >= MAP_HEIGHT - 2) continue;
          if (map[ny][nx] !== TileType.Wall || visited[ny * MAP_WIDTH + nx]) continue;
          const mx = cur.x + ddx / 2, my = cur.y + ddy / 2;
          map[my][mx] = TileType.Corridor;
          map[ny][nx] = TileType.Corridor;
          visited[ny * MAP_WIDTH + nx] = 1;
          visited[my * MAP_WIDTH + mx] = 1;
          stack.push({ x: nx, y: ny });
          depth++;
          carved = true;
          break;
        }
        if (!carved) stack.pop();
      }
    }
  }
}

function generateLavaRiver(map: GameMap, rng: Rng): void {
  const horizontal = rng.next() < 0.5;
  let riverPoints: Point[];
  if (horizontal) {
    riverPoints = [{ x: 0, y: rng.randInt(8, MAP_HEIGHT - 8) }, { x: MAP_WIDTH - 1, y: rng.randInt(8, MAP_HEIGHT - 8) }];
  } else {
    riverPoints = [{ x: rng.randInt(8, MAP_WIDTH - 8), y: 0 }, { x: rng.randInt(8, MAP_WIDTH - 8), y: MAP_HEIGHT - 1 }];
  }

  for (let iter = 0; iter < 3; iter++) {
    const newPoints: Point[] = [riverPoints[0]];
    for (let i = 0; i < riverPoints.length - 1; i++) {
      const a = riverPoints[i], b = riverPoints[i + 1];
      const mid: Point = {
        x: Math.max(1, Math.min(MAP_WIDTH - 2, Math.floor((a.x + b.x) / 2 + (rng.next() - 0.5) * 8))),
        y: Math.max(1, Math.min(MAP_HEIGHT - 2, Math.floor((a.y + b.y) / 2 + (rng.next() - 0.5) * 8))),
      };
      newPoints.push(mid, b);
    }
    riverPoints = newPoints;
  }

  for (let i = 0; i < riverPoints.length - 1; i++) {
    const a = riverPoints[i], b = riverPoints[i + 1];
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps;
      const px = Math.round(a.x + (b.x - a.x) * t);
      const py = Math.round(a.y + (b.y - a.y) * t);
      if (!inBounds(px, py)) continue;
      const existing = map[py][px];
      if ((existing === TileType.Floor || existing === TileType.Corridor) && rng.next() < 0.5) continue;
      map[py][px] = TileType.Lava;
      if (rng.next() < 0.4) {
        const ddx = horizontal ? 0 : (rng.next() < 0.5 ? 1 : -1);
        const ddy = horizontal ? (rng.next() < 0.5 ? 1 : -1) : 0;
        if (inBounds(px + ddx, py + ddy) && map[py + ddy][px + ddx] === TileType.Wall)
          map[py + ddy][px + ddx] = TileType.Lava;
      }
    }
  }
}

// ── Environmental Features ──────────────────────────────────────────────────

function placeHazardPatch(map: GameMap, room: RoomDef, rng: Rng, type: TileType, count: number): void {
  const startX = room.x + rng.randInt(1, Math.max(1, room.width - 2));
  const startY = room.y + rng.randInt(1, Math.max(1, room.height - 2));
  if (!inBounds(startX, startY) || map[startY][startX] !== TileType.Floor) return;
  map[startY][startX] = type;
  let placed = 1;
  const frontier = [{ x: startX, y: startY }];
  while (placed < count && frontier.length > 0) {
    const idx = rng.randInt(0, frontier.length - 1);
    const cell = frontier[idx];
    const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    rng.shuffle(dirs);
    let expanded = false;
    for (const [ddx, ddy] of dirs) {
      const nx = cell.x + ddx, ny = cell.y + ddy;
      if (nx > room.x && nx < room.x + room.width - 1 &&
          ny > room.y && ny < room.y + room.height - 1 &&
          inBounds(nx, ny) && map[ny][nx] === TileType.Floor) {
        map[ny][nx] = type;
        frontier.push({ x: nx, y: ny });
        placed++;
        expanded = true;
        break;
      }
    }
    if (!expanded) frontier.splice(idx, 1);
  }
}

function placeEnvironment(map: GameMap, rooms: RoomDef[], tagged: TaggedRoom[], rng: Rng, biome: Biome, floor: number): void {
  const cycle = Math.floor((floor - 1) / 12);

  if (biome === Biome.Volcanic) generateLavaRiver(map, rng);

  if (floor >= 3) {
    const eligible = tagged.filter((r, i) =>
      i > 0 && i < tagged.length - 1 &&
      (r.roomType === RoomType.Normal || r.roomType === RoomType.Trap || r.roomType === RoomType.MineralRich)
    );
    rng.shuffle(eligible);

    // Biome-dependent hazard density
    const lavaCount = (1 + Math.min(cycle, 2)) * (biome === Biome.Volcanic ? 3 : 1);
    const waterCount = (1 + Math.min(cycle, 2)) * (biome === Biome.FungalCaves ? 3 : 1);

    let hazardIdx = 0;
    for (let h = 0; h < lavaCount && hazardIdx < eligible.length; h++) {
      const room = rooms.find(r => r.x === eligible[hazardIdx].x && r.y === eligible[hazardIdx].y);
      if (room) placeHazardPatch(map, room, rng, TileType.Lava, 3 + rng.randInt(0, 3));
      hazardIdx++;
    }
    for (let h = 0; h < waterCount && hazardIdx < eligible.length; h++) {
      const room = rooms.find(r => r.x === eligible[hazardIdx].x && r.y === eligible[hazardIdx].y);
      if (room) placeHazardPatch(map, room, rng, TileType.Water, 4 + rng.randInt(0, 3));
      hazardIdx++;
    }
  }

  if (biome === Biome.FungalCaves) {
    const eligible = tagged.filter((_, i) => i > 0 && i < tagged.length - 1);
    rng.shuffle(eligible);
    for (let i = 0; i < Math.min(3, eligible.length); i++) {
      const room = rooms.find(r => r.x === eligible[i].x && r.y === eligible[i].y);
      if (room) placeHazardPatch(map, room, rng, TileType.Water, 3 + rng.randInt(0, 4));
    }
  }
}

// ── Secret Rooms ────────────────────────────────────────────────────────────

function placeSecretRooms(map: GameMap, rng: Rng, floor: number): TaggedRoom[] {
  const secretCount = 1 + Math.floor(floor / 6);
  const secrets: TaggedRoom[] = [];

  for (let s = 0; s < secretCount; s++) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const wx = rng.randInt(4, MAP_WIDTH - 8);
      const wy = rng.randInt(4, MAP_HEIGHT - 8);
      if (map[wy][wx] !== TileType.Wall) continue;

      let doorDx = 0, doorDy = 0;
      for (const [ddx, ddy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as [number, number][]) {
        const t = map[wy + ddy]?.[wx + ddx];
        if (t === TileType.Corridor || t === TileType.Floor) { doorDx = ddx; doorDy = ddy; break; }
      }
      if (doorDx === 0 && doorDy === 0) continue;

      const size = 4;
      const awayX = -doorDx, awayY = -doorDy;
      let roomStartX: number, roomStartY: number;
      if (awayX < 0) roomStartX = wx + awayX * size;
      else if (awayX > 0) roomStartX = wx + 1;
      else roomStartX = wx - Math.floor(size / 2);
      if (awayY < 0) roomStartY = wy + awayY * size;
      else if (awayY > 0) roomStartY = wy + 1;
      else roomStartY = wy - Math.floor(size / 2);

      let clear = true;
      for (let dy = -1; dy <= size && clear; dy++)
        for (let dx = -1; dx <= size && clear; dx++) {
          const cx = roomStartX + dx, cy = roomStartY + dy;
          if (!inBounds(cx, cy) || map[cy][cx] !== TileType.Wall) clear = false;
        }
      if (!clear) continue;

      for (let dy = 0; dy < size; dy++)
        for (let dx = 0; dx < size; dx++)
          map[roomStartY + dy][roomStartX + dx] = TileType.Floor;

      map[wy][wx] = TileType.CrackedWall;
      secrets.push({ x: roomStartX, y: roomStartY, width: size, height: size, roomType: RoomType.Secret });
      break;
    }
  }
  return secrets;
}

// ── Locked Door (gates a reward room) ───────────────────────────────────────

function placeLockedDoor(map: GameMap, tagged: TaggedRoom[], _connections: [number, number][], rng: Rng, floorDepth: number, _roomDefs: RoomDef[]): void {
  if (floorDepth < 2) return;

  // Find reward rooms (Treasure or MineralRich, not start or stairs)
  const rewardIndices: number[] = [];
  for (let i = 1; i < tagged.length - 1; i++) {
    if (tagged[i].roomType === RoomType.Treasure || tagged[i].roomType === RoomType.MineralRich) {
      rewardIndices.push(i);
    }
  }
  rng.shuffle(rewardIndices);

  // Try to place locked door on corridor leading to a reward room
  for (const rewardIdx of rewardIndices) {
    // Find the connection edge for this room
    const rewardCenter = roomCenter(tagged[rewardIdx]);

    // Scan corridor tiles near the reward room for a chokepoint
    const candidates: Point[] = [];
    for (let y = Math.max(1, rewardCenter.y - 12); y < Math.min(MAP_HEIGHT - 1, rewardCenter.y + 12); y++) {
      for (let x = Math.max(1, rewardCenter.x - 12); x < Math.min(MAP_WIDTH - 1, rewardCenter.x + 12); x++) {
        if (map[y][x] !== TileType.Corridor) continue;
        const wallH = map[y][x - 1] === TileType.Wall && map[y][x + 1] === TileType.Wall;
        const wallV = map[y - 1][x] === TileType.Wall && map[y + 1][x] === TileType.Wall;
        if (!wallH && !wallV) continue;

        // Don't place right next to start or stairs
        const startRoom = tagged[0];
        const stairsRoom = tagged[tagged.length - 1];
        const nearStart = x >= startRoom.x - 1 && x <= startRoom.x + startRoom.width && y >= startRoom.y - 1 && y <= startRoom.y + startRoom.height;
        const nearStairs = x >= stairsRoom.x - 1 && x <= stairsRoom.x + stairsRoom.width && y >= stairsRoom.y - 1 && y <= stairsRoom.y + stairsRoom.height;
        if (nearStart || nearStairs) continue;

        candidates.push({ x, y });
      }
    }

    if (candidates.length > 0) {
      // Pick the chokepoint closest to the reward room
      candidates.sort((a, b) => dist(a, rewardCenter) - dist(b, rewardCenter));
      const chosen = candidates[Math.min(2, candidates.length - 1)]; // not the closest (too close), but near
      map[chosen.y][chosen.x] = TileType.LockedDoor;
      return;
    }
  }

  // Fallback: old behavior — place on any corridor chokepoint
  const fallback: Point[] = [];
  for (let y = 1; y < MAP_HEIGHT - 1; y++) {
    for (let x = 1; x < MAP_WIDTH - 1; x++) {
      if (map[y][x] !== TileType.Corridor) continue;
      const wallH = map[y][x - 1] === TileType.Wall && map[y][x + 1] === TileType.Wall;
      const wallV = map[y - 1][x] === TileType.Wall && map[y + 1][x] === TileType.Wall;
      if (!wallH && !wallV) continue;
      const startRoom = tagged[0];
      const nearStart = x >= startRoom.x - 1 && x <= startRoom.x + startRoom.width && y >= startRoom.y - 1 && y <= startRoom.y + startRoom.height;
      if (!nearStart) fallback.push({ x, y });
    }
  }
  if (fallback.length > 0) {
    const chosen = fallback[rng.randInt(0, fallback.length - 1)];
    map[chosen.y][chosen.x] = TileType.LockedDoor;
  }
}

// ── Trap Tiles ──────────────────────────────────────────────────────────────

function placeTrapTiles(map: GameMap, room: TaggedRoom, rng: Rng): void {
  for (let y = room.y; y < room.y + room.height; y++)
    for (let x = room.x; x < room.x + room.width; x++)
      if (inBounds(x, y) && map[y][x] === TileType.Floor && rng.next() < 0.3)
        map[y][x] = TileType.TrapFloor;
}

// ── Room Tagging ────────────────────────────────────────────────────────────

function tagRooms(rooms: RoomDef[], rng: Rng, floorDepth: number): TaggedRoom[] {
  const tagged: TaggedRoom[] = rooms.map(r => ({
    x: r.x, y: r.y, width: r.width, height: r.height, roomType: RoomType.Normal,
  }));
  const candidates = tagged.filter((_, i) => i > 0 && i < tagged.length - 1);
  if (candidates.length === 0) return tagged;
  rng.shuffle(candidates);

  let idx = 0;
  if (idx < candidates.length) candidates[idx++].roomType = RoomType.Treasure;
  if (floorDepth >= 2 && idx < candidates.length) candidates[idx++].roomType = RoomType.Trap;
  if (floorDepth % 2 === 0 && idx < candidates.length) candidates[idx++].roomType = RoomType.MineralRich;
  if (floorDepth >= 2 && idx < candidates.length) candidates[idx++].roomType = RoomType.Shrine;
  if (floorDepth >= 4 && floorDepth % 2 === 0 && idx < candidates.length) candidates[idx++].roomType = RoomType.Shop;

  return tagged;
}

// ── Connectivity Validation ─────────────────────────────────────────────────

function validateConnectivity(map: GameMap, rooms: RoomDef[]): boolean {
  if (rooms.length === 0) return true;
  const start = roomCenter(rooms[0]);
  if (!inBounds(start.x, start.y)) return false;

  const visited = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  const queue: number[] = [start.y * MAP_WIDTH + start.x];
  visited[queue[0]] = 1;

  while (queue.length > 0) {
    const k = queue.shift()!;
    const cx = k % MAP_WIDTH, cy = Math.floor(k / MAP_WIDTH);
    for (const [ddx, ddy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = cx + ddx, ny = cy + ddy;
      if (!inBounds(nx, ny)) continue;
      const nk = ny * MAP_WIDTH + nx;
      if (visited[nk]) continue;
      const t = map[ny][nx];
      if (t === TileType.Wall || t === TileType.CrackedWall) continue;
      visited[nk] = 1;
      queue.push(nk);
    }
  }

  for (const room of rooms) {
    const c = roomCenter(room);
    if (inBounds(c.x, c.y) && !visited[c.y * MAP_WIDTH + c.x]) return false;
  }
  return true;
}

// ── Main Entry Point ────────────────────────────────────────────────────────

export function generateDungeon(floorDepth: number = 1, runSeed: number = 0): DungeonResult {
  let seed = (floorDepth * 73856093 + runSeed) | 0;
  let attempts = 0;

  while (attempts < 5) {
    const rng = createRng(seed + attempts * 997);
    const biome = getBiome(floorDepth);
    const isBossFloor = floorDepth % 3 === 0;
    const cycle = Math.floor((floorDepth - 1) / 12);

    // Initialize map with walls
    const map: GameMap = Array.from({ length: MAP_HEIGHT }, () =>
      Array.from({ length: MAP_WIDTH }, () => TileType.Wall)
    );

    // 1. Select layout archetype
    const archetype = selectArchetype(rng, biome, isBossFloor);

    // 2. Generate layout
    let layout: LayoutResult;
    switch (archetype) {
      case 'scattered': layout = layoutScattered(rng, biome, floorDepth, isBossFloor); break;
      case 'ring':      layout = layoutRing(rng, biome, floorDepth, isBossFloor); break;
      case 'hub':       layout = layoutHub(rng, biome, floorDepth, isBossFloor); break;
      case 'linear':    layout = layoutLinear(rng, biome, floorDepth, isBossFloor); break;
      case 'cavern':    layout = layoutCavern(rng, biome, floorDepth, isBossFloor); break;
      case 'arena':     layout = layoutArena(rng, biome, floorDepth, isBossFloor); break;
    }

    // 3. Cavern special path: carve entire map with cellular automata
    let roomDefs: RoomDef[];
    if (archetype === 'cavern') {
      roomDefs = carveCavernAndIdentifyRooms(map, rng, isBossFloor);
      if (roomDefs.length < 3) { attempts++; continue; }
    } else {
      roomDefs = layout.rooms;
      if (roomDefs.length < 3) { attempts++; continue; }

      // 4. Carve rooms
      for (let i = 0; i < roomDefs.length; i++) {
        carveRoomShape(map, roomDefs[i], rng, i === layout.bossRoomIdx);
      }

      // Arena internal structures
      if (archetype === 'arena' && roomDefs.length > 1) {
        carveArenaStructures(map, roomDefs[1], rng, biome); // rooms[1] = arena
      }
    }

    // 5. Build connectivity and carve corridors
    if (archetype === 'cavern') {
      // Cavern: already fully carved, no corridors needed
    } else if (layout.connections === null) {
      // Scattered: use Delaunay/MST/loop-edges
      const centers = roomDefs.map(r => roomCenter(r));
      const triEdges = delaunayTriangulation(centers);
      const mstEdges = minimumSpanningTree(centers, triEdges);
      const loopFraction = Math.min(0.5, 0.2 + cycle * 0.05);
      const allConnections = addLoopEdges(rng, mstEdges, triEdges, loopFraction);
      const mstSet = new Set(mstEdges.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`));
      for (const [a, b] of allConnections) {
        const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
        carveConnection(map, roomCenter(roomDefs[a]), roomCenter(roomDefs[b]), rng, biome, mstSet.has(key));
      }
    } else if (layout.connections.length > 0) {
      // Explicit connections from layout
      for (const [a, b] of layout.connections) {
        if (a < roomDefs.length && b < roomDefs.length) {
          carveConnection(map, roomCenter(roomDefs[a]), roomCenter(roomDefs[b]), rng, biome, true);
        }
      }
    }

    // 6. Corridor vestibules (widening at intersections)
    if (archetype !== 'cavern') carveVestibules(map, rng);

    // 7. Biome post-processing
    switch (biome) {
      case Biome.FungalCaves: postProcessFungal(map, rng); break;
      case Biome.CrystalLab: postProcessCrystal(map, rng); break;
    }

    // 8. Tag rooms
    const tagged = tagRooms(roomDefs, rng, floorDepth);

    // 9. Place trap tiles
    for (const room of tagged) {
      if (room.roomType === RoomType.Trap) placeTrapTiles(map, room, rng);
    }

    // 10. Place environmental features
    placeEnvironment(map, roomDefs, tagged, rng, biome, floorDepth);

    // 11. Place secret rooms
    const secrets = placeSecretRooms(map, rng, floorDepth);
    for (const s of secrets) tagged.push(s);

    // 12. Place locked door (gates reward rooms)
    placeLockedDoor(map, tagged, layout.connections ?? [], rng, floorDepth, roomDefs);

    // 13. Validate connectivity
    if (validateConnectivity(map, roomDefs)) {
      return { map, rooms: tagged };
    }

    attempts++;
  }

  // Fallback
  return generateFallback(floorDepth);
}

// ── Fallback Generator ──────────────────────────────────────────────────────

function generateFallback(floorDepth: number): DungeonResult {
  const rng = createRng(floorDepth * 12345 + 99999);
  const map: GameMap = Array.from({ length: MAP_HEIGHT }, () =>
    Array.from({ length: MAP_WIDTH }, () => TileType.Wall)
  );

  const rooms: RoomDef[] = [
    { x: 5, y: 5, width: 8, height: 8, shape: 'rect' },
    { x: 30, y: 15, width: 10, height: 10, shape: 'rect' },
    { x: 60, y: 30, width: 8, height: 8, shape: 'rect' },
  ];

  for (const r of rooms) carveRect(map, r);
  carveCorridorL(map, roomCenter(rooms[0]), roomCenter(rooms[1]), rng, false);
  carveCorridorL(map, roomCenter(rooms[1]), roomCenter(rooms[2]), rng, false);

  const tagged = tagRooms(rooms, rng, floorDepth);
  return { map, rooms: tagged };
}
