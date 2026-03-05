import { TILE_SIZE, ELEMENT_COLORS, RARITY_GLOW, RARITY_COLORS, RARITY_SIZES } from './constants';
import { TileType, Element, Modifier, Rarity, RoomType } from './types';
import type { GameMap, Room, MineralData, TaggedRoom } from './types';
import type { Camera } from './camera';

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randElement(): Element {
  const vals = [0, 1, 2, 3, 4, 5] as const;
  return vals[randInt(0, vals.length - 1)];
}

function randModifier(): Modifier {
  const vals = [0, 1, 2, 3, 4, 5, 6, 7] as const;
  return vals[randInt(0, vals.length - 1)];
}

function randRarity(floorDepth: number): Rarity {
  const roll = Math.random() + floorDepth * 0.05;
  if (roll > 0.95) return Rarity.Primordial;
  if (roll > 0.75) return Rarity.Rare;
  if (roll > 0.45) return Rarity.Uncommon;
  return Rarity.Common;
}

export function generateMineral(floorDepth: number): MineralData {
  return {
    element: randElement(),
    modifier: randModifier(),
    rarity: randRarity(floorDepth),
  };
}

export class Mineral {
  x: number;
  y: number;
  data: MineralData;
  consumed = false;
  dropTimer = 0; // prevents instant re-pickup after dropping
  private pulsePhase: number;

  constructor(x: number, y: number, data: MineralData) {
    this.x = x;
    this.y = y;
    this.data = data;
    this.pulsePhase = Math.random() * Math.PI * 2;
  }

  render(ctx: CanvasRenderingContext2D, camera: Camera, time: number): void {
    if (this.consumed) return;

    const sx = this.x * TILE_SIZE + TILE_SIZE / 2 - camera.x;
    const sy = this.y * TILE_SIZE + TILE_SIZE / 2 - camera.y;
    const color = ELEMENT_COLORS[this.data.element];
    const rarityColor = RARITY_COLORS[this.data.rarity];
    const glow = RARITY_GLOW[this.data.rarity];
    const rarity = this.data.rarity;
    const pulse = Math.sin(time * 3 + this.pulsePhase) * 0.15 + 0.85;

    // Outer glow — rarity-colored for Rare+
    const glowRadius = TILE_SIZE * 0.8 * glow * pulse;
    const gradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowRadius);
    const glowColor = rarity >= 2 ? rarityColor : color;
    gradient.addColorStop(0, glowColor + '70');
    gradient.addColorStop(0.6, glowColor + '25');
    gradient.addColorStop(1, glowColor + '00');
    ctx.beginPath();
    ctx.arc(sx, sy, glowRadius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Orbiting particles for Rare and Primordial
    if (rarity >= 2) {
      const particleCount = rarity === 3 ? 4 : 2;
      for (let i = 0; i < particleCount; i++) {
        const angle = time * 2.5 + (i * Math.PI * 2) / particleCount + this.pulsePhase;
        const orbitR = TILE_SIZE * 0.35;
        const px = sx + Math.cos(angle) * orbitR;
        const py = sy + Math.sin(angle) * orbitR;
        const pSize = rarity === 3 ? 1.5 : 1;
        ctx.beginPath();
        ctx.arc(px, py, pSize, 0, Math.PI * 2);
        ctx.fillStyle = rarityColor;
        ctx.fill();
      }
    }

    // Diamond shape — size scales with rarity
    const size = TILE_SIZE * RARITY_SIZES[rarity];
    ctx.beginPath();
    ctx.moveTo(sx, sy - size);
    ctx.lineTo(sx + size, sy);
    ctx.lineTo(sx, sy + size);
    ctx.lineTo(sx - size, sy);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Rarity-colored outline
    ctx.strokeStyle = rarityColor;
    ctx.lineWidth = rarity >= 2 ? 1.5 : 0.8;
    ctx.stroke();

    // Primordial: second inner diamond rotated 45°
    if (rarity === 3) {
      const innerSize = size * 0.55;
      ctx.beginPath();
      ctx.rect(sx - innerSize, sy - innerSize, innerSize * 2, innerSize * 2);
      ctx.strokeStyle = rarityColor + 'aa';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // Inner bright point — bigger for higher rarity
    const coreSize = size * (rarity === 3 ? 0.4 : rarity === 2 ? 0.35 : 0.25);
    ctx.beginPath();
    ctx.arc(sx, sy, coreSize, 0, Math.PI * 2);
    ctx.fillStyle = rarity >= 2 ? rarityColor : '#ffffff';
    ctx.fill();
  }
}

export class HealthPickup {
  x: number;
  y: number;
  healAmount: number;
  consumed = false;
  private pulsePhase: number;

  constructor(x: number, y: number, healAmount: number) {
    this.x = x;
    this.y = y;
    this.healAmount = healAmount;
    this.pulsePhase = Math.random() * Math.PI * 2;
  }

  render(ctx: CanvasRenderingContext2D, camera: Camera, time: number): void {
    if (this.consumed) return;

    const sx = this.x * TILE_SIZE + TILE_SIZE / 2 - camera.x;
    const sy = this.y * TILE_SIZE + TILE_SIZE / 2 - camera.y;
    const pulse = Math.sin(time * 3 + this.pulsePhase) * 0.15 + 0.85;

    // Green glow
    const glowR = TILE_SIZE * 0.6 * pulse;
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
    grad.addColorStop(0, '#44ff4450');
    grad.addColorStop(1, '#44ff4400');
    ctx.beginPath();
    ctx.arc(sx, sy, glowR, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Green cross shape
    const s = TILE_SIZE * 0.15;
    ctx.fillStyle = '#44ff44';
    ctx.fillRect(sx - s, sy - s * 3, s * 2, s * 6);
    ctx.fillRect(sx - s * 3, sy - s, s * 6, s * 2);

    // White center
    ctx.beginPath();
    ctx.arc(sx, sy, s * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
}

export function spawnHealthPickups(rooms: Room[], map: GameMap, floorDepth: number): HealthPickup[] {
  const pickups: HealthPickup[] = [];
  for (let i = 1; i < rooms.length; i++) {
    if (Math.random() > 0.3) continue; // 30% chance per room
    const room = rooms[i];
    for (let attempt = 0; attempt < 10; attempt++) {
      const hx = room.x + randInt(0, room.width - 1);
      const hy = room.y + randInt(0, room.height - 1);
      if (map[hy][hx] === TileType.Floor) {
        pickups.push(new HealthPickup(hx, hy, 15 + floorDepth * 3));
        break;
      }
    }
  }
  return pickups;
}

export function spawnMinerals(rooms: TaggedRoom[], map: GameMap, floorDepth: number = 1): Mineral[] {
  const minerals: Mineral[] = [];

  for (const room of rooms) {
    // Treasure rooms: 3-5 minerals, rarity >= Uncommon
    // Mineral-rich rooms: 2-4 minerals
    // Normal/Trap: 1-3 minerals
    let count: number;
    let minRarity = 0;
    if (room.roomType === RoomType.Treasure) {
      count = randInt(3, 5);
      minRarity = 1; // At least Uncommon
    } else if (room.roomType === RoomType.MineralRich) {
      count = randInt(2, 4);
    } else {
      count = randInt(1, 3);
    }

    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const mx = room.x + randInt(0, room.width - 1);
        const my = room.y + randInt(0, room.height - 1);
        if (map[my][mx] === TileType.Floor || map[my][mx] === TileType.TrapFloor) {
          const occupied = minerals.some(m => m.x === mx && m.y === my);
          if (!occupied) {
            const data = generateMineral(floorDepth);
            if (minRarity > 0 && data.rarity < minRarity) {
              data.rarity = minRarity as MineralData['rarity'];
            }
            minerals.push(new Mineral(mx, my, data));
            break;
          }
        }
      }
    }
  }

  return minerals;
}
