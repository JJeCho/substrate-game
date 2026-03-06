import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, VISION_RADIUS, COMBO_WINDOW, MUTATION_SLOTS, ELEMENT_COLORS, ELEMENT_NAMES, MODIFIER_NAMES, STATUS_COLORS, STATUS_TICK_INTERVAL } from './constants';
import { TileType, StatusType, BuffType, RoomType } from './types';
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
import { addRing, addFlash, addTrail, addSweep, updateVfx, renderVfx } from './vfx';
import { loadProgress, saveProgress, calculateRunReward, getUpgradeLevel, canBuyUpgrade, buyUpgrade, UPGRADES } from './progression';
import type { MetaProgress, RunRecord } from './progression';
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
  private runSeed = 0;
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

  // Floor transition
  private transitionTimer = 0;
  private transitionFloor = 0;
  private transitionMessage = '';

  // Healing zones (Spore Burst evolution)
  healingZones: { x: number; y: number; radius: number; timer: number; healPerTick: number; tickTimer: number }[] = [];

  // Shop state
  private shopOpen = false;
  private shopInventory: { type: 'mineral' | 'health'; mineral?: import('./types').MineralData; healAmount?: number; hpCost: number; purchased: boolean }[] = [];
  private shopRoomCenter: Point | null = null;

  // Secret room caches — special reward interactables
  private secretCaches: { x: number; y: number; claimed: boolean }[] = [];

  // Track melee kills for Iron Frenzy evolution
  private lastKillWasMelee = false;

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
    this.runSeed = (Math.random() * 2147483647) | 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.runKills = 0;
    this.runBossKills = 0;
    this.showUpgradeScreen = false;
    this.progress = loadProgress();
    this.initFloor(true);
  }

  private initFloor(isNewGame: boolean): void {
    const { map, rooms } = generateDungeon(this.floor, this.runSeed);
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

    // Place stairs in the last non-secret room (secret rooms should never have stairs)
    const nonSecretRooms = this.rooms.filter(r => r.roomType !== RoomType.Secret);
    const stairsRoom = nonSecretRooms[nonSecretRooms.length - 1] ?? this.rooms[0];
    this.stairsX = Math.floor(stairsRoom.x + stairsRoom.width / 2);
    this.stairsY = Math.floor(stairsRoom.y + stairsRoom.height / 2);
    this.map[this.stairsY][this.stairsX] = TileType.Stairs;

    // Place substrate caches in secret rooms
    this.secretCaches = [];
    for (const room of this.rooms) {
      if (room.roomType === RoomType.Secret) {
        this.secretCaches.push({
          x: Math.floor(room.x + room.width / 2),
          y: Math.floor(room.y + room.height / 2),
          claimed: false,
        });
      }
    }

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

      // Tenacity upgrade: +1 base tendril damage per level
      const tenacityLvl = getUpgradeLevel(this.progress, 'tenacity');
      if (tenacityLvl > 0) {
        this.player.tendrilBaseDamage = 5 + tenacityLvl;
      }

      // Quick Adaptation upgrade: -10s mutation decay per level
      const adaptLvl = getUpgradeLevel(this.progress, 'adaptation');
      if (adaptLvl > 0) {
        this.player.mutationDecayBonus = adaptLvl * 10;
      }

      // Mineral Affinity upgrade: +5% rarity chance per level
      const affinityLvl = getUpgradeLevel(this.progress, 'affinity');
      if (affinityLvl > 0) {
        this.player.rarityBonus = affinityLvl * 0.05;
      }

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
    this.player.onTeleport = () => {
      // Void Step evolution: teleport grants 1s invincibility
      const hasVoidStep = this.player.synergies.evolutions.some(e => e.recipe.id === 'void_step');
      if (hasVoidStep) {
        this.player.shieldTimer = 1.0;
        addFloatingText(this.player.px, this.player.py - TILE_SIZE * 1.5, 'VOID STEP!', '#cc55ff', 1.0);
        addRing(this.player.px, this.player.py, TILE_SIZE * 2, '#cc55ff', 0.4);
      }
    };
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

    this.minerals = spawnMinerals(this.rooms, this.map, this.floor, this.player.rarityBonus);
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
      boss.onMeleeHit = (dmg) => {
        addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, `-${dmg}`, '#ff6666');
      };
      // Boss-type-specific callbacks
      boss.onPoisonTrail = () => {
        this.poisonClouds.push({ x: boss.px, y: boss.py, damage: 3 + this.floor, timer: 5.0, radius: TILE_SIZE * 2 });
      };
      boss.onBossTeleport = () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const nx = boss.x + Math.floor(Math.random() * 12) - 6;
          const ny = boss.y + Math.floor(Math.random() * 12) - 6;
          if (nx >= 0 && nx < MAP_WIDTH && ny >= 0 && ny < MAP_HEIGHT && this.map[ny][nx] !== TileType.Wall) {
            addRing(boss.px, boss.py, TILE_SIZE * 2, '#cc55ff', 0.3);
            boss.x = nx; boss.y = ny; boss.tx = nx; boss.ty = ny;
            boss.px = nx * TILE_SIZE + TILE_SIZE / 2;
            boss.py = ny * TILE_SIZE + TILE_SIZE / 2;
            addFlash(boss.px, boss.py, TILE_SIZE * 2, '#cc55ff', 0.2);
            // Mercury Phantom applies slow on teleport
            const dist = Math.abs(boss.x - this.player.x) + Math.abs(boss.y - this.player.y);
            if (dist <= 3) {
              this.player.applyStatusEffect({ type: StatusType.Slow, duration: 2, tickTimer: 0, tickDamage: 0, slowFactor: 0.5 });
            }
            break;
          }
        }
      };
      this.enemies.push(boss);
      this.bossAlive = true;
    }

    for (const enemy of this.enemies) {
      if (!enemy.onShoot) enemy.onShoot = (p) => this.projectiles.push(p);
      enemy.onMeleeHit = (dmg) => {
        addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, `-${dmg}`, '#ff6666');
      };
    }

    // Shop room setup
    const shopRoom = this.rooms.find(r => r.roomType === RoomType.Shop);
    if (shopRoom) {
      this.shopRoomCenter = {
        x: Math.floor(shopRoom.x + shopRoom.width / 2),
        y: Math.floor(shopRoom.y + shopRoom.height / 2),
      };
      this.shopInventory = [];
      for (let i = 0; i < 3; i++) {
        const mineral = generateMineral(this.floor);
        mineral.rarity = Math.max(1, mineral.rarity) as typeof mineral.rarity;
        const hpCost = 10 + mineral.rarity * 10;
        this.shopInventory.push({ type: 'mineral', mineral, hpCost, purchased: false });
      }
      this.shopInventory.push({ type: 'health', healAmount: 30 + this.floor * 5, hpCost: 15, purchased: false });
    } else {
      this.shopRoomCenter = null;
      this.shopInventory = [];
    }
    this.shopOpen = false;
    this.healingZones = [];

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
    this.transitionFloor = this.floor;
    this.transitionMessage = this.getFloorMessage(this.floor);
    this.transitionTimer = 1.5;
    this.camera.shake(4, 0.3);
    this.initFloor(false);
  }

  private getFloorMessage(floor: number): string {
    if (floor % 3 === 0) return 'A guardian awaits...';
    if (floor >= 4 && floor % 2 === 0) return 'A merchant sets up shop';
    const cycle = ((floor - 1) % 12);
    if (cycle < 2) return 'Clean excavation tunnels...';
    if (cycle < 5) return 'Fungal growth covers the walls...';
    if (cycle < 8) return 'Crystal formations shimmer...';
    return 'Heat rises from below...';
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
    // Floor transition overlay
    if (this.transitionTimer > 0) {
      this.transitionTimer -= dt;
      return;
    }

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
        // Cracked wall — break with melee attack (E key)
        if (this.map[frontY][frontX] === TileType.CrackedWall) {
          if (wasKeyPressed('KeyE')) {
            this.map[frontY][frontX] = TileType.Corridor;
            addFloatingText(frontX * TILE_SIZE + TILE_SIZE / 2, frontY * TILE_SIZE, 'CRUMBLE!', '#8888aa', 1.0);
            addRing(frontX * TILE_SIZE + TILE_SIZE / 2, frontY * TILE_SIZE + TILE_SIZE / 2, TILE_SIZE * 2, '#6666aa', 0.4);
            addFlash(frontX * TILE_SIZE + TILE_SIZE / 2, frontY * TILE_SIZE + TILE_SIZE / 2, TILE_SIZE, '#aaaacc', 0.15);
            this.camera.shake(4, 0.25);
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
          { type: BuffType.Shield, mag: 30, dur: 99999, name: 'FORTIFY' },
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

    // Secret cache interaction — substrate cache in hidden rooms
    for (const cache of this.secretCaches) {
      if (cache.claimed) continue;
      if (this.player.x === cache.x && this.player.y === cache.y && wasKeyPressed('Space')) {
        cache.claimed = true;

        // 1. Spawn a guaranteed rare/legendary mineral on the ground nearby
        const bonusMineral = generateMineral(this.floor + 5); // scaled way above current floor
        bonusMineral.rarity = Math.random() < 0.4 ? 3 : 2; // 40% legendary, 60% rare
        const rarityName = bonusMineral.rarity === 3 ? 'LEGENDARY' : 'RARE';
        const rarityColor = bonusMineral.rarity === 3 ? '#ff8800' : '#aa66ff';
        // Place mineral adjacent to cache so it doesn't overlap the player
        let mx = cache.x + 1, my = cache.y;
        if (this.map[my]?.[mx] === TileType.Wall) { mx = cache.x - 1; my = cache.y; }
        if (this.map[my]?.[mx] === TileType.Wall) { mx = cache.x; my = cache.y + 1; }
        if (this.map[my]?.[mx] === TileType.Wall) { mx = cache.x; my = cache.y - 1; }
        this.minerals.push(new Mineral(mx, my, bonusMineral));

        // 2. Bonus substrate points (meta-progression currency)
        const bonusPoints = 10 + this.floor * 3;
        this.progress.substratePoints += bonusPoints;
        saveProgress(this.progress);

        // 3. Small permanent max HP boost
        const hpBonus = 5 + Math.floor(this.floor / 3) * 2;
        this.player.baseMaxHp += hpBonus;
        this.player.maxHp += hpBonus;
        this.player.hp = Math.min(this.player.hp + hpBonus, this.player.maxHp);

        // 4. Full heal
        this.player.hp = this.player.maxHp;

        // VFX cascade
        const cpx = cache.x * TILE_SIZE + TILE_SIZE / 2;
        const cpy = cache.y * TILE_SIZE + TILE_SIZE / 2;
        addFloatingText(cpx, cpy - TILE_SIZE * 3, 'SUBSTRATE CACHE', '#00ffb4', 2.5);
        addFloatingText(cpx, cpy - TILE_SIZE * 2, `${rarityName} MINERAL`, rarityColor, 2.0);
        addFloatingText(cpx, cpy - TILE_SIZE, `+${bonusPoints} SUBSTRATE`, '#00ddff', 1.8);
        addFloatingText(cpx, cpy, `+${hpBonus} MAX HP  ❤ FULL HEAL`, '#88ff88', 1.6);
        addRing(cpx, cpy, TILE_SIZE * 4, '#00ffb4', 0.8);
        addRing(cpx, cpy, TILE_SIZE * 2.5, '#00ddff', 0.5);
        addFlash(cpx, cpy, TILE_SIZE * 6, '#00ffb4', 0.4);
        this.camera.shake(6, 0.5);
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
          if (this.map[ty][tx] === TileType.Wall || this.map[ty][tx] === TileType.LockedDoor || this.map[ty][tx] === TileType.CrackedWall) break;
          for (const enemy of this.enemies) {
            if (enemy.dead) continue;
            const edx = enemy.px - bx;
            const edy = enemy.py - by;
            if (edx * edx + edy * edy < (TILE_SIZE * 0.7) ** 2) {
              const finalDmg = Math.round(beam.damage * 0.3 * dmgMult);
              enemy.takeDamage(finalDmg);
              addFloatingText(enemy.px, enemy.py - TILE_SIZE * 0.5, `-${finalDmg}`, '#ff4444', 0.3);
              if (beam.lifesteal > 0) this.player.heal(Math.round(finalDmg * beam.lifesteal));
              if (beam.statusEffect) this.applyBoostedStatus(enemy, beam.statusEffect);
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
          this.applyBoostedStatus(enemy, { type: StatusType.Poison, duration: 2, tickTimer: STATUS_TICK_INTERVAL, tickDamage: cloud.damage, slowFactor: 1 });
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
        if (ally.statusEffect) this.applyBoostedStatus(attacked, ally.statusEffect);
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

    // Berserker passive — bonus damage and cooldown reduction at low HP
    const hasBerserker = this.player.synergies.evolutions.some(e => e.recipe.id === 'berserker');
    if (hasBerserker && this.player.hp <= this.player.maxHp * 0.3) {
      this.player.synergies.damageMult += 0.8;
      this.player.synergies.cooldownMult = Math.max(0.1, this.player.synergies.cooldownMult - 0.4);
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

    // Update healing zones (Spore Burst evolution)
    for (let i = this.healingZones.length - 1; i >= 0; i--) {
      const zone = this.healingZones[i];
      zone.timer -= dt;
      if (zone.timer <= 0) { this.healingZones.splice(i, 1); continue; }
      zone.tickTimer -= dt;
      if (zone.tickTimer <= 0) {
        zone.tickTimer = 0.5;
        const dx = this.player.px - zone.x;
        const dy = this.player.py - zone.y;
        if (dx * dx + dy * dy <= zone.radius * zone.radius) {
          this.player.heal(zone.healPerTick);
          addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, `+${zone.healPerTick}`, '#33ff99', 0.3);
        }
      }
    }

    // Shop interaction
    if (this.shopRoomCenter && this.player.x === this.shopRoomCenter.x && this.player.y === this.shopRoomCenter.y) {
      if (!this.shopOpen && wasKeyPressed('Space')) {
        this.shopOpen = true;
      }
    }
    if (this.shopOpen) {
      for (let i = 0; i < this.shopInventory.length; i++) {
        if (wasKeyPressed(`Digit${i + 1}`)) {
          const item = this.shopInventory[i];
          if (!item.purchased && this.player.hp > item.hpCost) {
            item.purchased = true;
            this.player.hp -= item.hpCost;
            this.player.flashTimer = 0.1;
            if (item.type === 'mineral' && item.mineral) {
              if (!this.player.consumeMineral(item.mineral)) {
                this.minerals.push(new Mineral(this.player.x, this.player.y, item.mineral));
              }
              addFloatingText(this.player.px, this.player.py - TILE_SIZE, 'PURCHASED!', '#ffcc00', 1.0);
            } else if (item.type === 'health' && item.healAmount) {
              this.player.heal(item.healAmount);
              addFloatingText(this.player.px, this.player.py - TILE_SIZE, `+${item.healAmount} HP`, '#44ff44', 1.0);
            }
            this.camera.shake(2, 0.1);
          }
        }
      }
      if (wasKeyPressed('Escape') || (wasKeyPressed('Space') && !(this.shopRoomCenter && this.player.x === this.shopRoomCenter.x && this.player.y === this.shopRoomCenter.y))) {
        this.shopOpen = false;
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

    // Quantum Shield: reflect enemy projectiles off temporary walls
    const hasQuantumShield = this.player.synergies.evolutions.some(e => e.recipe.id === 'quantum_shield');

    const dmgMult = this.player.synergies.damageMult * this.comboMult;
    for (const proj of this.projectiles) {
      const prevX = proj.x;
      const prevY = proj.y;
      proj.update(dt, this.map);

      // Quantum Shield: reflect enemy projectiles on temporary wall collision
      if (proj.dead && !proj.fromPlayer && hasQuantumShield) {
        const hitTileX = Math.floor(proj.x / TILE_SIZE);
        const hitTileY = Math.floor(proj.y / TILE_SIZE);
        const isTemporaryWall = this.temporaryWalls.some(w => w.x === hitTileX && w.y === hitTileY);
        if (isTemporaryWall) {
          proj.dead = false;
          proj.dx = -proj.dx;
          proj.dy = -proj.dy;
          proj.fromPlayer = true;
          proj.x = prevX;
          proj.y = prevY;
          proj.lifetime = 1.0;
          proj.color = '#00eedd';
          addFlash(proj.x, proj.y, TILE_SIZE * 0.5, '#00eedd', 0.15);
        }
      }

      if (proj.dead) continue;

      if (proj.fromPlayer) {
        for (const enemy of this.enemies) {
          if (enemy.dead) continue;
          const dx = proj.x - enemy.px;
          const dy = proj.y - enemy.py;
          if (dx * dx + dy * dy < (TILE_SIZE * 0.5) ** 2) {
            // Magnetic Pull: 20% more damage to nearby enemies
            let magneticMult = 1;
            const hasMagneticPull = this.player.synergies.evolutions.some(e => e.recipe.id === 'magnetic_pull');
            if (hasMagneticPull && Math.abs(enemy.x - this.player.x) + Math.abs(enemy.y - this.player.y) <= 2) magneticMult = 1.2;
            const finalDmg = Math.round(proj.damage * dmgMult * magneticMult);
            enemy.takeDamage(finalDmg);
            const dmgColor = finalDmg >= 30 ? '#ffcc00' : '#ff4444';
            addFloatingText(enemy.px, enemy.py - TILE_SIZE * 0.5, `-${finalDmg}`, dmgColor);
            addFlash(enemy.px, enemy.py, TILE_SIZE * 0.3, '#ffffff');
            this.camera.shake(2, 0.1);
            const totalLs = proj.lifesteal + this.player.synergies.lifestealBonus;
            if (totalLs > 0) {
              const healed = Math.round(finalDmg * totalLs);
              this.player.heal(healed);
              addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, `+${healed}`, '#44ff44');
            }
            // Apply synergy-boosted status effect from projectile
            if (proj.statusEffect && proj.fromPlayer) {
              this.applyBoostedStatus(enemy, proj.statusEffect);
            } else if (proj.statusEffect) {
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
            // Acid Rain evolution: split into 3 on impact
            if (proj.dead) {
              const hasAcidRain = this.player.synergies.evolutions.some(e => e.recipe.id === 'acid_rain');
              if (hasAcidRain && !proj.isSplit) {
                for (let s = 0; s < 3; s++) {
                  const angle = (s / 3) * Math.PI * 2;
                  const splitProj = new Projectile(proj.x, proj.y, Math.cos(angle), Math.sin(angle), {
                    speed: proj.speed * 0.8,
                    damage: Math.round(proj.damage * 0.4),
                    lifetime: 0.5,
                    color: '#cccc00',
                    fromPlayer: true,
                  });
                  splitProj.isSplit = true;
                  this.projectiles.push(splitProj);
                }
              }
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

    // 1-4: select slot + fire ability
    for (let i = 0; i < MUTATION_SLOTS; i++) {
      if (wasKeyPressed(`Digit${i + 1}`)) {
        this.selectedSlot = i;
        this.player.useAbility(i);
      }
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

  /** Apply synergy-boosted status effects to enemies (Thermite/Catalyst bonuses) */
  private applyBoostedStatus(enemy: Enemy, effect: StatusEffect): void {
    const boosted = { ...effect };
    boosted.duration *= this.player.synergies.statusDurationMult;
    if (boosted.type === StatusType.Burn) {
      boosted.tickDamage = Math.round(boosted.tickDamage * this.player.synergies.burnDamageMult);
    }
    enemy.applyStatusEffect(boosted);
  }

  private handleTendrilAttack(): void {
    const { dx, dy } = facingToDelta(this.player.facing);

    // --- Cone parameters (match the VFX exactly) ---
    const sweepAngle = Math.atan2(dy, dx);
    const sweepArc = Math.PI * 0.8;           // 144° cone
    const sweepRange = TILE_SIZE * 2.5;        // pixel radius of the cone
    const halfArc = sweepArc / 2;

    // --- Sweep VFX ---
    addSweep(this.player.px, this.player.py, sweepRange, sweepAngle, sweepArc, '#e2e2e2', 0.2);
    this.camera.shake(3, 0.1);

    // --- Floor-scaling damage ---
    const floorScale = 1 + this.floor * 0.2;
    const dmgMult = this.player.synergies.damageMult * this.comboMult;
    const baseDmg = this.player.tendrilBaseDamage * floorScale;
    const lifestealPct = 0.1 + this.player.synergies.lifestealBonus; // 10% innate + synergy bonus

    let totalDamageDealt = 0;

    for (const enemy of this.enemies) {
      if (enemy.dead) continue;

      // --- Distance + angle cone check (matches visual arc) ---
      const edx = enemy.px - this.player.px;
      const edy = enemy.py - this.player.py;
      const dist = Math.sqrt(edx * edx + edy * edy);
      if (dist > sweepRange || dist < 1) continue;

      let angleToEnemy = Math.atan2(edy, edx) - sweepAngle;
      // Normalize to [-PI, PI]
      while (angleToEnemy > Math.PI) angleToEnemy -= Math.PI * 2;
      while (angleToEnemy < -Math.PI) angleToEnemy += Math.PI * 2;
      if (Math.abs(angleToEnemy) > halfArc) continue;

      const finalDmg = Math.round(baseDmg * dmgMult);
      enemy.takeDamage(finalDmg);
      totalDamageDealt += finalDmg;
      const tdmgColor = finalDmg >= 20 ? '#ffcc00' : '#ff4444';
      addFloatingText(enemy.px, enemy.py - TILE_SIZE * 0.5, `-${finalDmg}`, tdmgColor);
      addFlash(enemy.px, enemy.py, TILE_SIZE * 0.4, '#ffffff');

      // --- Knockback: push enemy 1 tile in facing direction ---
      if (!enemy.dead) {
        const kbx = enemy.x + dx;
        const kby = enemy.y + dy;
        if (kbx >= 0 && kbx < MAP_WIDTH && kby >= 0 && kby < MAP_HEIGHT) {
          const tile = this.map[kby][kbx];
          if (tile !== TileType.Wall && tile !== TileType.CrackedWall && tile !== TileType.LockedDoor && tile !== TileType.Lava) {
            const blocked = this.enemies.some(e => !e.dead && e !== enemy && e.x === kbx && e.y === kby);
            if (!blocked) {
              enemy.x = kbx;
              enemy.y = kby;
              enemy.tx = kbx;
              enemy.ty = kby;
              enemy.px = kbx * TILE_SIZE + TILE_SIZE / 2;
              enemy.py = kby * TILE_SIZE + TILE_SIZE / 2;
              addTrail(enemy.px, enemy.py, '#aaaacc', 0.15);
            }
          }
        }
      }

      if (enemy.dead) { this.lastKillWasMelee = true; this.onEnemyDeath(enemy); this.lastKillWasMelee = false; }
    }

    // --- Innate lifesteal ---
    if (totalDamageDealt > 0 && lifestealPct > 0) {
      const healed = Math.round(totalDamageDealt * lifestealPct);
      if (healed > 0) {
        this.player.heal(healed);
        addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, `+${healed}`, '#44ff88');
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
    // Supernova evolution: dash ends with massive explosion
    const hasSupernova = this.player.synergies.evolutions.some(e => e.recipe.id === 'supernova');
    if (hasSupernova) {
      this.handleExplosion(this.player.px, this.player.py, TILE_SIZE * 4, damage * 2, lifesteal);
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
          const healed = Math.round(finalDmg * totalLs);
          this.player.heal(healed);
          addFloatingText(this.player.px, this.player.py - TILE_SIZE * 0.5, `+${healed}`, '#44ff44');
        }
        if (enemy.dead) this.onEnemyDeath(enemy);
      }
    }
    // Spore Burst evolution: AoE leaves healing zone
    const hasSporeBurst = this.player.synergies.evolutions.some(e => e.recipe.id === 'spore_burst');
    if (hasSporeBurst) {
      this.healingZones.push({
        x: this.player.px, y: this.player.py,
        radius: radius * 0.8,
        timer: 4.0, healPerTick: 3, tickTimer: 0,
      });
      addFloatingText(this.player.px, this.player.py - TILE_SIZE * 1.5, 'HEALING ZONE!', '#33ff99', 1.0);
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

    // Swarm Matrix evolution: walls spawn mini allies
    const hasSwarmMatrix = this.player.synergies.evolutions.some(e => e.recipe.id === 'swarm_matrix');
    if (hasSwarmMatrix) {
      for (const t of tiles) {
        // Spawn ally adjacent to each wall tile
        const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [ddx, ddy] of dirs) {
          const ax = t.x + ddx;
          const ay = t.y + ddy;
          if (ax >= 0 && ax < MAP_WIDTH && ay >= 0 && ay < MAP_HEIGHT) {
            const tile = this.map[ay][ax];
            if (tile !== TileType.Wall && tile !== TileType.LockedDoor) {
              const ally = new Ally(ax, ay, 8 + this.floor * 2, duration, '#00eedd', 0, null);
              this.allies.push(ally);
              addRing(ax * TILE_SIZE + TILE_SIZE / 2, ay * TILE_SIZE + TILE_SIZE / 2, TILE_SIZE, '#00eedd', 0.3);
              break; // One ally per wall tile
            }
          }
        }
      }
      addFloatingText(this.player.px, this.player.py - TILE_SIZE * 1.5, 'SWARM!', '#00eedd', 1.0);
    }
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
      this.player.heal(Math.round((3 + this.floor) * this.comboCount));
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

    // Iron Frenzy: melee kills reset all ability cooldowns
    const hasIronFrenzy = this.player.synergies.evolutions.some(e => e.recipe.id === 'iron_frenzy');
    if (hasIronFrenzy && this.lastKillWasMelee) {
      for (const ability of this.player.abilities) {
        if (ability) ability.cooldown = 0;
      }
      addFloatingText(this.player.px, this.player.py - TILE_SIZE * 2, 'FRENZY!', '#4466ff', 1.0);
    }

    // Elite death
    if (enemy.isElite) {
      addFloatingText(enemy.px, enemy.py - TILE_SIZE * 1.5, 'ELITE SLAIN!', '#ffcc44', 2.0);
      addRing(enemy.px, enemy.py, TILE_SIZE * 2.5, '#ffcc44', 0.5);
      const eliteDrop = generateMineral(this.floor);
      eliteDrop.rarity = Math.max(1, eliteDrop.rarity) as typeof eliteDrop.rarity;
      this.minerals.push(new Mineral(enemy.x, enemy.y, eliteDrop));
    } else {
      addFloatingText(enemy.px, enemy.py - TILE_SIZE, 'KILLED!', '#ffcc00', 0.8);
    }
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

    // Render secret substrate caches
    for (const cache of this.secretCaches) {
      if (cache.claimed) continue;
      const sx = cache.x * TILE_SIZE + TILE_SIZE / 2 - this.camera.x;
      const sy = cache.y * TILE_SIZE + TILE_SIZE / 2 - this.camera.y;
      const dist = Math.sqrt((cache.x - this.player.x) ** 2 + (cache.y - this.player.y) ** 2);
      if (dist > VISION_RADIUS) continue;

      // Pulsing outer glow
      const pulse = 0.4 + Math.sin(this.gameTime * 2.5) * 0.2;
      const grad = this.ctx.createRadialGradient(sx, sy, 0, sx, sy, TILE_SIZE * 1.2);
      grad.addColorStop(0, `rgba(0,255,180,${pulse * 0.6})`);
      grad.addColorStop(0.6, `rgba(0,200,255,${pulse * 0.3})`);
      grad.addColorStop(1, 'rgba(0,255,180,0)');
      this.ctx.beginPath();
      this.ctx.arc(sx, sy, TILE_SIZE * 1.2, 0, Math.PI * 2);
      this.ctx.fillStyle = grad;
      this.ctx.fill();

      // Crystal shape (hexagonal)
      const sz = 5 + Math.sin(this.gameTime * 3) * 1;
      this.ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 6;
        const px = sx + Math.cos(angle) * sz;
        const py = sy + Math.sin(angle) * sz;
        if (i === 0) this.ctx.moveTo(px, py);
        else this.ctx.lineTo(px, py);
      }
      this.ctx.closePath();
      this.ctx.fillStyle = '#00ffb4';
      this.ctx.fill();
      this.ctx.strokeStyle = '#00ddff';
      this.ctx.lineWidth = 1.5;
      this.ctx.stroke();

      // Inner sparkle
      const sparkle = 0.6 + Math.sin(this.gameTime * 5) * 0.4;
      this.ctx.beginPath();
      this.ctx.arc(sx, sy, 2, 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(255,255,255,${sparkle})`;
      this.ctx.fill();

      // Label
      this.ctx.fillStyle = '#00ffb4';
      this.ctx.font = 'bold 6px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('CACHE', sx, sy - sz - 5);
      if (this.player.x === cache.x && this.player.y === cache.y) {
        this.ctx.fillStyle = '#00ddff';
        this.ctx.font = '7px monospace';
        this.ctx.fillText('[SPACE] Open', sx, sy + sz + 9);
      }
      this.ctx.textAlign = 'start';
    }

    // Render shop NPC
    if (this.shopRoomCenter) {
      const sx = this.shopRoomCenter.x * TILE_SIZE + TILE_SIZE / 2 - this.camera.x;
      const sy = this.shopRoomCenter.y * TILE_SIZE + TILE_SIZE / 2 - this.camera.y;
      const shopDist = Math.sqrt((this.shopRoomCenter.x - this.player.x) ** 2 + (this.shopRoomCenter.y - this.player.y) ** 2);
      if (shopDist <= VISION_RADIUS) {
        // Gold diamond
        const sz = 7;
        this.ctx.beginPath();
        this.ctx.moveTo(sx, sy - sz);
        this.ctx.lineTo(sx + sz, sy);
        this.ctx.lineTo(sx, sy + sz);
        this.ctx.lineTo(sx - sz, sy);
        this.ctx.closePath();
        this.ctx.fillStyle = '#e0a030';
        this.ctx.fill();
        this.ctx.strokeStyle = '#ffcc00';
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();
        // Label
        this.ctx.fillStyle = '#ffcc00';
        this.ctx.font = 'bold 7px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('SHOP', sx, sy - sz - 4);
        if (this.player.x === this.shopRoomCenter.x && this.player.y === this.shopRoomCenter.y && !this.shopOpen) {
          this.ctx.fillStyle = '#e0a030';
          this.ctx.font = '8px monospace';
          this.ctx.fillText('[SPACE] Browse', sx, sy + sz + 10);
        }
        this.ctx.textAlign = 'start';
      }
    }

    // Render healing zones
    for (const zone of this.healingZones) {
      const zsx = zone.x - this.camera.x;
      const zsy = zone.y - this.camera.y;
      const alpha = Math.min(0.25, zone.timer * 0.1);
      const pulse = 0.5 + Math.sin(this.gameTime * 5) * 0.3;
      this.ctx.beginPath();
      this.ctx.arc(zsx, zsy, zone.radius, 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(50,255,150,${alpha * pulse})`;
      this.ctx.fill();
      this.ctx.strokeStyle = `rgba(50,255,100,${alpha * 1.5})`;
      this.ctx.lineWidth = 1;
      this.ctx.stroke();
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
        if (tx < 0 || tx >= MAP_WIDTH || ty < 0 || ty >= MAP_HEIGHT || this.map[ty][tx] === TileType.Wall || this.map[ty][tx] === TileType.CrackedWall) {
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

    // Floor transition overlay
    if (this.transitionTimer > 0) {
      const alpha = this.transitionTimer > 1.0 ? (1.5 - this.transitionTimer) * 2 : Math.min(1, this.transitionTimer / 0.5);
      this.ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, alpha)})`;
      this.ctx.fillRect(0, 0, this.canvasW, this.canvasH);
      const textAlpha = Math.min(1, alpha * 1.5);
      this.ctx.globalAlpha = textAlpha;
      this.ctx.fillStyle = '#e0a030';
      this.ctx.font = 'bold 32px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(`FLOOR ${this.transitionFloor}`, this.canvasW / 2, this.canvasH / 2 - 10);
      this.ctx.fillStyle = '#888';
      this.ctx.font = '14px monospace';
      this.ctx.fillText(this.transitionMessage, this.canvasW / 2, this.canvasH / 2 + 20);
      this.ctx.textAlign = 'start';
      this.ctx.globalAlpha = 1;
    }

    // Shop overlay
    if (this.shopOpen) {
      this.renderShopOverlay();
    }

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

        // Save run history
        const runRecord: RunRecord = {
          floor: this.floor,
          kills: this.runKills,
          bossKills: this.runBossKills,
          evolutions: Math.max(0, evoCount),
          points: reward,
          timestamp: Date.now(),
        };
        if (!this.progress.runHistory) this.progress.runHistory = [];
        this.progress.runHistory.push(runRecord);
        if (this.progress.runHistory.length > 10) this.progress.runHistory = this.progress.runHistory.slice(-10);

        saveProgress(this.progress);
      }

      this.ctx.fillStyle = 'rgba(0,0,0,0.85)';
      this.ctx.fillRect(0, 0, this.canvasW, this.canvasH);
      const cx = this.canvasW / 2;

      // Title
      this.ctx.fillStyle = '#e53170';
      this.ctx.font = 'bold 28px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('DISSOLVED', cx, 60);

      // Run stats
      this.ctx.font = '11px monospace';
      this.ctx.fillStyle = '#aaa';
      this.ctx.fillText(`Floor ${this.floor} | Kills: ${this.runKills} | Bosses: ${this.runBossKills}`, cx, 85);

      const evoCount = this.player.discoveredEvolutions.size - (this.progress.discoveredEvolutions?.length || 0);
      const reward = calculateRunReward(this.floor, this.runKills, this.runBossKills, Math.max(0, evoCount));
      this.ctx.fillStyle = '#e0a030';
      this.ctx.fillText(`+${reward} Substrate Points (Total: ${this.progress.substratePoints})`, cx, 103);

      this.ctx.fillStyle = '#888';
      this.ctx.fillText(`Best: Floor ${this.progress.bestFloor} | Runs: ${this.progress.totalRuns}`, cx, 121);

      // Best run from history
      if (this.progress.runHistory && this.progress.runHistory.length > 1) {
        const best = this.progress.runHistory.reduce((a, b) => a.floor > b.floor || (a.floor === b.floor && a.kills > b.kills) ? a : b);
        this.ctx.fillStyle = '#666';
        this.ctx.font = '9px monospace';
        this.ctx.fillText(`Record: Floor ${best.floor}, ${best.kills} kills, ${best.bossKills} bosses`, cx, 133);
      }

      // Divider line
      const dividerY = (this.progress.runHistory && this.progress.runHistory.length > 1) ? 143 : 135;
      this.ctx.strokeStyle = '#333';
      this.ctx.beginPath();
      this.ctx.moveTo(cx - 200, dividerY);
      this.ctx.lineTo(cx + 200, dividerY);
      this.ctx.stroke();

      // Two-column layout: Evolutions (left) | Upgrades (right)
      const colLeft = cx - 160;
      const colRight = cx + 60;
      const colTop = dividerY + 12;

      // Left column: Evolutions
      this.ctx.textAlign = 'start';
      this.ctx.fillStyle = '#ffcc00';
      this.ctx.font = 'bold 10px monospace';
      this.ctx.fillText('EVOLUTIONS', colLeft, colTop);
      let ey = colTop + 16;
      this.ctx.font = '9px monospace';
      for (const recipe of EVOLUTION_RECIPES) {
        const discovered = this.player.discoveredEvolutions.has(recipe.id);
        this.ctx.fillStyle = discovered ? recipe.color : '#333';
        this.ctx.fillText(discovered ? `● ${recipe.name}` : '● ???', colLeft, ey);
        ey += 13;
      }

      // Right column: Upgrades
      this.ctx.fillStyle = '#44ccff';
      this.ctx.font = 'bold 10px monospace';
      this.ctx.fillText('UPGRADES [1-5]', colRight, colTop);
      let uy = colTop + 16;
      this.ctx.font = '9px monospace';
      for (let i = 0; i < UPGRADES.length; i++) {
        const upg = UPGRADES[i];
        const level = getUpgradeLevel(this.progress, upg.id);
        const maxed = level >= upg.maxLevel;
        const canAfford = !maxed && this.progress.substratePoints >= upg.costPerLevel;
        this.ctx.fillStyle = maxed ? '#666' : canAfford ? '#44ccff' : '#555';
        const lvlStr = maxed ? 'MAX' : `Lv${level}→${level + 1} (${upg.costPerLevel}pts)`;
        this.ctx.fillText(`${i + 1}. ${upg.name}: ${lvlStr}`, colRight, uy);
        if (level > 0) {
          uy += 11;
          this.ctx.fillStyle = '#888';
          this.ctx.fillText(`  ${upg.description(level)}`, colRight, uy);
        }
        uy += 14;
      }

      // Restart prompt at bottom
      this.ctx.textAlign = 'center';
      this.ctx.fillStyle = '#ccccdd';
      this.ctx.font = 'bold 12px monospace';
      this.ctx.fillText('Press R to restart', cx, Math.max(ey, uy) + 20);
      this.ctx.textAlign = 'start';
    }
  }

  private renderShopOverlay(): void {
    const panelW = 320;
    const panelH = 40 + this.shopInventory.length * 28;
    const panelX = this.canvasW / 2 - panelW / 2;
    const panelY = this.canvasH / 2 - panelH / 2;

    // Background
    this.ctx.fillStyle = 'rgba(0,0,0,0.85)';
    this.ctx.fillRect(panelX, panelY, panelW, panelH);
    this.ctx.strokeStyle = '#e0a030';
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(panelX, panelY, panelW, panelH);

    // Title
    this.ctx.fillStyle = '#e0a030';
    this.ctx.font = 'bold 14px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('MERCHANT', this.canvasW / 2, panelY + 20);
    this.ctx.fillStyle = '#888';
    this.ctx.font = '9px monospace';
    this.ctx.fillText('Pay with HP  |  [1-4] Buy  [ESC] Close', this.canvasW / 2, panelY + 34);

    // Items
    this.ctx.textAlign = 'start';
    for (let i = 0; i < this.shopInventory.length; i++) {
      const item = this.shopInventory[i];
      const iy = panelY + 50 + i * 28;

      if (item.purchased) {
        this.ctx.fillStyle = '#444';
        this.ctx.font = '10px monospace';
        this.ctx.fillText(`[${i + 1}] SOLD`, panelX + 12, iy + 8);
        continue;
      }

      const canAfford = this.player.hp > item.hpCost;
      if (item.type === 'mineral' && item.mineral) {
        const elemColor = ELEMENT_COLORS[item.mineral.element];
        this.ctx.fillStyle = canAfford ? elemColor : '#555';
        this.ctx.font = 'bold 10px monospace';
        const name = `${MODIFIER_NAMES[item.mineral.modifier]} ${ELEMENT_NAMES[item.mineral.element]}`;
        this.ctx.fillText(`[${i + 1}] ${name}`, panelX + 12, iy + 8);
        // Rarity tag
        const rarityNames = ['Common', 'Uncommon', 'Rare', 'Legendary'];
        const rarityColors = ['#aaa', '#44cc44', '#4488ff', '#ff8800'];
        this.ctx.fillStyle = canAfford ? rarityColors[item.mineral.rarity] : '#555';
        this.ctx.font = '8px monospace';
        this.ctx.fillText(`[${rarityNames[item.mineral.rarity]}]`, panelX + 210, iy + 8);
      } else {
        this.ctx.fillStyle = canAfford ? '#44ff44' : '#555';
        this.ctx.font = 'bold 10px monospace';
        this.ctx.fillText(`[${i + 1}] Health Potion (+${item.healAmount} HP)`, panelX + 12, iy + 8);
      }

      // Cost
      this.ctx.fillStyle = canAfford ? '#ff6666' : '#553333';
      this.ctx.font = '9px monospace';
      this.ctx.textAlign = 'end';
      this.ctx.fillText(`-${item.hpCost} HP`, panelX + panelW - 12, iy + 8);
      this.ctx.textAlign = 'start';
    }
    this.ctx.textAlign = 'start';
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

    const showAllEnemies = this.player.hasMercuryPassive;
    for (const e of this.enemies) {
      if (e.dead) continue;
      // Without Mercury passive, only show enemies within vision range
      if (!showAllEnemies && !e.isBoss) {
        const edx = e.x - this.player.x;
        const edy = e.y - this.player.y;
        if (edx * edx + edy * edy > (VISION_RADIUS + 2) ** 2) continue;
      }
      if (e.isBoss) {
        this.ctx.fillStyle = '#ff4488';
        this.ctx.fillRect(mmX + e.x * mmScale - 1, mmY + e.y * mmScale - 1, 3, 3);
      } else if (e.isElite) {
        this.ctx.fillStyle = '#ffcc44';
        this.ctx.fillRect(mmX + e.x * mmScale, mmY + e.y * mmScale, 2, 2);
      } else {
        this.ctx.fillStyle = showAllEnemies ? '#ff6666' : '#cc4444';
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
