import { TILE_SIZE } from './constants';
import type { GameMap, StatusEffect } from './types';
import type { Camera } from './camera';
import { nextStep } from './pathfinding';
import type { Enemy } from './enemy';

export class Ally {
  x: number;
  y: number;
  px: number;
  py: number;
  hp: number;
  maxHp: number;
  damage: number;
  lifetime: number;
  attackCooldown = 0;
  color: string;
  element: number;
  statusEffect: StatusEffect | null;
  dead = false;

  private tx: number;
  private ty: number;
  private moving = false;
  private moveProgress = 0;
  private startPx = 0;
  private startPy = 0;
  private moveTimer = 0;

  constructor(x: number, y: number, damage: number, lifetime: number, color: string, element: number, statusEffect: StatusEffect | null) {
    this.x = x;
    this.y = y;
    this.tx = x;
    this.ty = y;
    this.px = x * TILE_SIZE + TILE_SIZE / 2;
    this.py = y * TILE_SIZE + TILE_SIZE / 2;
    this.hp = 30 + damage;
    this.maxHp = this.hp;
    this.damage = damage;
    this.lifetime = lifetime;
    this.color = color;
    this.element = element;
    this.statusEffect = statusEffect;
  }

  update(dt: number, map: GameMap, enemies: Enemy[]): Enemy | null {
    this.lifetime -= dt;
    if (this.lifetime <= 0 || this.hp <= 0) {
      this.dead = true;
      return null;
    }

    this.attackCooldown = Math.max(0, this.attackCooldown - dt);

    // Movement interpolation
    if (this.moving) {
      this.moveProgress += dt * 5; // Speed 5 tiles/sec
      if (this.moveProgress >= 1) {
        this.x = this.tx;
        this.y = this.ty;
        this.px = this.x * TILE_SIZE + TILE_SIZE / 2;
        this.py = this.y * TILE_SIZE + TILE_SIZE / 2;
        this.moving = false;
        this.moveProgress = 0;
      } else {
        this.px = this.startPx + (this.tx * TILE_SIZE + TILE_SIZE / 2 - this.startPx) * this.moveProgress;
        this.py = this.startPy + (this.ty * TILE_SIZE + TILE_SIZE / 2 - this.startPy) * this.moveProgress;
      }
    }

    // Find nearest enemy
    let nearest: Enemy | null = null;
    let nearestDist = Infinity;
    for (const e of enemies) {
      if (e.dead) continue;
      const dist = Math.abs(e.x - this.x) + Math.abs(e.y - this.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = e;
      }
    }

    // Attack adjacent enemy
    if (nearest && nearestDist <= 1 && this.attackCooldown <= 0) {
      this.attackCooldown = 0.8;
      return nearest; // Game.ts handles damage
    }

    // Move toward nearest enemy
    if (!this.moving && nearest && nearestDist > 1) {
      this.moveTimer -= dt;
      if (this.moveTimer <= 0) {
        this.moveTimer = 0.2;
        const step = nextStep(map, this.x, this.y, nearest.x, nearest.y);
        if (step) {
          this.tx = step.x;
          this.ty = step.y;
          this.moving = true;
          this.moveProgress = 0;
          this.startPx = this.px;
          this.startPy = this.py;
        }
      }
    }

    return null;
  }

  takeDamage(amount: number): void {
    this.hp -= amount;
    if (this.hp <= 0) this.dead = true;
  }

  render(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const sx = this.px - camera.x;
    const sy = this.py - camera.y;
    const r = TILE_SIZE * 0.25;

    // Glow
    ctx.beginPath();
    ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
    ctx.fillStyle = this.color + '30';
    ctx.fill();

    // Diamond body
    ctx.beginPath();
    ctx.moveTo(sx, sy - r);
    ctx.lineTo(sx + r, sy);
    ctx.lineTo(sx, sy + r);
    ctx.lineTo(sx - r, sy);
    ctx.closePath();
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff60';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Lifetime ring
    const frac = this.lifetime / (this.lifetime + 1);
    ctx.beginPath();
    ctx.arc(sx, sy, r + 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.strokeStyle = this.color + '80';
    ctx.lineWidth = 1;
    ctx.stroke();

    // HP bar if damaged
    if (this.hp < this.maxHp) {
      const bw = TILE_SIZE * 0.6;
      const bh = 2;
      const bx = sx - bw / 2;
      const by = sy - r - 5;
      ctx.fillStyle = '#330000';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#44ff44';
      ctx.fillRect(bx, by, bw * (this.hp / this.maxHp), bh);
    }
  }
}
