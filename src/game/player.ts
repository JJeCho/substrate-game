import { TILE_SIZE, PLAYER_SPEED, PLAYER_MAX_HP, MUTATION_SLOTS, MUTATION_DECAY_TIME, COLORS, ELEMENT_COLORS, STATUS_TICK_INTERVAL } from './constants';
import { TileType, StatusType } from './types';
import type { GameMap, Direction, MineralData, StatusEffect, Point } from './types';
import { isKeyDown } from './input';
import type { Camera } from './camera';
import { createAbility, createFusedAbility, getAbilityEffect, getFusedAbilityEffect, facingToDelta } from './abilities';
import type { Ability, AbilityEffect } from './abilities';
import { Projectile } from './projectile';
import { evaluateSynergies } from './synergy';
import type { SynergyBonuses } from './synergy';

export class Player {
  x: number;
  y: number;
  px: number;
  py: number;
  tx: number;
  ty: number;

  hp: number = PLAYER_MAX_HP;
  maxHp: number = PLAYER_MAX_HP;
  baseMaxHp: number = PLAYER_MAX_HP;
  speed: number = PLAYER_SPEED;
  facing: Direction = 'right';
  dead = false;

  mutations: (MineralData | null)[] = new Array(MUTATION_SLOTS).fill(null);
  abilities: (Ability | null)[] = new Array(MUTATION_SLOTS).fill(null);
  mutationTimers: number[] = new Array(MUTATION_SLOTS).fill(0);
  elementCounts: number[] = [0, 0, 0, 0, 0, 0];
  coreMutations: Set<number> = new Set();
  synergies: SynergyBonuses = { synergies: [], speedMult: 1, damageMult: 1, maxHpBonus: 0, cooldownMult: 1, lifestealBonus: 0, statusDurationMult: 1, aoeRadiusMult: 1, projectileSpeedMult: 1, burnDamageMult: 1, evolutions: [] };

  /** Set of discovered evolution IDs, passed to synergy evaluation */
  discoveredEvolutions: Set<string> = new Set();

  tendrilBaseDamage = 5;     // base melee damage, upgraded by Tenacity
  mutationDecayBonus = 0;    // seconds subtracted from decay timer (Quick Adaptation)
  rarityBonus = 0;           // added to rarity roll (Mineral Affinity)

  flashTimer = 0;
  attackCooldown = 0;

  // Status effects
  statusEffects: StatusEffect[] = [];
  onStatusTick: ((se: StatusEffect) => void) | null = null;

  // Overload state
  overloadTimer = 0;
  overloadCooldown = 0;

  // Callback set by Game to spawn projectiles
  onProjectile: ((p: Projectile) => void) | null = null;

  private moving = false;
  private moveProgress = 0;
  private startPx = 0;
  private startPy = 0;

  constructor(tileX: number, tileY: number) {
    this.x = tileX;
    this.y = tileY;
    this.tx = tileX;
    this.ty = tileY;
    this.px = tileX * TILE_SIZE + TILE_SIZE / 2;
    this.py = tileY * TILE_SIZE + TILE_SIZE / 2;
  }

  update(dt: number, map: GameMap): void {
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    // Tendril cooldown scales with synergy cooldown reduction; instant during Overload
    if (this.attackCooldown > 0) {
      if (this.overloadTimer > 0) {
        this.attackCooldown = 0;
      } else {
        this.attackCooldown = Math.max(0, this.attackCooldown - dt / Math.max(0.5, this.synergies.cooldownMult));
      }
    }

    // Tick overload
    if (this.overloadTimer > 0) this.overloadTimer -= dt;
    if (this.overloadCooldown > 0) this.overloadCooldown -= dt;

    // Tick ability cooldowns (affected by synergy; instant during overload)
    for (const ability of this.abilities) {
      if (ability && ability.cooldown > 0) {
        if (this.overloadTimer > 0) {
          ability.cooldown = 0; // No cooldowns during overload
        } else {
          ability.cooldown = Math.max(0, ability.cooldown - dt / Math.max(0.5, this.synergies.cooldownMult));
        }
      }
    }

    // Tick mutation decay timers (fused mutations don't decay)
    for (let i = 0; i < MUTATION_SLOTS; i++) {
      if (this.mutations[i] !== null && this.mutationTimers[i] > 0 && !this.mutations[i]!.fused) {
        this.mutationTimers[i] -= dt;
        if (this.mutationTimers[i] <= 0) {
          this.onMutationDecay?.(i);
        }
      }
    }

    // Movement interpolation
    if (this.moving) {
      // Water tile slows movement
      let moveSpeed = this.speed;
      if (this.lastMap) {
        const tile = this.lastMap[this.ty]?.[this.tx];
        if (tile === TileType.Water) moveSpeed *= 0.5;
      }
      this.moveProgress += dt * moveSpeed;
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

    if (!this.moving) {
      let dx = 0;
      let dy = 0;

      if (isKeyDown('KeyW') || isKeyDown('ArrowUp')) { dy = -1; this.facing = 'up'; }
      else if (isKeyDown('KeyS') || isKeyDown('ArrowDown')) { dy = 1; this.facing = 'down'; }
      else if (isKeyDown('KeyA') || isKeyDown('ArrowLeft')) { dx = -1; this.facing = 'left'; }
      else if (isKeyDown('KeyD') || isKeyDown('ArrowRight')) { dx = 1; this.facing = 'right'; }

      if (dx !== 0 || dy !== 0) {
        const nx = this.x + dx;
        const ny = this.y + dy;
        if (this.canMoveTo(nx, ny, map)) {
          this.tx = nx;
          this.ty = ny;
          this.moving = true;
          this.moveProgress = 0;
          this.startPx = this.px;
          this.startPy = this.py;
        }
      }
    }

    // Ability activation — driven by game.ts via useAbilitySlot()

    // Base tendril attack (E key)
    if (isKeyDown('KeyE') && this.attackCooldown <= 0) {
      this.attackCooldown = 0.4;
      // Return attack info to game loop via callback
      this.onTendrilAttack?.();
    }
  }

  onTendrilAttack: (() => void) | null = null;

  useAbility(slot: number): void {
    const ability = this.abilities[slot];
    const mutation = this.mutations[slot];
    if (!ability || !mutation || ability.cooldown > 0) return;

    ability.cooldown = ability.maxCooldown;
    const effect = mutation.fused ? getFusedAbilityEffect(mutation) : getAbilityEffect(ability, mutation);
    // Overload damage boost
    if (this.overloadTimer > 0) {
      effect.damage = Math.round(effect.damage * 1.5);
    }
    // Apply synergy multipliers
    if (this.synergies.projectileSpeedMult !== 1) {
      effect.speed *= this.synergies.projectileSpeedMult;
    }
    if (this.synergies.aoeRadiusMult !== 1 && (effect.type === 'aoe')) {
      effect.radius *= this.synergies.aoeRadiusMult;
    }
    // Apply evolution effects
    for (const evo of this.synergies.evolutions) {
      const r = evo.recipe;
      if (r.id === 'toxic_miasma' && effect.type === 'projectile') effect.leavesCloud = true;
      if (r.id === 'arc_storm' && effect.type === 'teleport') effect.chainOnTeleport = 3;
      if (r.id === 'molten_core' && effect.type === 'shield') effect.shieldExplodes = true;
      if (r.id === 'phantom_strike' && effect.type === 'dash') effect.afterimage = true;
      if (r.id === 'crystal_fortress' && effect.type === 'wall') { effect.duration *= 2; effect.reflectsProjectiles = true; }
      if (r.id === 'life_engine' && effect.type === 'aoe') effect.healsOnHit = true;
    }
    const { dx, dy } = facingToDelta(this.facing);

    if (effect.type === 'projectile' && this.onProjectile) {
      const proj = new Projectile(this.px, this.py, dx, dy, {
        speed: effect.speed * TILE_SIZE,
        damage: effect.damage,
        lifetime: effect.range / effect.speed,
        color: ability.color,
        pierce: effect.pierce,
        explodes: effect.explodes,
        explosionRadius: effect.radius * TILE_SIZE,
        lifesteal: effect.lifesteal,
        statusEffect: effect.statusEffect,
        chain: effect.chain,
        leavesCloud: effect.leavesCloud,
        fromPlayer: true,
      });
      this.onProjectile(proj);
    } else if (effect.type === 'dash') {
      // Dash: move 3 tiles in facing direction instantly
      for (let i = 0; i < 3; i++) {
        const nx = this.x + dx;
        const ny = this.y + dy;
        if (!this.canMoveTo(nx, ny, this.lastMap!)) break;
        this.x = nx;
        this.y = ny;
      }
      this.tx = this.x;
      this.ty = this.y;
      this.px = this.x * TILE_SIZE + TILE_SIZE / 2;
      this.py = this.y * TILE_SIZE + TILE_SIZE / 2;
      this.moving = false;
      // Dash deals damage — handled by game loop proximity check
      this.onDashDamage?.(effect.damage, effect.lifesteal, effect);
    } else if (effect.type === 'aoe') {
      // Area pulse — handled by game loop
      this.onAoePulse?.(effect.damage, effect.radius * TILE_SIZE, effect.lifesteal, effect);
    } else if (effect.type === 'teleport') {
      // Teleport forward
      const dist = 4;
      let finalX = this.x;
      let finalY = this.y;
      for (let i = 1; i <= dist; i++) {
        const cx = this.x + dx * i;
        const cy = this.y + dy * i;
        if (this.canMoveTo(cx, cy, this.lastMap!)) {
          finalX = cx;
          finalY = cy;
        } else {
          break;
        }
      }
      this.x = finalX;
      this.y = finalY;
      this.tx = this.x;
      this.ty = this.y;
      this.px = this.x * TILE_SIZE + TILE_SIZE / 2;
      this.py = this.y * TILE_SIZE + TILE_SIZE / 2;
      this.moving = false;
      this.onTeleport?.();
    } else if (effect.type === 'shield') {
      // Temporary damage reduction
      this.onShieldActivate?.(effect.duration + 1.5, effect);
    } else if (effect.type === 'wall') {
      // Place 3 tiles perpendicular to facing direction
      const perpDx = dy !== 0 ? 1 : 0;
      const perpDy = dx !== 0 ? 1 : 0;
      const cx = this.x + dx;
      const cy = this.y + dy;
      const tiles: Point[] = [];
      for (let offset = -1; offset <= 1; offset++) {
        const wx = cx + perpDx * offset;
        const wy = cy + perpDy * offset;
        if (this.canPlaceWall(wx, wy, this.lastMap!)) {
          tiles.push({ x: wx, y: wy });
        }
      }
      if (tiles.length > 0) {
        this.onWallPlace?.(tiles, effect.duration + 2.0, effect);
      }
    } else if (effect.type === 'beam') {
      this.onBeamFire?.(this.px, this.py, dx, dy, effect, ability.color);
    } else if (effect.type === 'summon') {
      this.onSummon?.(this.x, this.y, effect, ability.color);
    }
  }

  private canPlaceWall(x: number, y: number, map: GameMap): boolean {
    if (y < 0 || y >= map.length || x < 0 || x >= map[0].length) return false;
    const tile = map[y][x];
    return tile === TileType.Floor || tile === TileType.Corridor || tile === TileType.TrapFloor || tile === TileType.Water;
  }

  // Callbacks for ability effects the game loop handles
  onDashDamage: ((damage: number, lifesteal: number, effect: AbilityEffect) => void) | null = null;
  onAoePulse: ((damage: number, radius: number, lifesteal: number, effect: AbilityEffect) => void) | null = null;
  onShieldActivate: ((duration: number, effect: AbilityEffect) => void) | null = null;
  onTeleport: (() => void) | null = null;
  onWallPlace: ((tiles: Point[], duration: number, effect: AbilityEffect) => void) | null = null;
  onBeamFire: ((x: number, y: number, dx: number, dy: number, effect: AbilityEffect, color: string) => void) | null = null;
  onSummon: ((x: number, y: number, effect: AbilityEffect, color: string) => void) | null = null;

  lastMap: GameMap | null = null;

  private canMoveTo(x: number, y: number, map: GameMap): boolean {
    if (y < 0 || y >= map.length || x < 0 || x >= map[0].length) return false;
    const tile = map[y][x];
    return tile !== TileType.Wall && tile !== TileType.LockedDoor && tile !== TileType.CrackedWall;
  }

  consumeMineral(data: MineralData): boolean {
    const emptySlot = this.mutations.indexOf(null);
    if (emptySlot !== -1) {
      this.mutations[emptySlot] = data;
      this.abilities[emptySlot] = createAbility(data);
      this.mutationTimers[emptySlot] = MUTATION_DECAY_TIME - this.mutationDecayBonus;
      this.elementCounts[data.element]++;
      // Check for core mutation (3+ of same element)
      if (this.elementCounts[data.element] >= 3 && !this.coreMutations.has(data.element)) {
        this.coreMutations.add(data.element);
        this.onCoreMutation?.(data.element);
      }
      this.recalcSynergies();
      return true;
    }
    return false;
  }

  /** Fuse two mutation slots into one powerful fused mutation. Returns true if fusion happened. */
  fuseMutations(slotA: number, slotB: number): boolean {
    const a = this.mutations[slotA];
    const b = this.mutations[slotB];
    if (!a || !b || a.fused || b.fused) return false;

    // Create fused mineral data
    const fusedData: MineralData = {
      element: a.element,
      modifier: a.modifier,
      rarity: Math.min(3, Math.max(a.rarity, b.rarity) + 1) as MineralData['rarity'],
      fused: true,
      secondElement: b.element,
      secondModifier: b.modifier,
    };

    // Put fused result in slotA, clear slotB
    this.mutations[slotA] = fusedData;
    this.abilities[slotA] = createFusedAbility(a, b);
    this.mutationTimers[slotA] = 0; // No decay for fused

    this.mutations[slotB] = null;
    this.abilities[slotB] = null;
    this.mutationTimers[slotB] = 0;

    this.recalcSynergies();
    return true;
  }

  /** Trigger overload: self-damage + enter overloaded state. */
  triggerOverload(): void {
    const selfDmg = Math.round(this.maxHp * 0.15);
    this.hp = Math.max(1, this.hp - selfDmg);
    this.overloadTimer = 15; // 15 seconds of power
    this.overloadCooldown = 30;
    this.flashTimer = 0.3;
  }

  get isOverloaded(): boolean {
    return this.overloadTimer > 0;
  }

  dropMutation(slot: number): MineralData | null {
    const data = this.mutations[slot];
    this.mutations[slot] = null;
    this.abilities[slot] = null;
    this.mutationTimers[slot] = 0;
    this.recalcSynergies();
    return data;
  }

  get hasMercuryPassive(): boolean {
    return this.mutations.some(m => m !== null && m.element === 5);
  }

  recalcSynergies(): void {
    this.synergies = evaluateSynergies(this.mutations, this.discoveredEvolutions);

    // Passive mutation perks (per equipped element)
    for (const m of this.mutations) {
      if (m === null) continue;
      switch (m.element) {
        case 0: this.synergies.maxHpBonus += 5; break;       // Iron: +5 HP
        case 1: this.synergies.speedMult += 0.05; break;     // Carbon: +5% speed
        case 2: this.synergies.damageMult += 0.10; break;    // Sulfur: +10% damage
        case 3: this.synergies.cooldownMult -= 0.10; break;  // Silicon: -10% CD
        case 4: this.synergies.lifestealBonus += 0.05; break; // Phosphorus: +5% lifesteal
        // Mercury: minimap reveals enemies (handled in game.ts)
      }
    }

    // Apply max HP bonus
    this.maxHp = this.baseMaxHp + this.synergies.maxHpBonus;
    this.speed = PLAYER_SPEED * this.synergies.speedMult;

    // Core mutations: permanent passives (3+ of same element consumed ever)
    if (this.coreMutations.has(0)) this.maxHp += 20;          // Iron: +20 HP
    if (this.coreMutations.has(1)) this.speed *= 1.15;        // Carbon: +15% speed
    if (this.coreMutations.has(2)) this.synergies.damageMult += 0.2; // Sulfur: +20% damage
    if (this.coreMutations.has(3)) this.synergies.cooldownMult -= 0.15; // Silicon: -15% cooldowns
    if (this.coreMutations.has(4)) this.synergies.lifestealBonus += 0.1; // Phosphorus: +10% lifesteal
    // Mercury: +30% speed during overload (applied in movement)
    if (this.coreMutations.has(5) && this.overloadTimer > 0) this.speed *= 1.3;

    this.hp = Math.min(this.hp, this.maxHp);
  }

  onMutationDecay: ((slot: number) => void) | null = null;
  onCoreMutation: ((element: number) => void) | null = null;

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
          this.hp = Math.max(1, this.hp - se.tickDamage); // Status effects don't kill
          this.flashTimer = 0.05;
          this.onStatusTick?.(se);
        }
      }
    }
    // Reset speed to base before applying slow (prevents compounding each frame)
    this.speed = PLAYER_SPEED * this.synergies.speedMult;
    if (this.coreMutations.has(1)) this.speed *= 1.15;
    if (this.coreMutations.has(5) && this.overloadTimer > 0) this.speed *= 1.3;
    // Apply slow
    const slowEffect = this.statusEffects.find(se => se.type === StatusType.Slow);
    if (slowEffect) {
      this.speed *= slowEffect.slowFactor;
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

  takeDamage(amount: number): void {
    if (this.shieldTimer > 0) amount = Math.round(amount * 0.3);
    this.hp = Math.max(0, this.hp - amount);
    this.flashTimer = 0.15;
    if (this.hp <= 0) this.dead = true;
  }

  heal(amount: number): void {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  shieldTimer = 0;

  get mutationCount(): number {
    return this.mutations.filter(m => m !== null).length;
  }

  render(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const sx = this.px - camera.x;
    const sy = this.py - camera.y;
    const radius = TILE_SIZE * 0.4;

    const equipped = this.mutations.filter((m): m is MineralData => m !== null);
    let color: string = COLORS.player;
    if (equipped.length > 0) {
      let r = 0, g = 0, b = 0;
      for (const m of equipped) {
        const c = ELEMENT_COLORS[m.element];
        r += parseInt(c.slice(1, 3), 16);
        g += parseInt(c.slice(3, 5), 16);
        b += parseInt(c.slice(5, 7), 16);
      }
      r = Math.round(r / equipped.length);
      g = Math.round(g / equipped.length);
      b = Math.round(b / equipped.length);
      color = `rgb(${r},${g},${b})`;
    }

    if (this.flashTimer > 0) color = '#ff4444';

    // Overload glow
    if (this.overloadTimer > 0) {
      const pulse = 0.5 + Math.sin(this.overloadTimer * 8) * 0.3;
      ctx.beginPath();
      ctx.arc(sx, sy, radius + 8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,200,0,${pulse * 0.3})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, radius + 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,150,0,${pulse})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      color = '#ffcc44';
    }

    // Shield visual
    if (this.shieldTimer > 0) {
      ctx.beginPath();
      ctx.arc(sx, sy, radius + 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(138,138,154,0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Organism body
    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Facing indicator
    const faceDx = this.facing === 'right' ? 1 : this.facing === 'left' ? -1 : 0;
    const faceDy = this.facing === 'down' ? 1 : this.facing === 'up' ? -1 : 0;
    ctx.beginPath();
    ctx.arc(sx + faceDx * radius * 0.6, sy + faceDy * radius * 0.6, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }
}
