import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from './constants';
import { TileType } from './types';
import type { GameMap, StatusEffect } from './types';
import type { Camera } from './camera';

export class Projectile {
  x: number; // pixel position
  y: number;
  dx: number; // direction (normalized)
  dy: number;
  speed: number; // pixels per second
  damage: number;
  lifetime: number; // seconds remaining
  color: string;
  radius: number;
  pierce: boolean;
  explodes: boolean;
  explosionRadius: number;
  lifesteal: number;
  statusEffect: StatusEffect | null;
  chain: number;
  chainHitIds: Set<number>;
  leavesCloud: boolean;
  isSplit: boolean;
  dead = false;
  fromPlayer: boolean;

  constructor(
    x: number,
    y: number,
    dx: number,
    dy: number,
    opts: {
      speed?: number;
      damage?: number;
      lifetime?: number;
      color?: string;
      pierce?: boolean;
      explodes?: boolean;
      explosionRadius?: number;
      lifesteal?: number;
      statusEffect?: StatusEffect | null;
      chain?: number;
      chainHitIds?: Set<number>;
      leavesCloud?: boolean;
      fromPlayer?: boolean;
    } = {},
  ) {
    this.x = x;
    this.y = y;
    this.dx = dx;
    this.dy = dy;
    this.speed = opts.speed ?? 120;
    this.damage = opts.damage ?? 10;
    this.lifetime = opts.lifetime ?? 1.5;
    this.color = opts.color ?? '#fff';
    this.radius = 3;
    this.pierce = opts.pierce ?? false;
    this.explodes = opts.explodes ?? false;
    this.explosionRadius = opts.explosionRadius ?? 0;
    this.lifesteal = opts.lifesteal ?? 0;
    this.statusEffect = opts.statusEffect ?? null;
    this.chain = opts.chain ?? 0;
    this.chainHitIds = opts.chainHitIds ?? new Set();
    this.leavesCloud = opts.leavesCloud ?? false;
    this.isSplit = false;
    this.fromPlayer = opts.fromPlayer ?? true;
  }

  update(dt: number, map: GameMap): void {
    this.lifetime -= dt;
    if (this.lifetime <= 0) {
      this.dead = true;
      return;
    }

    this.x += this.dx * this.speed * dt;
    this.y += this.dy * this.speed * dt;

    // Wall collision
    const tileX = Math.floor(this.x / TILE_SIZE);
    const tileY = Math.floor(this.y / TILE_SIZE);

    if (tileX < 0 || tileX >= MAP_WIDTH || tileY < 0 || tileY >= MAP_HEIGHT) {
      this.dead = true;
      return;
    }

    const tile = map[tileY][tileX];
    if (tile === TileType.Wall || tile === TileType.LockedDoor || tile === TileType.CrackedWall) {
      this.dead = true;
    }
  }

  render(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const sx = this.x - camera.x;
    const sy = this.y - camera.y;

    // Glow
    const gradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, this.radius * 3);
    gradient.addColorStop(0, this.color + '80');
    gradient.addColorStop(1, this.color + '00');
    ctx.beginPath();
    ctx.arc(sx, sy, this.radius * 3, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Core
    ctx.beginPath();
    ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
  }
}
