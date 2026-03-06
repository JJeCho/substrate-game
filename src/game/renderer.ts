import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, COLORS, VISION_RADIUS } from './constants';
import { TileType, RoomType } from './types';
import type { GameMap, TaggedRoom } from './types';
import type { Camera } from './camera';
import type { Player } from './player';
import type { Mineral, HealthPickup } from './minerals';

const ROOM_TINTS: Record<number, string> = {
  [RoomType.Treasure]: 'rgba(255,200,50,0.10)',
  [RoomType.Trap]: 'rgba(255,50,50,0.10)',
  [RoomType.MineralRich]: 'rgba(50,200,255,0.10)',
  [RoomType.Shrine]: 'rgba(200,150,255,0.15)',
  [RoomType.Shop]: 'rgba(255,215,0,0.15)',
  [RoomType.Secret]: 'rgba(0,255,180,0.12)',
};

export function renderMap(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  camera: Camera,
  player: Player,
  canvasW: number,
  canvasH: number,
  taggedRooms?: TaggedRoom[],
): void {
  // Calculate visible tile range
  const startX = Math.max(0, Math.floor(camera.x / TILE_SIZE));
  const startY = Math.max(0, Math.floor(camera.y / TILE_SIZE));
  const endX = Math.min(MAP_WIDTH, Math.ceil((camera.x + canvasW) / TILE_SIZE) + 1);
  const endY = Math.min(MAP_HEIGHT, Math.ceil((camera.y + canvasH) / TILE_SIZE) + 1);

  // Clear
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvasW, canvasH);

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const tile = map[y][x];
      const sx = x * TILE_SIZE - camera.x;
      const sy = y * TILE_SIZE - camera.y;

      // Distance from player (in tiles)
      const dx = x - player.x;
      const dy = y - player.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Base tile color
      switch (tile) {
        case TileType.Wall:
          ctx.fillStyle = COLORS.wall;
          break;
        case TileType.Floor:
          ctx.fillStyle = COLORS.floor;
          break;
        case TileType.Corridor:
          ctx.fillStyle = COLORS.corridor;
          break;
        case TileType.Stairs:
          ctx.fillStyle = COLORS.floor;
          break;
        case TileType.TrapFloor:
          ctx.fillStyle = '#5a3a3a';
          break;
        case TileType.Lava:
          ctx.fillStyle = '#cc3300';
          break;
        case TileType.Water:
          ctx.fillStyle = '#224466';
          break;
        case TileType.LockedDoor:
          ctx.fillStyle = '#8B7355';
          break;
        case TileType.CrackedWall:
          ctx.fillStyle = '#1e1e35';
          break;
      }

      ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);

      // Draw stairs indicator
      if (tile === TileType.Stairs && dist <= VISION_RADIUS) {
        ctx.fillStyle = COLORS.stairs;
        // Draw a downward chevron
        const cx = sx + TILE_SIZE / 2;
        const cy = sy + TILE_SIZE / 2;
        ctx.beginPath();
        ctx.moveTo(cx - 4, cy - 3);
        ctx.lineTo(cx, cy + 2);
        ctx.lineTo(cx + 4, cy - 3);
        ctx.lineWidth = 2;
        ctx.strokeStyle = COLORS.stairs;
        ctx.stroke();
        // Pulsing glow
        ctx.beginPath();
        ctx.arc(cx, cy, TILE_SIZE * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.stairs + '30';
        ctx.fill();
      }

      // Lava animated glow
      if (tile === TileType.Lava && dist <= VISION_RADIUS) {
        const cx = sx + TILE_SIZE / 2;
        const cy = sy + TILE_SIZE / 2;
        const pulse = 0.15 + Math.sin((x * 3.7 + y * 2.3) + Date.now() * 0.003) * 0.1;
        ctx.fillStyle = `rgba(255,150,0,${pulse})`;
        ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
        // Small bright center
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,220,100,0.4)';
        ctx.fill();
      }

      // Water shimmer
      if (tile === TileType.Water && dist <= VISION_RADIUS) {
        const shimmer = 0.05 + Math.sin((x * 2.1 + y * 4.7) + Date.now() * 0.002) * 0.05;
        ctx.fillStyle = `rgba(100,180,255,${shimmer})`;
        ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
      }

      // Cracked wall detail
      if (tile === TileType.CrackedWall && dist <= VISION_RADIUS) {
        ctx.strokeStyle = '#2a2a48';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx + 3, sy + 2);
        ctx.lineTo(sx + TILE_SIZE / 2, sy + TILE_SIZE / 2);
        ctx.lineTo(sx + TILE_SIZE - 3, sy + TILE_SIZE - 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx + TILE_SIZE / 2, sy + TILE_SIZE / 2);
        ctx.lineTo(sx + 2, sy + TILE_SIZE - 3);
        ctx.stroke();
      }

      // Locked door keyhole
      if (tile === TileType.LockedDoor && dist <= VISION_RADIUS) {
        const cx = sx + TILE_SIZE / 2;
        const cy = sy + TILE_SIZE / 2;
        ctx.beginPath();
        ctx.arc(cx, cy - 1, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#443322';
        ctx.fill();
        ctx.fillRect(cx - 1, cy, 2, 3);
      }

      // Vision fog overlay
      if (dist > VISION_RADIUS) {
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
      } else if (dist > VISION_RADIUS * 0.6) {
        const fade = (dist - VISION_RADIUS * 0.6) / (VISION_RADIUS * 0.4);
        ctx.fillStyle = `rgba(0,0,0,${fade * 0.7})`;
        ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  // Room type tint overlays (within vision)
  if (taggedRooms) {
    for (const room of taggedRooms) {
      const tint = ROOM_TINTS[room.roomType];
      if (!tint) continue;
      // Check if room is near player
      const rcx = room.x + room.width / 2;
      const rcy = room.y + room.height / 2;
      const rdist = Math.sqrt((rcx - player.x) ** 2 + (rcy - player.y) ** 2);
      if (rdist > VISION_RADIUS + room.width) continue;

      const rx = room.x * TILE_SIZE - camera.x;
      const ry = room.y * TILE_SIZE - camera.y;
      ctx.fillStyle = tint;
      ctx.fillRect(rx, ry, room.width * TILE_SIZE, room.height * TILE_SIZE);
    }
  }
}

export function renderHealthPickups(
  ctx: CanvasRenderingContext2D,
  pickups: HealthPickup[],
  camera: Camera,
  player: Player,
  time: number,
  canvasW: number,
  canvasH: number,
): void {
  for (const pickup of pickups) {
    if (pickup.consumed) continue;

    const sx = pickup.x * TILE_SIZE - camera.x;
    const sy = pickup.y * TILE_SIZE - camera.y;
    if (sx < -TILE_SIZE * 2 || sx > canvasW + TILE_SIZE * 2) continue;
    if (sy < -TILE_SIZE * 2 || sy > canvasH + TILE_SIZE * 2) continue;

    const dx = pickup.x - player.x;
    const dy = pickup.y - player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > VISION_RADIUS * 1.5) continue;

    ctx.save();
    if (dist > VISION_RADIUS) ctx.globalAlpha = 0.2;
    pickup.render(ctx, camera, time);
    ctx.restore();
  }
}

export function renderMinerals(
  ctx: CanvasRenderingContext2D,
  minerals: Mineral[],
  camera: Camera,
  player: Player,
  time: number,
  canvasW: number,
  canvasH: number,
): void {
  for (const mineral of minerals) {
    if (mineral.consumed) continue;

    // Skip if off screen
    const sx = mineral.x * TILE_SIZE - camera.x;
    const sy = mineral.y * TILE_SIZE - camera.y;
    if (sx < -TILE_SIZE * 2 || sx > canvasW + TILE_SIZE * 2) continue;
    if (sy < -TILE_SIZE * 2 || sy > canvasH + TILE_SIZE * 2) continue;

    // Distance from player
    const dx = mineral.x - player.x;
    const dy = mineral.y - player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Minerals beyond vision: show faint glow only
    if (dist > VISION_RADIUS * 1.5) continue;

    ctx.save();
    if (dist > VISION_RADIUS) {
      ctx.globalAlpha = 0.2;
    }
    mineral.render(ctx, camera, time);
    ctx.restore();
  }
}
