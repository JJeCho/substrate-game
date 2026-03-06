import { MAP_WIDTH, MAP_HEIGHT } from './constants';
import { TileType } from './types';
import type { GameMap, Point } from './types';

interface PathNode {
  x: number;
  y: number;
  g: number;
  f: number;
  parent: PathNode | null;
}

/** Bounded A* pathfinding. Returns tile path (excluding start) or null if unreachable. */
export function findPath(
  map: GameMap,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  maxRange: number = 15,
): Point[] | null {
  if (startX === goalX && startY === goalY) return [];

  const open: PathNode[] = [];
  const closed = new Set<number>();

  const key = (x: number, y: number) => y * MAP_WIDTH + x;
  const h = (x: number, y: number) => Math.abs(x - goalX) + Math.abs(y - goalY);

  const startNode: PathNode = { x: startX, y: startY, g: 0, f: h(startX, startY), parent: null };
  open.push(startNode);

  const gScores = new Map<number, number>();
  gScores.set(key(startX, startY), 0);

  const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];

  while (open.length > 0) {
    // Find node with lowest f
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const current = open[bestIdx];
    open.splice(bestIdx, 1);

    if (current.x === goalX && current.y === goalY) {
      // Reconstruct path
      const path: Point[] = [];
      let node: PathNode | null = current;
      while (node && node.parent) {
        path.push({ x: node.x, y: node.y });
        node = node.parent;
      }
      path.reverse();
      return path;
    }

    const ck = key(current.x, current.y);
    if (closed.has(ck)) continue;
    closed.add(ck);

    // Don't expand beyond maxRange from start
    if (current.g > maxRange) continue;

    for (const [ddx, ddy] of dirs) {
      const nx = current.x + ddx;
      const ny = current.y + ddy;

      if (nx < 0 || nx >= MAP_WIDTH || ny < 0 || ny >= MAP_HEIGHT) continue;
      if (map[ny][nx] === TileType.Wall || map[ny][nx] === TileType.CrackedWall || map[ny][nx] === TileType.LockedDoor) continue;

      const nk = key(nx, ny);
      if (closed.has(nk)) continue;

      const ng = current.g + 1;
      const prevG = gScores.get(nk);
      if (prevG !== undefined && ng >= prevG) continue;

      gScores.set(nk, ng);
      open.push({ x: nx, y: ny, g: ng, f: ng + h(nx, ny), parent: current });
    }
  }

  return null; // No path found
}

/** Convenience: returns just the next step toward the goal, or null. */
export function nextStep(
  map: GameMap,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  maxRange: number = 15,
): Point | null {
  const path = findPath(map, startX, startY, goalX, goalY, maxRange);
  return path && path.length > 0 ? path[0] : null;
}
