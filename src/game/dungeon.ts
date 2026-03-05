import { MAP_WIDTH, MAP_HEIGHT, MIN_LEAF_SIZE, MIN_ROOM_SIZE, MIN_ROOM_PADDING } from './constants';
import { TileType, RoomType } from './types';
import type { Room, Point, GameMap, DungeonResult, TaggedRoom } from './types';

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class Leaf {
  x: number;
  y: number;
  width: number;
  height: number;
  left: Leaf | null = null;
  right: Leaf | null = null;
  room: Room | null = null;

  constructor(x: number, y: number, width: number, height: number) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  split(): boolean {
    if (this.left !== null) return false;

    // Decide split direction
    let splitH: boolean;
    if (this.width / this.height >= 1.25) {
      splitH = false; // too wide, split vertically
    } else if (this.height / this.width >= 1.25) {
      splitH = true; // too tall, split horizontally
    } else {
      splitH = Math.random() > 0.5;
    }

    const max = (splitH ? this.height : this.width) - MIN_LEAF_SIZE;
    if (max < MIN_LEAF_SIZE) return false;

    const splitPos = randInt(MIN_LEAF_SIZE, max);

    if (splitH) {
      this.left = new Leaf(this.x, this.y, this.width, splitPos);
      this.right = new Leaf(this.x, this.y + splitPos, this.width, this.height - splitPos);
    } else {
      this.left = new Leaf(this.x, this.y, splitPos, this.height);
      this.right = new Leaf(this.x + splitPos, this.y, this.width - splitPos, this.height);
    }

    return true;
  }

  createRooms(): void {
    if (this.left !== null && this.right !== null) {
      this.left.createRooms();
      this.right.createRooms();
      return;
    }

    // Terminal leaf — create a room
    const roomWidth = randInt(MIN_ROOM_SIZE, this.width - MIN_ROOM_PADDING * 2);
    const roomHeight = randInt(MIN_ROOM_SIZE, this.height - MIN_ROOM_PADDING * 2);
    const roomX = this.x + randInt(MIN_ROOM_PADDING, this.width - roomWidth - MIN_ROOM_PADDING);
    const roomY = this.y + randInt(MIN_ROOM_PADDING, this.height - roomHeight - MIN_ROOM_PADDING);

    this.room = { x: roomX, y: roomY, width: roomWidth, height: roomHeight };
  }

  getRoom(): Room | null {
    if (this.room !== null) return this.room;
    if (this.left !== null) {
      const leftRoom = this.left.getRoom();
      if (leftRoom !== null) return leftRoom;
    }
    if (this.right !== null) {
      const rightRoom = this.right.getRoom();
      if (rightRoom !== null) return rightRoom;
    }
    return null;
  }
}

function roomCenter(room: Room): Point {
  return {
    x: Math.floor(room.x + room.width / 2),
    y: Math.floor(room.y + room.height / 2),
  };
}

function carveRoom(map: GameMap, room: Room): void {
  for (let y = room.y; y < room.y + room.height; y++) {
    for (let x = room.x; x < room.x + room.width; x++) {
      if (x >= 0 && x < MAP_WIDTH && y >= 0 && y < MAP_HEIGHT) {
        map[y][x] = TileType.Floor;
      }
    }
  }
}

function carveCorridor(map: GameMap, a: Point, b: Point): void {
  let x = a.x;
  let y = a.y;

  // Randomly choose whether to go horizontal-first or vertical-first
  if (Math.random() > 0.5) {
    // Horizontal then vertical
    while (x !== b.x) {
      if (x >= 0 && x < MAP_WIDTH && y >= 0 && y < MAP_HEIGHT && map[y][x] === TileType.Wall) {
        map[y][x] = TileType.Corridor;
      }
      x += x < b.x ? 1 : -1;
    }
    while (y !== b.y) {
      if (x >= 0 && x < MAP_WIDTH && y >= 0 && y < MAP_HEIGHT && map[y][x] === TileType.Wall) {
        map[y][x] = TileType.Corridor;
      }
      y += y < b.y ? 1 : -1;
    }
  } else {
    // Vertical then horizontal
    while (y !== b.y) {
      if (x >= 0 && x < MAP_WIDTH && y >= 0 && y < MAP_HEIGHT && map[y][x] === TileType.Wall) {
        map[y][x] = TileType.Corridor;
      }
      y += y < b.y ? 1 : -1;
    }
    while (x !== b.x) {
      if (x >= 0 && x < MAP_WIDTH && y >= 0 && y < MAP_HEIGHT && map[y][x] === TileType.Wall) {
        map[y][x] = TileType.Corridor;
      }
      x += x < b.x ? 1 : -1;
    }
  }
}

function connectLeaves(map: GameMap, leaf: Leaf): void {
  if (leaf.left === null || leaf.right === null) return;

  connectLeaves(map, leaf.left);
  connectLeaves(map, leaf.right);

  const leftRoom = leaf.left.getRoom();
  const rightRoom = leaf.right.getRoom();

  if (leftRoom !== null && rightRoom !== null) {
    carveCorridor(map, roomCenter(leftRoom), roomCenter(rightRoom));
  }
}

function tagRooms(rooms: Room[], floorDepth: number): TaggedRoom[] {
  const tagged: TaggedRoom[] = rooms.map(r => ({ ...r, roomType: RoomType.Normal }));

  // Skip first room (start) and last room (stairs) for special types
  const candidates = tagged.filter((_, i) => i > 0 && i < tagged.length - 1);
  if (candidates.length === 0) return tagged;

  // Shuffle candidates
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  let idx = 0;
  // 1 treasure room
  if (idx < candidates.length) candidates[idx++].roomType = RoomType.Treasure;
  // 1 trap room (floor 2+)
  if (floorDepth >= 2 && idx < candidates.length) candidates[idx++].roomType = RoomType.Trap;
  // 1 mineral-rich room (even floors)
  if (floorDepth % 2 === 0 && idx < candidates.length) candidates[idx++].roomType = RoomType.MineralRich;
  // 1 shrine room (floor 2+)
  if (floorDepth >= 2 && idx < candidates.length) candidates[idx++].roomType = RoomType.Shrine;
  // 1 shop room (even floors, floor 4+)
  if (floorDepth >= 4 && floorDepth % 2 === 0 && idx < candidates.length) candidates[idx++].roomType = RoomType.Shop;

  return tagged;
}

function placeTrapTiles(map: GameMap, room: TaggedRoom): void {
  for (let y = room.y; y < room.y + room.height; y++) {
    for (let x = room.x; x < room.x + room.width; x++) {
      if (map[y][x] === TileType.Floor && Math.random() < 0.3) {
        map[y][x] = TileType.TrapFloor;
      }
    }
  }
}

/** Place lava and water patches in rooms on floor 3+ */
function placeHazards(map: GameMap, rooms: TaggedRoom[], floorDepth: number): void {
  if (floorDepth < 3) return;

  // Collect eligible rooms (not start, not stairs, not treasure/shop/shrine)
  const eligible = rooms.filter((_, i) =>
    i > 0 && i < rooms.length - 1
  ).filter(r =>
    r.roomType === RoomType.Normal || r.roomType === RoomType.Trap || r.roomType === RoomType.MineralRich
  );

  if (eligible.length === 0) return;

  // Shuffle
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }

  // Place lava in up to 1 room
  if (eligible.length > 0) {
    placeHazardPatch(map, eligible[0], TileType.Lava, 3 + randInt(0, 3));
  }

  // Place water in another room
  if (eligible.length > 1) {
    placeHazardPatch(map, eligible[1], TileType.Water, 4 + randInt(0, 3));
  }
}

function placeHazardPatch(map: GameMap, room: TaggedRoom, type: TileType, count: number): void {
  // Start from a random interior tile and grow a patch
  const startX = room.x + randInt(1, room.width - 2);
  const startY = room.y + randInt(1, room.height - 2);

  if (map[startY][startX] !== TileType.Floor) return;
  map[startY][startX] = type;

  let placed = 1;
  const frontier = [{ x: startX, y: startY }];

  while (placed < count && frontier.length > 0) {
    const idx = randInt(0, frontier.length - 1);
    const cell = frontier[idx];
    const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    // Shuffle directions
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    let expanded = false;
    for (const [ddx, ddy] of dirs) {
      const nx = cell.x + ddx;
      const ny = cell.y + ddy;
      if (nx > room.x && nx < room.x + room.width - 1 &&
          ny > room.y && ny < room.y + room.height - 1 &&
          map[ny][nx] === TileType.Floor) {
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

/** Place a locked door in a corridor on floor 2+ */
function placeLockedDoor(map: GameMap, rooms: TaggedRoom[], floorDepth: number): void {
  if (floorDepth < 2) return;

  // Find corridor tiles that connect to non-start, non-stairs rooms
  // Try to find a corridor tile adjacent to a room
  const candidates: Point[] = [];

  for (let y = 1; y < MAP_HEIGHT - 1; y++) {
    for (let x = 1; x < MAP_WIDTH - 1; x++) {
      if (map[y][x] !== TileType.Corridor) continue;

      // Check if this corridor is a chokepoint (wall on opposite sides)
      const wallH = (map[y][x - 1] === TileType.Wall && map[y][x + 1] === TileType.Wall);
      const wallV = (map[y - 1][x] === TileType.Wall && map[y + 1][x] === TileType.Wall);

      if (wallH || wallV) {
        // Not near start or stairs room
        const startRoom = rooms[0];
        const stairsRoom = rooms[rooms.length - 1];
        const nearStart = x >= startRoom.x - 1 && x <= startRoom.x + startRoom.width && y >= startRoom.y - 1 && y <= startRoom.y + startRoom.height;
        const nearStairs = x >= stairsRoom.x - 1 && x <= stairsRoom.x + stairsRoom.width && y >= stairsRoom.y - 1 && y <= stairsRoom.y + stairsRoom.height;

        if (!nearStart && !nearStairs) {
          candidates.push({ x, y });
        }
      }
    }
  }

  if (candidates.length > 0) {
    const chosen = candidates[randInt(0, candidates.length - 1)];
    map[chosen.y][chosen.x] = TileType.LockedDoor;
  }
}

export function generateDungeon(floorDepth: number = 1): DungeonResult {
  // Initialize map with walls
  const map: GameMap = Array.from({ length: MAP_HEIGHT }, () =>
    Array.from({ length: MAP_WIDTH }, () => TileType.Wall)
  );

  // Create root leaf
  const root = new Leaf(0, 0, MAP_WIDTH, MAP_HEIGHT);

  // Split recursively
  const leaves: Leaf[] = [root];
  let didSplit = true;

  while (didSplit) {
    didSplit = false;
    for (const leaf of [...leaves]) {
      if (leaf.left === null && leaf.right === null) {
        if (leaf.width > MIN_LEAF_SIZE * 2 || leaf.height > MIN_LEAF_SIZE * 2 || Math.random() > 0.25) {
          if (leaf.split()) {
            leaves.push(leaf.left!);
            leaves.push(leaf.right!);
            didSplit = true;
          }
        }
      }
    }
  }

  // Create rooms in terminal leaves
  root.createRooms();

  // Collect rooms
  const rooms: Room[] = [];
  for (const leaf of leaves) {
    if (leaf.room !== null) {
      carveRoom(map, leaf.room);
      rooms.push(leaf.room);
    }
  }

  // Connect sibling rooms with corridors
  connectLeaves(map, root);

  // Tag rooms with types
  const tagged = tagRooms(rooms, floorDepth);

  // Place trap tiles in trap rooms
  for (const room of tagged) {
    if (room.roomType === RoomType.Trap) {
      placeTrapTiles(map, room);
    }
  }

  // Place environmental hazards (lava, water)
  placeHazards(map, tagged, floorDepth);

  // Place locked door
  placeLockedDoor(map, tagged, floorDepth);

  return { map, rooms: tagged };
}
