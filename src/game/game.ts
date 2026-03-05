import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, VISION_RADIUS, COMBO_WINDOW, ELEMENT_COLORS, ELEMENT_NAMES, MODIFIER_NAMES, STATUS_COLORS, STATUS_TICK_INTERVAL } from './constants';
import { TileType, StatusType, BuffType } from './types';
import type { GameMap, TaggedRoom, ActiveBuff, Point, StatusEffect } from './types';
import { generateDungeon } from './dungeon';
import { Camera } from './camera';
import { Player } from './player';
import { Projectile } from './projectile';
import { Mineral, HealthPickup, spawnMinerals, spawnHealthPickups, generateMineral } from './minerals';
import { Enemy, spawnEnemies } from './enemy';
import { Ally } from './ally';
import { initInput, wasKeyPressed } from './input';
import { renderMap, renderMinerals, renderHealthPickups } from './renderer';
import { renderHud } from './hud';
import { facingToDelta } from './abilities';
import type { AbilityEffect } from './abilities';
import { addFloatingText, updateFloatingText, renderFloatingText } from './floatingText';
import { addRing, addFlash, addTrail, updateVfx, renderVfx } from './vfx';
import { loadProgress, saveProgress, calculateRunReward, getUpgradeLevel, canBuyUpgrade, buyUpgrade, UPGRADES } from './progression';
import type { MetaProgress } from './progression';
import { EVOLUTION_RECIPES } from './evolutions';

export class Game {
  private ctx: CanvasRenderingContext2D;
  private canvasW: number;
  private canvasH: number;

  map!: GameMap;
  rooms!: TaggedRoom[];
  player!: Player;
  minerals!: Mineral[];
  enemies!: Enemy[];
  healthPickups!: HealthPickup[];
  projectiles: Projectile[] = [];
  camera: Camera = new Camera();

  private lastTime = 0;
  private gameTime = 0;
  selectedSlot = 0;
  nearbyMineral: Mineral | null = null;
  floor = 1;
  private stairsX = 0;
  private stairsY = 0;

  // Kill chain combo
  comboCount = 0;
  comboTimer = 0;

  // Boss state
  bossAlive = false;

  // Trap damage tracking
  private playerOnTrap = false;
  private lastTrapX = -1;
  private lastTrapY = -1;

  // New Phase 7 state
  allies: Ally[] = [];
  temporaryWalls: { x: number; y: number; timer: number; originalTile: TileType }[] = [];
  activeBeams: { x: number; y: number; dx: number; dy: number; damage: number; range: number; tickTimer: number; duration: number; color: string; lifesteal: number; statusEffect: StatusEffect | null }[] = [];
  poisonClouds: { x: number; y: number; damage: number; timer: number; radius: number }[] = [];
  keys = 0;
  shrineUsed = false;
  activeBuffs: ActiveBuff[] = [];
  private afterimageTimer = 0;
  private afterimageDmg = 0;
  private afterimageLs = 0;
  private lavaTickTimer = 0;

  // Run tracking for progression
  runKills = 0;
  runBossKills = 0;
  progress: MetaProgress;
  private showUpgradeScreen = false;

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.canvasW = canvas.width;
    this.canvasH = canvas.height;
    this.progress = loadProgress();
    initInput();
  }

  init(): void {
    this.floor = 1;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.runKills = 0;
    this.runBossKills = 0;
    this.showUpgradeScreen = false;
    this.progress = loadProgress();
    this.initFloor(true);
  }

  private initFloor(isNewGame: boolean): void {
    const { map, rooms } = generateDungeon(this.floor);
    this.map = map;
    this.rooms = rooms;
    this.projectiles = [];
    this.bossAlive = false;
    this.playerOnTrap = false;
    this.lastTrapX = -1;
    this.lastTrapY = -1;
    this.allies = [];
    this.temporaryWalls = [];
    this.activeBeams = [];
    this.poisonClouds = [];
    this.shrineUsed = false;
    this.activeBuffs = [];
    this.lavaTickTimer = 0;
    if (isNewGame) this.keys = 0;

    const lastRoom = this.rooms[this.rooms.length - 1];
    this.stairsX = Math.floor(lastRoom.x + lastRoom.width / 2);
    this.stairsY = Math.floor(lastRoom.y + lastRoom.height / 2);
    this.map[this.stairsY][this.stairsX] = TileType.Stairs;

    const startRoom = this.rooms[0];
    const px = Math.floor(startRoom.x + startRoom.width / 2);
    const py = Math.floor(startRoom.y + startRoom.height / 2);

    if (isNewGame) {
      this.player = new Player(px, py);
    } else {
      this.player.x = px;
      this.player.y = py;
      this.player.tx = px;
      this.player.ty = py;
      this.player.px = px * TILE_SIZE + TILE_SIZE / 2;
      this.player.py = py * TILE_SIZE + TILE_SIZE / 2;
      this.player.statusEffects = [];
    }
    this.player.lastMap = this.map;

    // Apply progression upgrades
    if (isNewGame) {
      const toughLvl = getUpgradeLevel(this.progress, 'tough');
      if (toughLvl > 0) {
        this.player.baseMaxHp += toughLvl * 5;
        this.player.maxHp = this.player.baseMaxHp;
        this.player.hp = this.player.maxHp;
      }
      // Load discovered evolutions
      this.player.discoveredEvolutions = new Set(this.progress.discoveredEvolutions);

      // Starting mutation upgrade
      const startMutLvl = getUpgradeLevel(this.progress, 'startmut');
      if (startMutLvl > 0) {
        const startMineral = generateMineral(1);
        startMineral.rarity = Math.min(2, startMutLvl - 1) as typeof startMineral.rarity;
        this.player.consumeMineral(startMineral);
      }
    }

    this.player.onProjectile = (p) => this.projectiles.push(p);
    this.player.onTendrilAttack = () => this.handleTendrilAttack();
    this.player.onDashDamage = (dmg, ls, effect) => this.handleDashDamage(dmg, ls, effect);
    this.player.onAoePulse = (dmg, r, ls, effect) => this.handleAoePulse(dmg, r, ls, effect);
    this.player.onShieldActivate = (dur, effect) => {
      this.player.shieldTimer = dur;
      addRing(this.player.px, this.player.py, TILE_SIZE * 2, '#4488ff', 0.5);
      // Molten Core evolution: schedule explosion on shield expiry
      if (effect.shieldExplodes) {
        // We'll check shieldTimer reaching 0 in update
      }
    };
    this.player.onWallPlace = (tiles, dur, effect) => this.handleWallPlace(tiles, dur, effect);
    this.player.onBeamFire = (x, y, ddx, ddy, effect, color) => this.handleBeamFire(x, y, ddx, ddy, effect, color);
    this.player.onSummon = (x, y, effect, color) => this.handleSummon(x, y, effect, color);
    this.player.onMutationDecay = (slot) => this.handleMutationDecay(slot);
    this.player.onCoreMutation = (elem) => {
      addFloatingText(this.player.px, this.player.py - TILE_SIZE * 1.5, `CORE: ${ELEMENT_NAMES[elem]}!`, ELEMENT_COLORS[elem], 2.0);
      this.camera.shake(6, 0.4);
    };
    this.player.onStatusTick = (se) => {
      const colors = [STATUS_COLORS[StatusType.Poison], STATUS_COLORS[StatusType.Burn], STATUS_COLORS[StatusType.Slow]];
      addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.3, `-${se.tickDamage}`, colors[se.type] || '#ffffff', 0.5);
      addTrail(this.player.px, this.player.py, colors[se.type] || '#ffffff');
    };

    this.minerals = spawnMinerals(this.rooms, this.map, this.floor);
    this.healthPickups = spawnHealthPickups(this.rooms, this.map, this.floor);

    // Boss floors: every 3rd floor
    const isBossFloor = this.floor % 3 === 0;
    this.enemies = spawnEnemies(this.rooms, this.map, this.floor, isBossFloor);

    if (isBossFloor) {
      // Spawn boss in largest non-start room
      let bestRoom = this.rooms[1];
      let bestArea = 0;
      for (let i = 1; i < this.rooms.length - 1; i++) {
        const area = this.rooms[i].width * this.rooms[i].height;
        if (area > bestArea) {
          bestArea = area;
          bestRoom = this.rooms[i];
        }
      }
      const bx = Math.floor(bestRoom.x + bestRoom.width / 2);
      const by = Math.floor(bestRoom.y + bestRoom.height / 2);
      const boss = Enemy.createBoss(bx, by, this.floor);
      boss.onShoot = (p) => this.projectiles.push(p);
      boss.onBossSlam = () => this.handleBossSlam(boss);
      boss.onBossSummon = () => this.handleBossSummon(boss);
      this.enemies.push(boss);
      this.bossAlive = true;
    }

    for (const enemy of this.enemies) {
      if (!enemy.onShoot) enemy.onShoot = (p) => this.projectiles.push(p);
    }

    this.camera.follow(
      this.player.px, this.player.py,
      this.canvasW, this.canvasH, MAP_WIDTH, MAP_HEIGHT,
    );
  }

  private handleMutationDecay(slot: number): void {
    const data = this.player.mutations[slot];
    if (data) {
      const name = `${MODIFIER_NAMES[data.modifier]} ${ELEMENT_NAMES[data.element]}`;
      addFloatingText(this.player.px, this.player.py - TILE_SIZE, `${name} decayed!`, '#886644', 1.5);
      this.player.mutations[slot] = null;
      this.player.abilities[slot] = null;
      this.player.mutationTimers[slot] = 0;
      this.player.recalcSynergies();
    }
  }

  private descend(): void {
    this.floor++;
    addFloatingText(this.player.px, this.player.py - TILE_SIZE * 1.5, `FLOOR ${this.floor}`, '#e0a030', 2.0);
    this.camera.shake(4, 0.3);
    this.initFloor(false);
  }

  private get comboMult(): number {
    if (this.comboCount <= 0) return 1;
    return 1 + this.comboCount * 0.15;
  }

  start(): void {
    this.lastTime = performance.now();
    this.loop(this.lastTime);
  }

  private loop = (now: number): void => {
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.gameTime += dt;

    this.update(dt);
    this.render();
    requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    if (this.player.dead) {
      if (wasKeyPressed('KeyR')) this.init();
      // Upgrade purchases via number keys on death screen
      if (this.showUpgradeScreen) {
        for (let i = 0; i < UPGRADES.length && i < 5; i++) {
          if (wasKeyPressed(`Digit${i + 1}`)) {
            if (canBuyUpgrade(this.progress, UPGRADES[i])) {
              buyUpgrade(this.progress, UPGRADES[i]);
              saveProgress(this.progress);
            }
          }
        }
      }
      return;
    }

    this.camera.updateShake(dt);
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.comboCount = 0;
    }

    this.player.shieldTimer = Math.max(0, this.player.shieldTimer - dt);
    this.player.update(dt, this.map);
    this.player.updateStatusEffects(dt);
    updateFloatingText(dt);
    updateVfx(dt);

    // Trap tile damage
    const currentTile = this.map[this.player.y]?.[this.player.x];
    if (currentTile === TileType.TrapFloor) {
      if (!this.playerOnTrap || this.player.x !== this.lastTrapX || this.player.y !== this.lastTrapY) {
        const trapDmg = 5 + this.floor * 2;
        this.player.takeDamage(trapDmg);
        this.player.applyStatusEffect({ type: StatusType.Burn, duration: 1.5, tickTimer: 0.5, tickDamage: 2, slowFactor: 1 });
        addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, `-${trapDmg} TRAP!`, '#ff4444', 0.8);
        addFlash(this.player.px, this.player.py, TILE_SIZE * 0.5, '#ff4400', 0.15);
        this.camera.shake(2, 0.1);
        this.playerOnTrap = true;
        this.lastTrapX = this.player.x;
        this.lastTrapY = this.player.y;
      }
    } else {
      this.playerOnTrap = false;
    }

    // Lava tile damage (player)
    if (currentTile === TileType.Lava) {
      this.lavaTickTimer -= dt;
      if (this.lavaTickTimer <= 0) {
        this.lavaTickTimer = STATUS_TICK_INTERVAL;
        this.player.takeDamage(8);
        this.player.applyStatusEffect({ type: StatusType.Burn, duration: 2, tickTimer: STATUS_TICK_INTERVAL, tickDamage: 4, slowFactor: 1 });
        addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, '-8 LAVA!', '#ff6600', 0.5);
        addFlash(this.player.px, this.player.py, TILE_SIZE * 0.3, '#ff4400', 0.1);
      }
    } else {
      this.lavaTickTimer = 0;
    }

    // Locked door interaction
    if (!this.player.dead) {
      const { dx: faceDx, dy: faceDy } = facingToDelta(this.player.facing);
      const frontX = this.player.x + faceDx;
      const frontY = this.player.y + faceDy;
      if (frontY >= 0 && frontY < MAP_HEIGHT && frontX >= 0 && frontX < MAP_WIDTH) {
        if (this.map[frontY][frontX] === TileType.LockedDoor) {
          if (wasKeyPressed('Space') && this.keys > 0) {
            this.keys--;
            this.map[frontY][frontX] = TileType.Corridor;
            addFloatingText(this.player.px, this.player.py - TILE_SIZE, 'UNLOCKED!', '#e0a030', 1.5);
            addRing(frontX * TILE_SIZE + TILE_SIZE / 2, frontY * TILE_SIZE + TILE_SIZE / 2, TILE_SIZE * 2, '#e0a030', 0.5);
            this.camera.shake(3, 0.2);
          }
        }
      }
    }

    // Shrine interaction
    if (!this.shrineUsed) {
      let onShrine = false;
      for (const room of this.rooms) {
        if (room.roomType !== 4) continue; // Shrine
        const cx = Math.floor(room.x + room.width / 2);
        const cy = Math.floor(room.y + room.height / 2);
        if (this.player.x === cx && this.player.y === cy) {
          onShrine = true;
          break;
        }
      }
      if (onShrine && wasKeyPressed('Space')) {
        this.shrineUsed = true;
        const buffs: { type: BuffType; mag: number; dur: number; name: string }[] = [
          { type: BuffType.DamageUp, mag: 0.3, dur: 45, name: 'DAMAGE UP' },
          { type: BuffType.SpeedUp, mag: 0.25, dur: 45, name: 'SPEED UP' },
          { type: BuffType.Regen, mag: 2, dur: 30, name: 'REGEN' },
          { type: BuffType.CooldownDown, mag: 0.3, dur: 45, name: 'QUICK CAST' },
          { type: BuffType.Shield, mag: 30, dur: 999, name: 'FORTIFY' },
        ];
        const chosen = buffs[Math.floor(Math.random() * buffs.length)];
        this.activeBuffs.push({ type: chosen.type, duration: chosen.dur, magnitude: chosen.mag });
        if (chosen.type === BuffType.Shield) {
          this.player.baseMaxHp += chosen.mag;
          this.player.maxHp += chosen.mag;
          this.player.hp += chosen.mag;
        }
        addFloatingText(this.player.px, this.player.py - TILE_SIZE * 2, chosen.name, '#cc88ff', 2.0);
        addRing(this.player.px, this.player.py, TILE_SIZE * 3, '#cc88ff', 0.6);
        this.camera.shake(4, 0.3);
      }
    }

    // Update active buffs
    for (let i = this.activeBuffs.length - 1; i >= 0; i--) {
      const buff = this.activeBuffs[i];
      buff.duration -= dt;
      if (buff.duration <= 0) {
        if (buff.type === BuffType.Shield) {
          this.player.baseMaxHp -= buff.magnitude;
          this.player.recalcSynergies();
        }
        this.activeBuffs.splice(i, 1);
      }
      // Regen tick
      if (buff.type === BuffType.Regen) {
        this.player.heal(Math.round(buff.magnitude * dt));
      }
    }

    // Apply buff bonuses to player synergies (recalculated each frame for simplicity)
    for (const buff of this.activeBuffs) {
      if (buff.type === BuffType.DamageUp) this.player.synergies.damageMult += buff.magnitude;
      if (buff.type === BuffType.SpeedUp) this.player.speed *= (1 + buff.magnitude);
      if (buff.type === BuffType.CooldownDown) this.player.synergies.cooldownMult -= buff.magnitude;
    }

    // Update temporary walls
    for (let i = this.temporaryWalls.length - 1; i >= 0; i--) {
      const wall = this.temporaryWalls[i];
      wall.timer -= dt;
      if (wall.timer <= 0) {
        this.map[wall.y][wall.x] = wall.originalTile;
        this.temporaryWalls.splice(i, 1);
      }
    }

    // Update active beams
    for (let i = this.activeBeams.length - 1; i >= 0; i--) {
      const beam = this.activeBeams[i];
      beam.duration -= dt;
      if (beam.duration <= 0) {
        this.activeBeams.splice(i, 1);
        continue;
      }
      // Update beam origin to player position
      beam.x = this.player.px;
      beam.y = this.player.py;
      beam.tickTimer -= dt;
      if (beam.tickTimer <= 0) {
        beam.tickTimer = 0.15;
        // Line trace and damage enemies
        const dmgMult = this.player.synergies.damageMult * this.comboMult;
        for (let step = 1; step <= beam.range / TILE_SIZE; step++) {
          const bx = beam.x + beam.dx * step * TILE_SIZE;
          const by = beam.y + beam.dy * step * TILE_SIZE;
          const tx = Math.floor(bx / TILE_SIZE);
          const ty = Math.floor(by / TILE_SIZE);
          if (tx < 0 || tx >= MAP_WIDTH || ty < 0 || ty >= MAP_HEIGHT) break;
          if (this.map[ty][tx] === TileType.Wall || this.map[ty][tx] === TileType.LockedDoor) break;
          for (const enemy of this.enemies) {
            if (enemy.dead) continue;
            const edx = enemy.px - bx;
            const edy = enemy.py - by;
            if (edx * edx + edy * edy < (TILE_SIZE * 0.7) ** 2) {
              const finalDmg = Math.round(beam.damage * 0.3 * dmgMult);
              enemy.takeDamage(finalDmg);
              addFloatingText(enemy.px, enemy.py - TILE_SIZE * 0.5, `-${finalDmg}`, '#ff4444', 0.3);
              if (beam.lifesteal > 0) this.player.heal(Math.round(finalDmg * beam.lifesteal));
              if (beam.statusEffect) enemy.applyStatusEffect(beam.statusEffect);
              if (enemy.dead) this.onEnemyDeath(enemy);
            }
          }
        }
      }
    }

    // Update poison clouds
    for (let i = this.poisonClouds.length - 1; i >= 0; i--) {
      const cloud = this.poisonClouds[i];
      cloud.timer -= dt;
      if (cloud.timer <= 0) {
        this.poisonClouds.splice(i, 1);
        continue;
      }
      // Damage enemies in cloud every 0.5s
      for (const enemy of this.enemies) {
        if (enemy.dead) continue;
        const cdx = enemy.px - cloud.x;
        const cdy = enemy.py - cloud.y;
        if (cdx * cdx + cdy * cdy < cloud.radius * cloud.radius) {
          enemy.applyStatusEffect({ type: StatusType.Poison, duration: 2, tickTimer: STATUS_TICK_INTERVAL, tickDamage: cloud.damage, slowFactor: 1 });
        }
      }
    }

    // Update allies
    for (let i = this.allies.length - 1; i >= 0; i--) {
      const ally = this.allies[i];
      const attacked = ally.update(dt, this.map, this.enemies);
      if (attacked) {
        const dmgMult = this.player.synergies.damageMult;
        const finalDmg = Math.round(ally.damage * dmgMult);
        attacked.takeDamage(finalDmg);
        addFloatingText(attacked.px, attacked.py - TILE_SIZE * 0.5, `-${finalDmg}`, '#44ffaa', 0.5);
        addFlash(attacked.px, attacked.py, TILE_SIZE * 0.3, ally.color);
        if (ally.statusEffect) attacked.applyStatusEffect(ally.statusEffect);
        if (attacked.dead) this.onEnemyDeath(attacked);
      }
      if (ally.dead) {
        this.allies.splice(i, 1);
      }
    }

    // Afterimage timer (Phantom Strike evolution)
    if (this.afterimageTimer > 0) {
      this.afterimageTimer -= dt;
      if (this.afterimageTimer <= 0) {
        this.handleDashDamage(this.afterimageDmg, this.afterimageLs);
        addFlash(this.player.px, this.player.py, TILE_SIZE * 2, '#e050ff', 0.2);
      }
    }

    // Shield explosion (Molten Core evolution)
    if (this.player.shieldTimer > 0) {
      const prevTimer = this.player.shieldTimer;
      // Check if shield is about to expire (handled by main shieldTimer decrement above)
      if (prevTimer <= dt && prevTimer > 0) {
        // Check if molten core is active
        const hasMoltenCore = this.player.synergies.evolutions.some(e => e.recipe.id === 'molten_core');
        if (hasMoltenCore) {
          const expDmg = 20 + this.floor * 5;
          this.handleExplosion(this.player.px, this.player.py, TILE_SIZE * 3, expDmg, 0);
          this.player.applyStatusEffect({ type: StatusType.Burn, duration: 0, tickTimer: 0, tickDamage: 0, slowFactor: 1 }); // visual only
        }
      }
    }

    // Berserker passive check
    const hasBerserker = this.player.synergies.evolutions.some(e => e.recipe.id === 'berserker');
    if (hasBerserker && this.player.hp <= this.player.maxHp * 0.3) {
      this.player.synergies.damageMult += 0.8;
      this.player.synergies.cooldownMult -= 0.4;
    }

    // Evolution discovery VFX
    for (const evo of this.player.synergies.evolutions) {
      if (evo.justDiscovered) {
        evo.justDiscovered = false;
        this.player.discoveredEvolutions.add(evo.recipe.id);
        addFloatingText(this.player.px, this.player.py - TILE_SIZE * 3,
          `EVOLUTION: ${evo.recipe.name}`, '#ffcc00', 3.0);
        addRing(this.player.px, this.player.py, TILE_SIZE * 4, '#ffcc00', 0.8);
        addRing(this.player.px, this.player.py, TILE_SIZE * 2, evo.recipe.color, 0.6);
        this.camera.shake(6, 0.4);
      }
    }

    // Enemy lava damage
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const eTile = this.map[enemy.y]?.[enemy.x];
      if (eTile === TileType.Lava && Math.random() < 0.05) {
        enemy.takeDamage(5 + this.floor);
        enemy.applyStatusEffect({ type: StatusType.Burn, duration: 1.5, tickTimer: STATUS_TICK_INTERVAL, tickDamage: 3, slowFactor: 1 });
        if (enemy.dead) this.onEnemyDeath(enemy);
      }
    }

    // Plague Tide evolution: status ticks spread to nearby enemies
    const hasPlagueTide = this.player.synergies.evolutions.some(e => e.recipe.id === 'plague_tide');
    if (hasPlagueTide) {
      for (const enemy of this.enemies) {
        if (enemy.dead || enemy.statusEffects.length === 0) continue;
        for (const otherEnemy of this.enemies) {
          if (otherEnemy === enemy || otherEnemy.dead) continue;
          const sdx = otherEnemy.px - enemy.px;
          const sdy = otherEnemy.py - enemy.py;
          if (sdx * sdx + sdy * sdy < (TILE_SIZE * 2) ** 2) {
            for (const se of enemy.statusEffects) {
              otherEnemy.applyStatusEffect({ ...se, duration: Math.min(se.duration, 1.5), tickDamage: Math.round(se.tickDamage * 0.5) });
            }
          }
        }
      }
    }

    // Health pickup auto-collection
    for (const pickup of this.healthPickups) {
      if (pickup.consumed) continue;
      if (pickup.x === this.player.x && pickup.y === this.player.y && this.player.hp < this.player.maxHp) {
        pickup.consumed = true;
        this.player.heal(pickup.healAmount);
        addFloatingText(this.player.px, this.player.py - TILE_SIZE, `+${pickup.healAmount} HP`, '#44ff44', 1.0);
        addRing(this.player.px, this.player.py, TILE_SIZE * 1.5, '#44ff44', 0.4);
      }
    }

    // Stairs — locked during boss
    if (this.player.x === this.stairsX && this.player.y === this.stairsY) {
      if (this.bossAlive) {
        // Show warning — handled in render
      } else if (wasKeyPressed('Space')) {
        this.descend();
        return;
      }
    }

    for (const enemy of this.enemies) {
      const wasDeadBefore = enemy.dead;
      enemy.update(dt, this.map, this.player, this.minerals);
      enemy.updateStatusEffects(dt);
      // Check if enemy died from status effects
      if (enemy.dead && !wasDeadBefore) {
        this.onEnemyDeath(enemy);
      }
    }

    // Enemy trap damage
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const eTile = this.map[enemy.y]?.[enemy.x];
      if (eTile === TileType.TrapFloor && Math.random() < 0.02) {
        enemy.takeDamage(3 + this.floor);
        if (enemy.dead) this.onEnemyDeath(enemy);
      }
    }

    const dmgMult = this.player.synergies.damageMult * this.comboMult;
    for (const proj of this.projectiles) {
      proj.update(dt, this.map);
      if (proj.dead) continue;

      if (proj.fromPlayer) {
        for (const enemy of this.enemies) {
          if (enemy.dead) continue;
          const dx = proj.x - enemy.px;
          const dy = proj.y - enemy.py;
          if (dx * dx + dy * dy < (TILE_SIZE * 0.5) ** 2) {
            const finalDmg = Math.round(proj.damage * dmgMult);
            enemy.takeDamage(finalDmg);
            addFloatingText(enemy.px, enemy.py - TILE_SIZE * 0.5, `-${finalDmg}`, '#ff4444');
            addFlash(enemy.px, enemy.py, TILE_SIZE * 0.3, '#ffffff');
            this.camera.shake(2, 0.1);
            const totalLs = proj.lifesteal + this.player.synergies.lifestealBonus;
            if (totalLs > 0) {
              const healed = Math.round(finalDmg * totalLs);
              this.player.heal(healed);
              addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, `+${healed}`, '#44ff44');
            }
            // Apply status effect from projectile
            if (proj.statusEffect) {
              enemy.applyStatusEffect(proj.statusEffect);
            }
            if (!proj.pierce) proj.dead = true;
            if (proj.explodes) this.handleExplosion(proj.x, proj.y, proj.explosionRadius, proj.damage * 0.5, proj.lifesteal);
            // Chain lightning: spawn chained projectile to next nearest enemy
            if (proj.chain > 0) {
              proj.chainHitIds.add(this.enemies.indexOf(enemy));
              let chainTarget: Enemy | null = null;
              let chainDist = Infinity;
              for (let ci = 0; ci < this.enemies.length; ci++) {
                const ce = this.enemies[ci];
                if (ce.dead || proj.chainHitIds.has(ci)) continue;
                const cdx = ce.px - enemy.px;
                const cdy = ce.py - enemy.py;
                const cd = cdx * cdx + cdy * cdy;
                if (cd < chainDist && cd < (TILE_SIZE * 3) ** 2) {
                  chainDist = cd;
                  chainTarget = ce;
                }
              }
              if (chainTarget) {
                const cdx = chainTarget.px - enemy.px;
                const cdy = chainTarget.py - enemy.py;
                const clen = Math.sqrt(cdx * cdx + cdy * cdy) || 1;
                const chainProj = new Projectile(enemy.px, enemy.py, cdx / clen, cdy / clen, {
                  speed: proj.speed * 1.2,
                  damage: Math.round(proj.damage * 0.7),
                  lifetime: 0.5,
                  color: '#aaccff',
                  chain: proj.chain - 1,
                  chainHitIds: new Set(proj.chainHitIds),
                  pierce: false,
                  statusEffect: proj.statusEffect,
                  fromPlayer: true,
                });
                this.projectiles.push(chainProj);
                // Lightning line VFX
                addTrail(enemy.px, enemy.py, '#aaccff');
                addTrail(chainTarget.px, chainTarget.py, '#aaccff');
              }
            }
            // Poison cloud from Toxic Miasma evolution
            if (proj.leavesCloud) {
              this.poisonClouds.push({
                x: enemy.px, y: enemy.py,
                damage: Math.round(proj.damage * 0.3),
                timer: 3.0,
                radius: TILE_SIZE * 1.5,
              });
            }
            if (enemy.dead) this.onEnemyDeath(enemy);
          }
        }
      } else {
        const dx = proj.x - this.player.px;
        const dy = proj.y - this.player.py;
        if (dx * dx + dy * dy < (TILE_SIZE * 0.5) ** 2) {
          this.player.takeDamage(proj.damage);
          addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, `-${proj.damage}`, '#ff6666');
          addFlash(this.player.px, this.player.py, TILE_SIZE * 0.4, '#ff4444');
          this.camera.shake(3, 0.15);
          proj.dead = true;
        }
      }
    }

    this.projectiles = this.projectiles.filter(p => !p.dead);
    this.enemies = this.enemies.filter(e => !e.dead);

    this.camera.follow(
      this.player.px, this.player.py,
      this.canvasW, this.canvasH, MAP_WIDTH, MAP_HEIGHT,
    );

    this.nearbyMineral = null;
    let nearestDist = Infinity;
    for (const mineral of this.minerals) {
      if (mineral.consumed) continue;
      const mdx = mineral.x - this.player.x;
      const mdy = mineral.y - this.player.y;
      const dist = mdx * mdx + mdy * mdy;
      if (dist <= 4 && dist < nearestDist) {
        nearestDist = dist;
        this.nearbyMineral = mineral;
      }
    }

    // F key — Mineral Fusion: fuse selected slot with next occupied slot
    if (wasKeyPressed('KeyF')) {
      const selected = this.selectedSlot;
      if (this.player.mutations[selected] && !this.player.mutations[selected]!.fused) {
        // Find next occupied non-fused slot
        let otherSlot = -1;
        for (let i = 1; i < 4; i++) {
          const idx = (selected + i) % 4;
          if (this.player.mutations[idx] && !this.player.mutations[idx]!.fused) {
            otherSlot = idx;
            break;
          }
        }
        if (otherSlot !== -1) {
          const a = this.player.mutations[selected]!;
          const b = this.player.mutations[otherSlot]!;
          if (this.player.fuseMutations(selected, otherSlot)) {
            const fusedAbility = this.player.abilities[selected]!;
            addFloatingText(this.player.px, this.player.py - TILE_SIZE * 1.5,
              `FUSED: ${fusedAbility.name}`, '#ffcc00', 2.0);
            addRing(this.player.px, this.player.py, TILE_SIZE * 3, '#ffcc00', 0.6);
            addRing(this.player.px, this.player.py, TILE_SIZE * 1.5, ELEMENT_COLORS[a.element], 0.4);
            addRing(this.player.px, this.player.py, TILE_SIZE * 2, ELEMENT_COLORS[b.element], 0.5);
            this.camera.shake(5, 0.3);
          }
        } else {
          addFloatingText(this.player.px, this.player.py - TILE_SIZE, 'Need 2 unfused mutations!', '#888888', 1.0);
        }
      } else if (this.player.mutations[selected]?.fused) {
        addFloatingText(this.player.px, this.player.py - TILE_SIZE, 'Already fused!', '#888888', 0.8);
      } else {
        addFloatingText(this.player.px, this.player.py - TILE_SIZE, 'Empty slot!', '#888888', 0.8);
      }
    }

    if (wasKeyPressed('KeyQ')) {
      for (let i = 0; i < 4; i++) {
        const slot = (this.selectedSlot + i) % 4;
        if (this.player.mutations[slot] !== null) {
          const dropped = this.player.dropMutation(slot);
          if (dropped) {
            const droppedMineral = new Mineral(this.player.x, this.player.y, dropped);
            droppedMineral.dropTimer = 0.5; // prevent instant re-pickup
            this.minerals.push(droppedMineral);
            addFloatingText(this.player.px, this.player.py - TILE_SIZE, 'Dropped!', '#ffaa44');
            this.selectedSlot = slot;
          }
          break;
        }
      }
    }

    if (wasKeyPressed('Tab')) {
      this.selectedSlot = (this.selectedSlot + 1) % 4;
    }

    // Tick mineral drop timers
    for (const mineral of this.minerals) {
      if (mineral.dropTimer > 0) mineral.dropTimer -= dt;
    }

    for (const mineral of this.minerals) {
      if (mineral.consumed || mineral.dropTimer > 0) continue;
      if (mineral.x === this.player.x && mineral.y === this.player.y) {
        if (this.player.consumeMineral(mineral.data)) {
          mineral.consumed = true;
          const name = `${MODIFIER_NAMES[mineral.data.modifier]} ${ELEMENT_NAMES[mineral.data.element]}`;
          addFloatingText(this.player.px, this.player.py - TILE_SIZE, `+${name}`, ELEMENT_COLORS[mineral.data.element], 1.2);
          addRing(this.player.px, this.player.py, TILE_SIZE * 1.5, ELEMENT_COLORS[mineral.data.element]);
        } else if (this.player.mutationCount >= 4) {
          // Overload: consume 5th mineral for AoE + temporary power
          if (this.player.overloadCooldown <= 0) {
            mineral.consumed = true;
            this.player.triggerOverload();
            addFloatingText(this.player.px, this.player.py - TILE_SIZE * 2, 'OVERLOAD!', '#ff8800', 2.5);
            addRing(this.player.px, this.player.py, TILE_SIZE * 5, '#ff8800', 0.6);
            addRing(this.player.px, this.player.py, TILE_SIZE * 3, '#ffcc00', 0.4);
            addFlash(this.player.px, this.player.py, TILE_SIZE * 4, '#ff6600', 0.3);
            this.camera.shake(8, 0.5);

            // AoE explosion damages all nearby enemies
            const overloadRadius = TILE_SIZE * 5;
            const overloadDmg = 25 + this.floor * 5;
            for (const enemy of this.enemies) {
              if (enemy.dead) continue;
              const edx = enemy.px - this.player.px;
              const edy = enemy.py - this.player.py;
              if (edx * edx + edy * edy <= overloadRadius * overloadRadius) {
                enemy.takeDamage(overloadDmg);
                addFloatingText(enemy.px, enemy.py - TILE_SIZE * 0.5, `-${overloadDmg}`, '#ff8800');
                addFlash(enemy.px, enemy.py, TILE_SIZE * 0.5, '#ff6600');
                if (enemy.dead) this.onEnemyDeath(enemy);
              }
            }
          } else {
            addFloatingText(this.player.px, this.player.py - TILE_SIZE,
              `Overload CD: ${Math.ceil(this.player.overloadCooldown)}s`, '#888888', 1.0);
          }
        }
      }
    }
  }

  private handleTendrilAttack(): void {
    const { dx, dy } = facingToDelta(this.player.facing);
    const ax = this.player.x + dx;
    const ay = this.player.y + dy;
    addFlash(this.player.px + dx * TILE_SIZE, this.player.py + dy * TILE_SIZE, TILE_SIZE * 0.5, '#ffffff', 0.1);
    const dmgMult = this.player.synergies.damageMult * this.comboMult;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (enemy.x === ax && enemy.y === ay) {
        const finalDmg = Math.round(5 * dmgMult);
        enemy.takeDamage(finalDmg);
        addFloatingText(enemy.px, enemy.py - TILE_SIZE * 0.5, `-${finalDmg}`, '#ff4444');
        addFlash(enemy.px, enemy.py, TILE_SIZE * 0.3, '#ffffff');
        this.camera.shake(2, 0.08);
        if (enemy.dead) this.onEnemyDeath(enemy);
      }
    }
  }

  private handleDashDamage(damage: number, lifesteal: number, effect?: AbilityEffect): void {
    const dmgMult = this.player.synergies.damageMult * this.comboMult;
    addTrail(this.player.px, this.player.py, '#ff3333');
    addRing(this.player.px, this.player.py, TILE_SIZE * 1.5, '#ff3333', 0.3);
    this.camera.shake(3, 0.15);
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (Math.abs(enemy.x - this.player.x) + Math.abs(enemy.y - this.player.y) <= 1) {
        const finalDmg = Math.round(damage * dmgMult);
        enemy.takeDamage(finalDmg);
        addFloatingText(enemy.px, enemy.py - TILE_SIZE * 0.5, `-${finalDmg}`, '#ff4444');
        addFlash(enemy.px, enemy.py, TILE_SIZE * 0.4, '#ff3333');
        const totalLs = lifesteal + this.player.synergies.lifestealBonus;
        if (totalLs > 0) {
          const healed = Math.round(finalDmg * totalLs);
          this.player.heal(healed);
          addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, `+${healed}`, '#44ff44');
        }
        if (enemy.dead) this.onEnemyDeath(enemy);
      }
    }
    // Phantom Strike evolution: afterimage repeats dash damage after 0.5s
    if (effect?.afterimage) {
      this.afterimageTimer = 0.5;
      this.afterimageDmg = damage;
      this.afterimageLs = lifesteal;
      addTrail(this.player.px, this.player.py, '#e050ff');
    }
  }

  private handleAoePulse(damage: number, radius: number, lifesteal: number, effect?: AbilityEffect): void {
    addFloatingText(this.player.px, this.player.py - TILE_SIZE, 'PULSE!', '#33ff66', 0.6);
    addRing(this.player.px, this.player.py, radius, '#33ff66', 0.5);
    this.camera.shake(3, 0.2);
    const dmgMult = this.player.synergies.damageMult * this.comboMult;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const dx = enemy.px - this.player.px;
      const dy = enemy.py - this.player.py;
      if (dx * dx + dy * dy <= radius * radius) {
        const finalDmg = Math.round(damage * dmgMult);
        enemy.takeDamage(finalDmg);
        addFloatingText(enemy.px, enemy.py - TILE_SIZE * 0.5, `-${finalDmg}`, '#ff4444');
        addFlash(enemy.px, enemy.py, TILE_SIZE * 0.3, '#33ff66');
        let totalLs = lifesteal + this.player.synergies.lifestealBonus;
        if (effect?.healsOnHit) totalLs += 0.25; // Life Engine: +25% healing
        if (totalLs > 0) {
          this.player.heal(Math.round(finalDmg * totalLs));
        }
        if (enemy.dead) this.onEnemyDeath(enemy);
      }
    }
  }

  private handleExplosion(x: number, y: number, radius: number, damage: number, lifesteal: number): void {
    addFloatingText(x, y - TILE_SIZE, 'BOOM!', '#ff8800', 0.6);
    addRing(x, y, radius, '#ff8800', 0.4);
    addFlash(x, y, radius * 0.5, '#ff4400', 0.2);
    this.camera.shake(5, 0.25);
    const dmgMult = this.player.synergies.damageMult * this.comboMult;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const dx = enemy.px - x;
      const dy = enemy.py - y;
      if (dx * dx + dy * dy <= radius * radius) {
        const finalDmg = Math.round(damage * dmgMult);
        enemy.takeDamage(finalDmg);
        addFloatingText(enemy.px, enemy.py - TILE_SIZE * 0.5, `-${finalDmg}`, '#ff4444');
        if (lifesteal > 0) this.player.heal(Math.round(damage * lifesteal));
        if (enemy.dead) this.onEnemyDeath(enemy);
      }
    }
  }

  private handleBossSlam(boss: Enemy): void {
    const slamRadius = TILE_SIZE * 3;
    const slamDmg = boss.damage;
    addFloatingText(boss.px, boss.py - TILE_SIZE * 1.5, 'SLAM!', '#ff4488', 1.0);
    addRing(boss.px, boss.py, slamRadius, '#ff4488', 0.5);
    addFlash(boss.px, boss.py, slamRadius * 0.5, '#ff2266', 0.2);
    this.camera.shake(8, 0.4);

    const dx = this.player.px - boss.px;
    const dy = this.player.py - boss.py;
    if (dx * dx + dy * dy <= slamRadius * slamRadius) {
      this.player.takeDamage(slamDmg);
      addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, `-${slamDmg}`, '#ff4444');
    }
  }

  private handleBossSummon(boss: Enemy): void {
    addFloatingText(boss.px, boss.py - TILE_SIZE * 1.5, 'SUMMON!', '#ff88aa', 1.2);
    addRing(boss.px, boss.py, TILE_SIZE * 4, '#ff88aa', 0.6);
    this.camera.shake(4, 0.3);

    // Spawn 2 crawlers near boss
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let spawned = 0;
    for (const [ddx, ddy] of dirs) {
      if (spawned >= 2) break;
      const sx = boss.x + ddx * 2;
      const sy = boss.y + ddy * 2;
      if (sx >= 0 && sx < MAP_WIDTH && sy >= 0 && sy < MAP_HEIGHT && this.map[sy][sx] !== TileType.Wall) {
        const minion = new Enemy(sx, sy, 'crawler');
        const scale = 1 + (this.floor - 1) * 0.15;
        minion.hp = Math.round(minion.hp * scale);
        minion.maxHp = minion.hp;
        minion.damage = Math.round(minion.damage * scale);
        minion.onShoot = (p) => this.projectiles.push(p);
        this.enemies.push(minion);
        spawned++;
      }
    }
  }

  private handleWallPlace(tiles: Point[], duration: number, _effect: AbilityEffect): void {
    for (const t of tiles) {
      const original = this.map[t.y][t.x];
      this.map[t.y][t.x] = TileType.Wall;
      this.temporaryWalls.push({ x: t.x, y: t.y, timer: duration, originalTile: original });
    }
    addFloatingText(this.player.px, this.player.py - TILE_SIZE, 'WALL!', '#00eedd', 0.6);
    addFlash(this.player.px + TILE_SIZE, this.player.py, TILE_SIZE * 2, '#00eedd', 0.2);
  }

  private handleBeamFire(x: number, y: number, ddx: number, ddy: number, effect: AbilityEffect, color: string): void {
    this.activeBeams.push({
      x, y, dx: ddx, dy: ddy,
      damage: effect.damage,
      range: effect.range * TILE_SIZE,
      tickTimer: 0,
      duration: effect.duration + 0.3,
      color,
      lifesteal: effect.lifesteal,
      statusEffect: effect.statusEffect,
    });
  }

  private handleSummon(x: number, y: number, effect: AbilityEffect, color: string): void {
    const count = effect.chain >= 2 ? 2 : 1; // More chains = more summons
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let spawned = 0;
    for (const [ddx, ddy] of dirs) {
      if (spawned >= count) break;
      const sx = x + ddx;
      const sy = y + ddy;
      if (sx >= 0 && sx < MAP_WIDTH && sy >= 0 && sy < MAP_HEIGHT) {
        const tile = this.map[sy][sx];
        if (tile !== TileType.Wall && tile !== TileType.LockedDoor) {
          const ally = new Ally(sx, sy, effect.damage, effect.duration + 3, color, 0, effect.statusEffect);
          this.allies.push(ally);
          addRing(sx * TILE_SIZE + TILE_SIZE / 2, sy * TILE_SIZE + TILE_SIZE / 2, TILE_SIZE * 1.5, color, 0.4);
          spawned++;
        }
      }
    }
    addFloatingText(this.player.px, this.player.py - TILE_SIZE, 'SUMMON!', color, 0.8);
  }

  private onEnemyDeath(enemy: Enemy): void {
    this.comboCount++;
    this.comboTimer = COMBO_WINDOW;
    this.runKills++;

    if (this.comboCount >= 2) {
      addFloatingText(this.player.px, this.player.py - TILE_SIZE * 1.5,
        `${this.comboCount}x COMBO!`, '#ffcc00', 1.0);
      this.camera.shake(4, 0.2);
      this.player.heal(3 * this.comboCount);
    }

    // Boss death
    if (enemy.isBoss) {
      this.bossAlive = false;
      this.runBossKills++;
      addFloatingText(enemy.px, enemy.py - TILE_SIZE * 2, 'BOSS SLAIN!', '#ff4488', 3.0);
      addRing(enemy.px, enemy.py, TILE_SIZE * 5, '#ff4488', 0.8);
      addRing(enemy.px, enemy.py, TILE_SIZE * 3, '#ffcc00', 0.6);
      addFlash(enemy.px, enemy.py, TILE_SIZE * 4, '#ff2266', 0.3);
      this.camera.shake(10, 0.6);

      // Guaranteed Rare+ mineral drop
      const drop = generateMineral(this.floor);
      drop.rarity = Math.max(2, drop.rarity) as typeof drop.rarity; // At least Rare
      this.minerals.push(new Mineral(enemy.x, enemy.y, drop));

      // Guaranteed health pickup
      this.healthPickups.push(new HealthPickup(enemy.x + 1, enemy.y, 30 + this.floor * 5));
      return;
    }

    addFloatingText(enemy.px, enemy.py - TILE_SIZE, 'KILLED!', '#ffcc00', 0.8);
    addRing(enemy.px, enemy.py, TILE_SIZE * 1.5, '#ffcc00', 0.3);
    this.camera.shake(3, 0.15);

    if (enemy.mutation) {
      const weakened = { ...enemy.mutation, rarity: 0 as const };
      this.minerals.push(new Mineral(enemy.x, enemy.y, weakened));
    }

    // 25% chance to drop health pickup
    if (Math.random() < 0.25) {
      this.healthPickups.push(new HealthPickup(enemy.x, enemy.y, 10 + this.floor * 2));
    }

    // 10% chance to drop key
    if (Math.random() < 0.1) {
      this.keys++;
      addFloatingText(enemy.px, enemy.py - TILE_SIZE * 0.3, '+KEY', '#e0a030', 1.0);
    }
  }

  private render(): void {
    renderMap(this.ctx, this.map, this.camera, this.player, this.canvasW, this.canvasH, this.rooms);
    renderMinerals(this.ctx, this.minerals, this.camera, this.player, this.gameTime, this.canvasW, this.canvasH);
    renderHealthPickups(this.ctx, this.healthPickups, this.camera, this.player, this.gameTime, this.canvasW, this.canvasH);

    // Render poison clouds
    for (const cloud of this.poisonClouds) {
      const csx = cloud.x - this.camera.x;
      const csy = cloud.y - this.camera.y;
      const alpha = Math.min(0.3, cloud.timer * 0.1);
      this.ctx.beginPath();
      this.ctx.arc(csx, csy, cloud.radius, 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(136,204,34,${alpha})`;
      this.ctx.fill();
    }

    // Render shrine glow (unused shrines)
    if (!this.shrineUsed) {
      for (const room of this.rooms) {
        if (room.roomType !== 4) continue;
        const cx = Math.floor(room.x + room.width / 2) * TILE_SIZE + TILE_SIZE / 2 - this.camera.x;
        const cy = Math.floor(room.y + room.height / 2) * TILE_SIZE + TILE_SIZE / 2 - this.camera.y;
        const dist = Math.sqrt((room.x + room.width / 2 - this.player.x) ** 2 + (room.y + room.height / 2 - this.player.y) ** 2);
        if (dist <= VISION_RADIUS) {
          const pulse = 0.5 + Math.sin(this.gameTime * 3) * 0.2;
          this.ctx.beginPath();
          this.ctx.arc(cx, cy, TILE_SIZE * 0.7, 0, Math.PI * 2);
          this.ctx.fillStyle = `rgba(200,150,255,${pulse})`;
          this.ctx.fill();
        }
      }
    }

    for (const enemy of this.enemies) {
      const dx = enemy.x - this.player.x;
      const dy = enemy.y - this.player.y;
      if (dx * dx + dy * dy <= (VISION_RADIUS + 2) ** 2) {
        enemy.render(this.ctx, this.camera);
      }
    }

    for (const proj of this.projectiles) {
      proj.render(this.ctx, this.camera);
    }

    // Render allies
    for (const ally of this.allies) {
      ally.render(this.ctx, this.camera);
    }

    // Render active beams
    for (const beam of this.activeBeams) {
      const bsx = beam.x - this.camera.x;
      const bsy = beam.y - this.camera.y;
      const endX = bsx + beam.dx * beam.range;
      const endY = bsy + beam.dy * beam.range;
      // Find wall cutoff
      let beamEndX = endX;
      let beamEndY = endY;
      for (let step = 1; step <= beam.range / TILE_SIZE; step++) {
        const tx = Math.floor((beam.x + beam.dx * step * TILE_SIZE) / TILE_SIZE);
        const ty = Math.floor((beam.y + beam.dy * step * TILE_SIZE) / TILE_SIZE);
        if (tx < 0 || tx >= MAP_WIDTH || ty < 0 || ty >= MAP_HEIGHT || this.map[ty][tx] === TileType.Wall) {
          beamEndX = bsx + beam.dx * step * TILE_SIZE;
          beamEndY = bsy + beam.dy * step * TILE_SIZE;
          break;
        }
      }
      // Beam glow
      this.ctx.beginPath();
      this.ctx.moveTo(bsx, bsy);
      this.ctx.lineTo(beamEndX, beamEndY);
      this.ctx.strokeStyle = beam.color + '60';
      this.ctx.lineWidth = 6;
      this.ctx.stroke();
      // Beam core
      this.ctx.beginPath();
      this.ctx.moveTo(bsx, bsy);
      this.ctx.lineTo(beamEndX, beamEndY);
      this.ctx.strokeStyle = beam.color;
      this.ctx.lineWidth = 2;
      this.ctx.stroke();
    }

    this.player.render(this.ctx, this.camera);
    renderVfx(this.ctx, this.camera);
    renderFloatingText(this.ctx, this.camera);

    if (this.player.x === this.stairsX && this.player.y === this.stairsY) {
      this.ctx.fillStyle = 'rgba(0,0,0,0.6)';
      this.ctx.fillRect(this.canvasW / 2 - 100, this.canvasH / 2 - 40, 200, 24);
      if (this.bossAlive) {
        this.ctx.fillStyle = '#ff4488';
        this.ctx.font = 'bold 11px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('DEFEAT THE GUARDIAN', this.canvasW / 2, this.canvasH / 2 - 24);
      } else {
        this.ctx.fillStyle = '#e0a030';
        this.ctx.font = 'bold 11px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('SPACE to descend', this.canvasW / 2, this.canvasH / 2 - 24);
      }
      this.ctx.textAlign = 'start';
    }

    this.renderMinimap();

    const visibleEnemies = this.enemies.filter(e => {
      const dx = e.x - this.player.x;
      const dy = e.y - this.player.y;
      return dx * dx + dy * dy <= (VISION_RADIUS + 2) ** 2;
    });

    renderHud(this.ctx, this.player, this.canvasW, this.canvasH, this.selectedSlot, this.nearbyMineral, visibleEnemies, this.floor, this.comboCount, this.comboTimer, this.bossAlive, this.keys, this.activeBuffs);

    if (this.player.dead) {
      // Save progression on death (once)
      if (!this.showUpgradeScreen) {
        this.showUpgradeScreen = true;
        const evoCount = this.player.discoveredEvolutions.size - (this.progress.discoveredEvolutions?.length || 0);
        const reward = calculateRunReward(this.floor, this.runKills, this.runBossKills, Math.max(0, evoCount));
        this.progress.totalRuns++;
        this.progress.totalKills += this.runKills;
        this.progress.bestFloor = Math.max(this.progress.bestFloor, this.floor);
        this.progress.substratePoints += reward;
        this.progress.discoveredEvolutions = [...this.player.discoveredEvolutions];
        saveProgress(this.progress);
      }

      this.ctx.fillStyle = 'rgba(0,0,0,0.8)';
      this.ctx.fillRect(0, 0, this.canvasW, this.canvasH);
      this.ctx.fillStyle = '#e53170';
      this.ctx.font = 'bold 28px monospace';
      this.ctx.textAlign = 'center';
      const cx = this.canvasW / 2;
      let cy = this.canvasH / 2 - 80;
      this.ctx.fillText('DISSOLVED', cx, cy);

      // Run stats
      this.ctx.font = '11px monospace';
      cy += 25;
      this.ctx.fillStyle = '#aaa';
      this.ctx.fillText(`Floor ${this.floor} | Kills: ${this.runKills} | Bosses: ${this.runBossKills}`, cx, cy);

      cy += 18;
      this.ctx.fillStyle = '#e0a030';
      const evoCount = this.player.discoveredEvolutions.size - (this.progress.discoveredEvolutions?.length || 0);
      const reward = calculateRunReward(this.floor, this.runKills, this.runBossKills, Math.max(0, evoCount));
      this.ctx.fillText(`+${reward} Substrate Points (Total: ${this.progress.substratePoints})`, cx, cy);

      cy += 18;
      this.ctx.fillStyle = '#888';
      this.ctx.fillText(`Best: Floor ${this.progress.bestFloor} | Runs: ${this.progress.totalRuns}`, cx, cy);

      // Evolutions discovered
      cy += 22;
      this.ctx.fillStyle = '#ffcc00';
      this.ctx.font = 'bold 10px monospace';
      this.ctx.fillText('EVOLUTIONS', cx, cy);
      cy += 14;
      this.ctx.font = '9px monospace';
      for (const recipe of EVOLUTION_RECIPES) {
        const discovered = this.player.discoveredEvolutions.has(recipe.id);
        this.ctx.fillStyle = discovered ? recipe.color : '#333';
        this.ctx.fillText(discovered ? recipe.name : '???', cx, cy);
        cy += 11;
      }

      // Upgrades
      cy += 16;
      this.ctx.fillStyle = '#44ccff';
      this.ctx.font = 'bold 10px monospace';
      this.ctx.fillText('UPGRADES (press 1-5 to buy)', cx, cy);
      cy += 13;
      this.ctx.font = '9px monospace';
      for (let i = 0; i < UPGRADES.length; i++) {
        const upg = UPGRADES[i];
        const level = getUpgradeLevel(this.progress, upg.id);
        const maxed = level >= upg.maxLevel;
        const canAfford = !maxed && this.progress.substratePoints >= upg.costPerLevel;
        this.ctx.fillStyle = maxed ? '#666' : canAfford ? '#44ccff' : '#555';
        const lvlStr = maxed ? 'MAX' : `Lv${level} → Lv${level + 1} (${upg.costPerLevel}pts)`;
        this.ctx.fillText(`${i + 1}. ${upg.name}: ${lvlStr}`, cx, cy);
        if (level > 0) {
          cy += 10;
          this.ctx.fillStyle = '#888';
          this.ctx.fillText(upg.description(level), cx, cy);
        }
        cy += 12;
      }

      cy += 8;
      this.ctx.fillStyle = '#ccccdd';
      this.ctx.font = '12px monospace';
      this.ctx.fillText('Press R to restart', cx, cy);
      this.ctx.textAlign = 'start';
    }
  }

  private renderMinimap(): void {
    const mmScale = 2;
    const mmW = MAP_WIDTH * mmScale;
    const mmH = MAP_HEIGHT * mmScale;
    const mmX = this.canvasW - mmW - 8;
    const mmY = this.canvasH - mmH - 56;

    this.ctx.fillStyle = 'rgba(0,0,0,0.6)';
    this.ctx.fillRect(mmX - 1, mmY - 1, mmW + 2, mmH + 2);

    for (const room of this.rooms) {
      this.ctx.fillStyle = 'rgba(80,80,120,0.5)';
      this.ctx.fillRect(mmX + room.x * mmScale, mmY + room.y * mmScale, room.width * mmScale, room.height * mmScale);
    }

    // Stairs — pulsing yellow indicator
    const stairPulse = 0.6 + Math.sin(this.gameTime * 4) * 0.4;
    this.ctx.fillStyle = `rgba(224,160,48,${stairPulse})`;
    this.ctx.fillRect(mmX + this.stairsX * mmScale - 2, mmY + this.stairsY * mmScale - 2, 5, 5);
    this.ctx.fillStyle = '#ffe060';
    this.ctx.fillRect(mmX + this.stairsX * mmScale - 1, mmY + this.stairsY * mmScale - 1, 3, 3);

    for (const e of this.enemies) {
      if (e.isBoss) {
        this.ctx.fillStyle = '#ff4488';
        this.ctx.fillRect(mmX + e.x * mmScale - 1, mmY + e.y * mmScale - 1, 3, 3);
      } else {
        this.ctx.fillStyle = '#cc4444';
        this.ctx.fillRect(mmX + e.x * mmScale, mmY + e.y * mmScale, 1, 1);
      }
    }

    // Health pickups on minimap
    this.ctx.fillStyle = '#44ff44';
    for (const h of this.healthPickups) {
      if (h.consumed) continue;
      this.ctx.fillRect(mmX + h.x * mmScale, mmY + h.y * mmScale, 1, 1);
    }

    for (const m of this.minerals) {
      if (m.consumed) continue;
      this.ctx.fillStyle = ELEMENT_COLORS[m.data.element];
      this.ctx.fillRect(mmX + m.x * mmScale, mmY + m.y * mmScale, 1, 1);
    }

    // Allies on minimap
    this.ctx.fillStyle = '#44ffaa';
    for (const a of this.allies) {
      this.ctx.fillRect(mmX + a.x * mmScale, mmY + a.y * mmScale, 1, 1);
    }

    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(mmX + this.player.x * mmScale - 1, mmY + this.player.y * mmScale - 1, 3, 3);
  }
}
