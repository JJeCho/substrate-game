import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, ELEMENT_COLORS, STATUS_TICK_INTERVAL } from './constants';
import { TileType, StatusType } from './types';
import type { GameMap, MineralData, Room, Point, StatusEffect } from './types';
import type { Camera } from './camera';
import type { Player } from './player';
import type { Mineral } from './minerals';
import { Projectile } from './projectile';
import { findPath } from './pathfinding';

type EnemyState = 'idle' | 'wander' | 'seekMineral' | 'chase' | 'attack' | 'shoot';
export type EnemyType = 'crawler' | 'spitter' | 'feeder' | 'boss';

const ENEMY_STATS: Record<string, { hp: number; speed: number; damage: number; sightRange: number; color: string }> = {
  crawler: { hp: 30, speed: 3.5, damage: 10, sightRange: 6, color: '#cc4444' },
  spitter: { hp: 18, speed: 2.5, damage: 5, sightRange: 9, color: '#cc8844' },
  feeder: { hp: 25, speed: 4.5, damage: 5, sightRange: 7, color: '#44cc44' },
  boss: { hp: 200, speed: 2.5, damage: 15, sightRange: 12, color: '#ff4488' },
};

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class Enemy {
  x: number;
  y: number;
  px: number;
  py: number;
  tx: number;
  ty: number;

  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  sightRange: number;
  baseColor: string;
  type: EnemyType;

  state: EnemyState = 'idle';
  dead = false;
  mutation: MineralData | null = null;
  flashTimer = 0;

  // Status effects
  statusEffects: StatusEffect[] = [];

  // Boss fields
  isBoss = false;
  bossPhase: 'idle' | 'charge' | 'slam' | 'summon' = 'idle';
  bossAttackTimer = 0;

  // Callbacks
  onShoot: ((p: Projectile) => void) | null = null;
  onBossSlam: (() => void) | null = null;
  onBossSummon: (() => void) | null = null;

  // Movement interpolation
  private moving = false;
  private moveProgress = 0;
  private startPx = 0;
  private startPy = 0;
  private idleTimer = 0;
  private attackCooldown = 0;
  private shootCooldown = 0;

  // Pathfinding cache
  private cachedPath: Point[] | null = null;
  private pathAge = 0;
  private pathTargetX = 0;
  private pathTargetY = 0;

  constructor(tileX: number, tileY: number, type: EnemyType) {
    const stats = ENEMY_STATS[type];
    this.x = tileX;
    this.y = tileY;
    this.tx = tileX;
    this.ty = tileY;
    this.px = tileX * TILE_SIZE + TILE_SIZE / 2;
    this.py = tileY * TILE_SIZE + TILE_SIZE / 2;
    this.hp = stats.hp;
    this.maxHp = stats.hp;
    this.speed = stats.speed;
    this.damage = stats.damage;
    this.sightRange = stats.sightRange;
    this.baseColor = stats.color;
    this.type = type;
    if (type === 'boss') this.isBoss = true;
  }

  static createBoss(tileX: number, tileY: number, floorDepth: number): Enemy {
    const boss = new Enemy(tileX, tileY, 'boss');
    const scale = 1 + (floorDepth - 1) * 0.2;
    boss.hp = Math.round(200 * scale);
    boss.maxHp = boss.hp;
    boss.damage = Math.round(15 * scale);
    return boss;
  }

  update(dt: number, map: GameMap, player: Player, minerals: Mineral[]): void {
    if (this.dead) return;

    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.shootCooldown = Math.max(0, this.shootCooldown - dt);
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.pathAge += dt;

    // Apply slow from status effects
    let speedMult = 1;
    for (const se of this.statusEffects) {
      if (se.type === StatusType.Slow) speedMult = Math.min(speedMult, se.slowFactor);
    }
    // Water tile slows enemies
    if (map[this.y]?.[this.x] === TileType.Water) speedMult *= 0.5;

    // Handle movement interpolation
    if (this.moving) {
      this.moveProgress += dt * this.speed * speedMult;
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
      return;
    }

    // Boss has its own AI
    if (this.isBoss) {
      this.bossUpdate(dt, map, player);
      return;
    }

    const distToPlayer = Math.abs(this.x - player.x) + Math.abs(this.y - player.y);

    if (this.type === 'spitter' && distToPlayer <= this.sightRange && distToPlayer > 2 && this.shootCooldown <= 0) {
      this.state = 'shoot';
    } else if (distToPlayer <= 1 && this.attackCooldown <= 0) {
      this.state = 'attack';
    } else if (distToPlayer <= this.sightRange) {
      if (this.type === 'feeder' && this.mutation === null) {
        const nearestMineral = this.findNearestMineral(minerals);
        this.state = nearestMineral ? 'seekMineral' : 'chase';
      } else {
        this.state = 'chase';
      }
    } else {
      this.state = 'wander';
    }

    switch (this.state) {
      case 'attack':
        player.takeDamage(this.damage);
        // Mutated enemies apply status effects
        if (this.mutation) {
          this.applyMutationStatus(player);
        }
        this.attackCooldown = 0.8;
        break;

      case 'shoot': {
        const pdx = player.px - this.px;
        const pdy = player.py - this.py;
        const len = Math.sqrt(pdx * pdx + pdy * pdy);
        if (len > 0 && this.onShoot) {
          const proj = new Projectile(this.px, this.py, pdx / len, pdy / len, {
            speed: TILE_SIZE * 6,
            damage: this.damage,
            lifetime: 1.2,
            color: this.mutation ? ELEMENT_COLORS[this.mutation.element] : this.baseColor,
            fromPlayer: false,
          });
          this.onShoot(proj);
        }
        this.shootCooldown = 1.8;
        this.moveAwayFrom(player.x, player.y, map);
        break;
      }

      case 'chase':
        this.moveToward(player.x, player.y, map);
        break;

      case 'seekMineral': {
        const target = this.findNearestMineral(minerals);
        if (target) {
          if (target.x === this.x && target.y === this.y) {
            target.consumed = true;
            this.mutation = target.data;
            this.hp = Math.min(this.maxHp + 10, this.hp + 15);
            this.maxHp += 10;
            this.damage += 3;
          } else {
            this.moveToward(target.x, target.y, map);
          }
        } else {
          this.wander(map);
        }
        break;
      }

      case 'wander':
        this.wander(map);
        break;
    }
  }

  private bossUpdate(dt: number, map: GameMap, player: Player): void {
    this.bossAttackTimer = Math.max(0, this.bossAttackTimer - dt);
    if (this.bossAttackTimer > 0) return;

    const dist = Math.abs(this.x - player.x) + Math.abs(this.y - player.y);
    const hpPercent = this.hp / this.maxHp;

    if (dist <= 2 && this.attackCooldown <= 0) {
      // AoE slam
      this.bossPhase = 'slam';
      this.bossAttackTimer = 1.5;
      this.attackCooldown = 1.5;
      this.onBossSlam?.();
    } else if (dist > 2 && hpPercent < 0.5 && Math.random() < 0.15) {
      // Summon minions
      this.bossPhase = 'summon';
      this.bossAttackTimer = 2.0;
      this.onBossSummon?.();
    } else if (dist <= this.sightRange) {
      // Charge toward player
      this.bossPhase = 'charge';
      this.moveToward(player.x, player.y, map);
    } else {
      this.moveToward(player.x, player.y, map);
    }
  }

  private applyMutationStatus(player: Player): void {
    if (!this.mutation) return;
    const elem = this.mutation.element;
    // Sulfur=Poison, Carbon=Burn, Mercury=Slow (weaker versions from enemies)
    if (elem === 2) {
      player.applyStatusEffect({ type: StatusType.Poison, duration: 3, tickTimer: STATUS_TICK_INTERVAL, tickDamage: 1, slowFactor: 1 });
    } else if (elem === 1) {
      player.applyStatusEffect({ type: StatusType.Burn, duration: 1.5, tickTimer: STATUS_TICK_INTERVAL, tickDamage: 2, slowFactor: 1 });
    } else if (elem === 5) {
      player.applyStatusEffect({ type: StatusType.Slow, duration: 2, tickTimer: 0, tickDamage: 0, slowFactor: 0.6 });
    }
  }

  updateStatusEffects(dt: number): void {
    for (let i = this.statusEffects.length - 1; i >= 0; i--) {
      const se = this.statusEffects[i];
      se.duration -= dt;
      if (se.duration <= 0) {
        this.statusEffects.splice(i, 1);
        continue;
      }
      if (se.tickDamage > 0) {
        se.tickTimer -= dt;
        if (se.tickTimer <= 0) {
          se.tickTimer += STATUS_TICK_INTERVAL;
          this.hp -= se.tickDamage;
          this.flashTimer = 0.05;
          if (this.hp <= 0) this.dead = true;
        }
      }
    }
  }

  applyStatusEffect(effect: StatusEffect): void {
    const existing = this.statusEffects.find(se => se.type === effect.type);
    if (existing) {
      existing.duration = Math.max(existing.duration, effect.duration);
      existing.tickDamage = Math.max(existing.tickDamage, effect.tickDamage);
      existing.slowFactor = Math.min(existing.slowFactor, effect.slowFactor);
    } else {
      this.statusEffects.push({ ...effect });
    }
  }

  private findNearestMineral(minerals: Mineral[]): Mineral | null {
    let best: Mineral | null = null;
    let bestDist = Infinity;
    for (const m of minerals) {
      if (m.consumed) continue;
      const dist = Math.abs(m.x - this.x) + Math.abs(m.y - this.y);
      if (dist < bestDist && dist < 10) {
        bestDist = dist;
        best = m;
      }
    }
    return best;
  }

  private wander(map: GameMap): void {
    this.idleTimer -= 0.15;
    if (this.idleTimer > 0) return;
    this.idleTimer = randInt(1, 4) * 0.2;

    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    const [dx, dy] = dirs[randInt(0, 3)];
    const nx = this.x + dx;
    const ny = this.y + dy;
    if (this.canMove(nx, ny, map)) {
      this.startMove(nx, ny);
    }
  }

  private moveToward(targetX: number, targetY: number, map: GameMap): void {
    // Recalculate A* path if stale or target moved
    const targetMoved = targetX !== this.pathTargetX || targetY !== this.pathTargetY;
    if (!this.cachedPath || this.cachedPath.length === 0 || this.pathAge >= 0.5 || targetMoved) {
      this.cachedPath = findPath(map, this.x, this.y, targetX, targetY, 15);
      this.pathAge = 0;
      this.pathTargetX = targetX;
      this.pathTargetY = targetY;
    }

    if (this.cachedPath && this.cachedPath.length > 0) {
      const next = this.cachedPath[0];
      if (this.canMove(next.x, next.y, map)) {
        this.startMove(next.x, next.y);
        this.cachedPath.shift();
        return;
      }
      this.cachedPath = null;
    }

    // Fallback: greedy
    this.greedyMoveToward(targetX, targetY, map);
  }

  private greedyMoveToward(targetX: number, targetY: number, map: GameMap): void {
    const dx = Math.sign(targetX - this.x);
    const dy = Math.sign(targetY - this.y);

    const candidates: [number, number][] = [];
    if (Math.abs(targetX - this.x) >= Math.abs(targetY - this.y)) {
      if (dx !== 0) candidates.push([dx, 0]);
      if (dy !== 0) candidates.push([0, dy]);
    } else {
      if (dy !== 0) candidates.push([0, dy]);
      if (dx !== 0) candidates.push([dx, 0]);
    }

    for (const [cx, cy] of candidates) {
      const nx = this.x + cx;
      const ny = this.y + cy;
      if (this.canMove(nx, ny, map)) {
        this.startMove(nx, ny);
        return;
      }
    }
  }

  private moveAwayFrom(targetX: number, targetY: number, map: GameMap): void {
    const dx = Math.sign(this.x - targetX);
    const dy = Math.sign(this.y - targetY);
    // Try all 4 dirs sorted by distance from target
    const dirs: [number, number][] = [[dx, 0], [0, dy], [-dx, 0], [0, -dy]].filter(([d]) => d !== 0 || true) as [number, number][];
    for (const [cx, cy] of dirs) {
      if (cx === 0 && cy === 0) continue;
      const nx = this.x + cx;
      const ny = this.y + cy;
      if (this.canMove(nx, ny, map)) {
        this.startMove(nx, ny);
        return;
      }
    }
  }

  private canMove(x: number, y: number, map: GameMap): boolean {
    if (y < 0 || y >= MAP_HEIGHT || x < 0 || x >= MAP_WIDTH) return false;
    return map[y][x] !== TileType.Wall;
  }

  private startMove(nx: number, ny: number): void {
    this.tx = nx;
    this.ty = ny;
    this.moving = true;
    this.moveProgress = 0;
    this.startPx = this.px;
    this.startPy = this.py;
  }

  takeDamage(amount: number): void {
    this.hp -= amount;
    this.flashTimer = 0.15;
    if (this.hp <= 0) {
      this.dead = true;
    }
  }

  render(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (this.dead) return;

    const sx = this.px - camera.x;
    const sy = this.py - camera.y;

    // Boss rendering
    if (this.isBoss) {
      this.renderBoss(ctx, sx, sy);
      return;
    }

    const sizeScale = 0.35 + (this.maxHp - 30) * 0.003;
    const radius = TILE_SIZE * Math.min(sizeScale, 0.55);

    let color = this.baseColor;
    if (this.mutation) color = ELEMENT_COLORS[this.mutation.element];
    if (this.flashTimer > 0) color = '#ffffff';

    // Status effect tint under enemy
    for (const se of this.statusEffects) {
      const statusColors = ['#88cc2240', '#ff662240', '#9999cc40'];
      ctx.beginPath();
      ctx.arc(sx, sy, radius + 2, 0, Math.PI * 2);
      ctx.fillStyle = statusColors[se.type] || '#ffffff20';
      ctx.fill();
    }

    ctx.fillStyle = color;
    ctx.beginPath();
    if (this.type === 'crawler') {
      ctx.rect(sx - radius, sy - radius, radius * 2, radius * 2);
    } else if (this.type === 'spitter') {
      ctx.moveTo(sx, sy - radius * 1.1);
      ctx.lineTo(sx + radius, sy + radius * 0.8);
      ctx.lineTo(sx - radius, sy + radius * 0.8);
      ctx.closePath();
    } else {
      ctx.moveTo(sx, sy - radius);
      ctx.lineTo(sx + radius, sy);
      ctx.lineTo(sx, sy + radius);
      ctx.lineTo(sx - radius, sy);
      ctx.closePath();
    }
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // HP bar
    if (this.hp < this.maxHp) {
      const barW = TILE_SIZE;
      const barH = 3;
      const barX = sx - barW / 2;
      const barY = sy - radius - 6;
      ctx.fillStyle = '#330000';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = '#cc2222';
      ctx.fillRect(barX, barY, barW * (this.hp / this.maxHp), barH);
    }

    if (this.mutation) {
      ctx.beginPath();
      ctx.arc(sx, sy, radius * 0.25, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }

    ctx.fillStyle = '#888';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(this.type, sx, sy - radius - (this.hp < this.maxHp ? 10 : 4));
    ctx.textAlign = 'start';
  }

  private renderBoss(ctx: CanvasRenderingContext2D, sx: number, sy: number): void {
    const bossRadius = TILE_SIZE * 0.7;

    // Pulsing aura
    const pulse = 0.5 + Math.sin(Date.now() / 200) * 0.3;
    ctx.beginPath();
    ctx.arc(sx, sy, bossRadius + 6, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,68,136,${pulse * 0.2})`;
    ctx.fill();

    // Status tint
    for (const se of this.statusEffects) {
      const statusColors = ['#88cc2240', '#ff662240', '#9999cc40'];
      ctx.beginPath();
      ctx.arc(sx, sy, bossRadius + 3, 0, Math.PI * 2);
      ctx.fillStyle = statusColors[se.type] || '#ffffff20';
      ctx.fill();
    }

    // Hexagonal body
    const color = this.flashTimer > 0 ? '#ffffff' : this.baseColor;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (i * Math.PI * 2) / 6 - Math.PI / 2;
      const method = i === 0 ? 'moveTo' : 'lineTo';
      ctx[method](sx + Math.cos(angle) * bossRadius, sy + Math.sin(angle) * bossRadius);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ff88aa';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner eye
    ctx.beginPath();
    ctx.arc(sx, sy, bossRadius * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Label
    ctx.fillStyle = '#ff88aa';
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('GUARDIAN', sx, sy - bossRadius - 4);
    ctx.textAlign = 'start';
  }
}

export function spawnEnemies(rooms: Room[], map: GameMap, floorDepth: number = 1, isBossFloor: boolean = false): Enemy[] {
  const enemies: Enemy[] = [];
  const types: EnemyType[] = ['crawler', 'spitter', 'feeder'];

  const maxPerRoom = isBossFloor
    ? Math.max(1, Math.floor((2 + Math.floor(floorDepth / 2)) * 0.5))
    : Math.min(2 + Math.floor(floorDepth / 2), 5);

  for (let i = 1; i < rooms.length; i++) {
    const room = rooms[i];
    const count = randInt(1, maxPerRoom);

    for (let j = 0; j < count; j++) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const ex = room.x + randInt(1, room.width - 2);
        const ey = room.y + randInt(1, room.height - 2);
        if (map[ey][ex] !== TileType.Wall) {
          const occupied = enemies.some(e => e.x === ex && e.y === ey);
          if (!occupied) {
            const enemy = new Enemy(ex, ey, types[randInt(0, 2)]);
            if (floorDepth > 1) {
              const scale = 1 + (floorDepth - 1) * 0.15;
              enemy.hp = Math.round(enemy.hp * scale);
              enemy.maxHp = enemy.hp;
              enemy.damage = Math.round(enemy.damage * scale);
            }
            enemies.push(enemy);
            break;
          }
        }
      }
    }
  }

  return enemies;
}
