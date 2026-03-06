import { MUTATION_SLOTS, MUTATION_DECAY_TIME, COLORS, ELEMENT_COLORS, ELEMENT_NAMES, MODIFIER_NAMES, RARITY_NAMES, RARITY_COLORS, STATUS_COLORS, STATUS_NAMES, BUFF_COLORS, BUFF_NAMES } from './constants';
import { Element, Modifier } from './types';
import { getAbilityDescription } from './abilities';
import { evaluateSynergies } from './synergy';
import type { ActiveBuff } from './types';
import type { Player } from './player';
import type { Mineral } from './minerals';
import type { Enemy } from './enemy';

const PASSIVE_PERKS: Record<number, string> = {
  0: 'Passive: +5 max HP',
  1: 'Passive: +5% speed',
  2: 'Passive: +10% damage',
  3: 'Passive: -10% cooldown',
  4: 'Passive: +5% lifesteal',
  5: 'Passive: minimap reveals enemies',
};

/** Maps element to ability type for evolution star matching */
const ELEM_TO_TYPE: Record<number, string> = {
  [Element.Iron]: 'shield',
  [Element.Carbon]: 'dash',
  [Element.Sulfur]: 'projectile',
  [Element.Silicon]: 'wall',
  [Element.Phosphorus]: 'aoe',
  [Element.Mercury]: 'teleport',
};

const SLOT_SIZE = 36;
const SLOT_GAP = 6;
const HUD_PADDING = 12;
const HP_BAR_WIDTH = 160;
const HP_BAR_HEIGHT = 10;

export function renderHud(
  ctx: CanvasRenderingContext2D,
  player: Player,
  canvasW: number,
  canvasH: number,
  selectedSlot: number,
  nearbyMineral: Mineral | null,
  visibleEnemies: Enemy[],
  floor: number,
  comboCount: number = 0,
  comboTimer: number = 0,
  bossAlive: boolean = false,
  keys: number = 0,
  activeBuffs: ActiveBuff[] = [],
): void {
  // HP bar — top left
  const hpX = HUD_PADDING;
  const hpY = HUD_PADDING;

  ctx.fillStyle = COLORS.hpBarBg;
  ctx.fillRect(hpX, hpY, HP_BAR_WIDTH, HP_BAR_HEIGHT);

  const hpFrac = player.hp / player.maxHp;
  ctx.fillStyle = COLORS.hpBar;
  ctx.fillRect(hpX, hpY, HP_BAR_WIDTH * hpFrac, HP_BAR_HEIGHT);

  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(hpX, hpY, HP_BAR_WIDTH, HP_BAR_HEIGHT);

  ctx.fillStyle = COLORS.text;
  ctx.font = '10px monospace';
  ctx.textAlign = 'start';
  ctx.fillText(`${player.hp}/${player.maxHp}`, hpX + HP_BAR_WIDTH + 6, hpY + HP_BAR_HEIGHT - 1);

  // Overload bar (below HP)
  if (player.overloadTimer > 0) {
    const olY = hpY + HP_BAR_HEIGHT + 3;
    const olFrac = player.overloadTimer / 15;
    ctx.fillStyle = '#331800';
    ctx.fillRect(hpX, olY, HP_BAR_WIDTH, 6);
    ctx.fillStyle = '#ff8800';
    ctx.fillRect(hpX, olY, HP_BAR_WIDTH * olFrac, 6);
    ctx.strokeStyle = '#664400';
    ctx.lineWidth = 1;
    ctx.strokeRect(hpX, olY, HP_BAR_WIDTH, 6);
    ctx.fillStyle = '#ffcc00';
    ctx.font = 'bold 8px monospace';
    ctx.fillText(`OVERLOADED ${Math.ceil(player.overloadTimer)}s`, hpX + HP_BAR_WIDTH + 6, olY + 5);
  }

  // Player status effect icons — below HP bar
  if (player.statusEffects.length > 0) {
    const seY = hpY + HP_BAR_HEIGHT + (player.overloadTimer > 0 ? 12 : 3);
    let seX = hpX;
    for (const se of player.statusEffects) {
      const color = STATUS_COLORS[se.type] || '#ffffff';
      const name = STATUS_NAMES[se.type] || '?';
      ctx.fillStyle = color + '60';
      ctx.fillRect(seX, seY, 40, 12);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(seX, seY, 40, 12);
      ctx.fillStyle = color;
      ctx.font = 'bold 7px monospace';
      ctx.fillText(`${name} ${Math.ceil(se.duration)}s`, seX + 2, seY + 9);
      seX += 44;
    }
  }

  // Floor indicator + key count
  ctx.fillStyle = '#e0a030';
  ctx.font = 'bold 11px monospace';
  const floorText = `Floor ${floor}`;
  ctx.fillText(floorText, hpX + HP_BAR_WIDTH + 50, hpY + HP_BAR_HEIGHT - 1);
  if (keys > 0) {
    const floorTextW = ctx.measureText(floorText).width;
    ctx.fillStyle = '#ffdd44';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(`🔑${keys}`, hpX + HP_BAR_WIDTH + 54 + floorTextW, hpY + HP_BAR_HEIGHT - 1);
  }

  // Active buffs display
  if (activeBuffs.length > 0) {
    const buffY = hpY + HP_BAR_HEIGHT + (player.overloadTimer > 0 ? 12 : 3) + (player.statusEffects.length > 0 ? 16 : 0);
    let buffX = hpX;
    for (const buff of activeBuffs) {
      const color = BUFF_COLORS[buff.type] || '#ffffff';
      const name = BUFF_NAMES[buff.type] || '?';
      ctx.fillStyle = color + '30';
      ctx.fillRect(buffX, buffY, 52, 12);
      ctx.strokeStyle = color + 'aa';
      ctx.lineWidth = 1;
      ctx.strokeRect(buffX, buffY, 52, 12);
      ctx.fillStyle = color;
      ctx.font = 'bold 7px monospace';
      ctx.fillText(`${name} ${Math.ceil(buff.duration)}s`, buffX + 2, buffY + 9);
      buffX += 56;
    }
  }

  // Combo counter
  if (comboCount >= 2 && comboTimer > 0) {
    const comboX = canvasW / 2;
    const comboY = 30;
    const alpha = Math.min(1, comboTimer);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffcc00';
    ctx.font = `bold ${14 + comboCount * 2}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`${comboCount}x COMBO`, comboX, comboY);
    ctx.fillStyle = '#ff8844';
    ctx.font = '9px monospace';
    ctx.fillText(`+${Math.round(comboCount * 15)}% DMG`, comboX, comboY + 14);
    ctx.textAlign = 'start';
    ctx.globalAlpha = 1;
  }

  // Boss HP bar — top center
  if (bossAlive) {
    const boss = visibleEnemies.find(e => e.isBoss);
    if (boss) {
      renderBossHpBar(ctx, canvasW, boss);
    }
  }

  // Controls hint — top right
  ctx.fillStyle = '#666';
  ctx.font = '9px monospace';
  ctx.textAlign = 'end';
  ctx.fillText('[1-4] Ability  [E] Melee  [F] Fuse  [Q] Drop  [Space] Interact', canvasW - HUD_PADDING, hpY + HP_BAR_HEIGHT - 1);
  ctx.textAlign = 'start';

  // Enemy legend — top left below HP
  renderEnemyLegend(ctx, hpX, hpY + HP_BAR_HEIGHT + 8, visibleEnemies);

  // Synergy indicators — right side
  renderSynergies(ctx, canvasW, player);

  // Mutation slots — bottom center
  const totalWidth = MUTATION_SLOTS * SLOT_SIZE + (MUTATION_SLOTS - 1) * SLOT_GAP;
  const slotsX = (canvasW - totalWidth) / 2;
  const slotsY = canvasH - SLOT_SIZE - HUD_PADDING;

  for (let i = 0; i < MUTATION_SLOTS; i++) {
    const sx = slotsX + i * (SLOT_SIZE + SLOT_GAP);
    const mutation = player.mutations[i];
    const ability = player.abilities[i];

    // Slot background — fused slots get dual-color gradient
    if (mutation?.fused && mutation.secondElement !== undefined) {
      const grad = ctx.createLinearGradient(sx, slotsY, sx + SLOT_SIZE, slotsY + SLOT_SIZE);
      grad.addColorStop(0, ELEMENT_COLORS[mutation.element] + '40');
      grad.addColorStop(1, ELEMENT_COLORS[mutation.secondElement] + '40');
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = mutation ? ELEMENT_COLORS[mutation.element] + '30' : COLORS.slotEmpty;
    }
    ctx.fillRect(sx, slotsY, SLOT_SIZE, SLOT_SIZE);

    // Cooldown overlay
    if (ability && ability.cooldown > 0) {
      const cdFrac = ability.cooldown / ability.maxCooldown;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(sx, slotsY, SLOT_SIZE, SLOT_SIZE * cdFrac);
    }

    // Decay timer arc
    if (mutation && player.mutationTimers[i] > 0) {
      const decayFrac = player.mutationTimers[i] / MUTATION_DECAY_TIME;
      const cx = sx + SLOT_SIZE / 2;
      const cy = slotsY + SLOT_SIZE / 2;

      // Draw arc showing remaining time
      ctx.beginPath();
      ctx.arc(cx, cy, SLOT_SIZE / 2 + 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * decayFrac);
      ctx.strokeStyle = decayFrac < 0.25 ? '#ff4444' : decayFrac < 0.5 ? '#ffaa44' : ELEMENT_COLORS[mutation.element] + '88';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Selected slot highlight
    if (i === selectedSlot) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - 1, slotsY - 1, SLOT_SIZE + 2, SLOT_SIZE + 2);
    }

    // Slot border — fused gets gold double-border
    if (mutation?.fused) {
      ctx.strokeStyle = '#ffcc00';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, slotsY, SLOT_SIZE, SLOT_SIZE);
      ctx.strokeStyle = '#aa8800';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 2, slotsY + 2, SLOT_SIZE - 4, SLOT_SIZE - 4);
    } else {
      ctx.strokeStyle = mutation ? ELEMENT_COLORS[mutation.element] : COLORS.slotBorder;
      ctx.lineWidth = mutation ? 2 : 1;
      ctx.strokeRect(sx, slotsY, SLOT_SIZE, SLOT_SIZE);
    }

    // Evolution star indicator on affected slots
    const slotType = mutation
      ? (mutation.modifier === Modifier.Adaptive ? 'summon' : ELEM_TO_TYPE[mutation.element])
      : null;
    const slotEvolution = slotType
      ? player.synergies.evolutions.find(evo => evo.recipe.target === slotType)
      : null;
    if (slotEvolution) {
      ctx.fillStyle = slotEvolution.recipe.color;
      ctx.font = 'bold 9px monospace';
      ctx.fillText('★', sx + SLOT_SIZE - 10, slotsY + 10);
    }

    // Key number with background pill
    const keyReady = ability && ability.cooldown <= 0;
    ctx.fillStyle = keyReady ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.3)';
    ctx.fillRect(sx + 1, slotsY + 1, 11, 11);
    ctx.fillStyle = keyReady ? '#ddd' : '#666';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${i + 1}`, sx + 7, slotsY + 10);
    ctx.textAlign = 'start';

    // Rarity dot in top-right corner of slot
    if (mutation) {
      ctx.beginPath();
      ctx.arc(sx + SLOT_SIZE - 5, slotsY + 5, 3, 0, Math.PI * 2);
      ctx.fillStyle = RARITY_COLORS[mutation.rarity];
      ctx.fill();
    }

    if (mutation) {
      const cx = sx + SLOT_SIZE / 2;
      const cy = slotsY + SLOT_SIZE / 2;
      const size = 8;

      if (mutation.fused && mutation.secondElement !== undefined) {
        // Fused: draw a dual-colored star shape
        const s = size + 1;
        ctx.beginPath();
        for (let p = 0; p < 6; p++) {
          const angle = (p * Math.PI * 2) / 6 - Math.PI / 2;
          const r = p % 2 === 0 ? s : s * 0.5;
          const method = p === 0 ? 'moveTo' : 'lineTo';
          ctx[method](cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
        }
        ctx.closePath();
        ctx.fillStyle = ELEMENT_COLORS[mutation.element];
        ctx.fill();
        ctx.beginPath();
        for (let p = 0; p < 6; p++) {
          const angle = (p * Math.PI * 2) / 6 + Math.PI / 6;
          const r = p % 2 === 0 ? s : s * 0.5;
          const method = p === 0 ? 'moveTo' : 'lineTo';
          ctx[method](cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
        }
        ctx.closePath();
        ctx.fillStyle = ELEMENT_COLORS[mutation.secondElement];
        ctx.fill();
      } else {
        // Normal diamond
        ctx.beginPath();
        ctx.moveTo(cx, cy - size);
        ctx.lineTo(cx + size, cy);
        ctx.lineTo(cx, cy + size);
        ctx.lineTo(cx - size, cy);
        ctx.closePath();
        ctx.fillStyle = ELEMENT_COLORS[mutation.element];
        ctx.fill();
      }

      if (ability) {
        // Show short ability name below slot
        const shortName = mutation.fused ? ability.name : (ability.name.split(' ')[1] || ability.name);
        ctx.fillStyle = mutation.fused ? '#ddbb44' : '#777';
        ctx.font = '7px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(shortName, sx + SLOT_SIZE / 2, slotsY + SLOT_SIZE + 9);
        ctx.textAlign = 'start';
      }

      // Decay time text
      if (player.mutationTimers[i] > 0 && player.mutationTimers[i] < 60) {
        ctx.fillStyle = '#ff6644';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.ceil(player.mutationTimers[i])}s`, sx + SLOT_SIZE / 2, slotsY - 2);
        ctx.textAlign = 'start';
      }
    }
  }

  // Tooltip for selected slot mutation — shows name + what it does
  const selectedMutation = player.mutations[selectedSlot];
  if (selectedMutation) {
    const ability = player.abilities[selectedSlot];
    const abilityName = ability?.name || 'Unknown';
    const desc = getAbilityDescription(selectedMutation);
    const fused = selectedMutation.fused;
    const rarity = RARITY_NAMES[selectedMutation.rarity];

    // Background panel
    const panelW = 280;
    const panelH = fused ? 44 : 40;
    const panelX = canvasW / 2 - panelW / 2;
    const panelY = slotsY - panelH - 8;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(panelX, panelY, panelW, panelH);
    ctx.strokeStyle = fused ? '#ffcc00' : ELEMENT_COLORS[selectedMutation.element];
    ctx.lineWidth = 1;
    ctx.strokeRect(panelX, panelY, panelW, panelH);

    // Line 1: ability name + rarity (two colors)
    ctx.font = 'bold 10px monospace';
    const prefix = fused ? '★ ' : '';
    const namePart = `[${selectedSlot + 1}] ${prefix}${abilityName} `;
    const rarityPart = `[${rarity}]`;
    const fullW = ctx.measureText(namePart + rarityPart).width;
    const startX = canvasW / 2 - fullW / 2;
    ctx.textAlign = 'start';
    ctx.fillStyle = fused ? '#ffcc00' : ELEMENT_COLORS[selectedMutation.element];
    ctx.fillText(namePart, startX, panelY + 12);
    ctx.fillStyle = RARITY_COLORS[selectedMutation.rarity];
    ctx.fillText(rarityPart, startX + ctx.measureText(namePart).width, panelY + 12);

    // Line 2: what it does
    ctx.fillStyle = '#bbbbcc';
    ctx.font = '9px monospace';
    ctx.fillText(desc, canvasW / 2, panelY + 24);

    // Line 3: passive perk
    const passiveText = PASSIVE_PERKS[selectedMutation.element] || '';
    ctx.fillStyle = '#88aacc';
    ctx.font = '8px monospace';
    ctx.fillText(passiveText, canvasW / 2, panelY + 35);

    ctx.textAlign = 'start';
  }

  // Nearby mineral tooltip
  if (nearbyMineral) {
    renderMineralTooltip(ctx, nearbyMineral, canvasW, slotsY, player);
  }

  // Core mutations indicator
  if (player.coreMutations.size > 0) {
    renderCoreMutations(ctx, hpX, canvasH - SLOT_SIZE - HUD_PADDING - 20, player);
  }
}

function renderMineralTooltip(ctx: CanvasRenderingContext2D, mineral: Mineral, canvasW: number, slotsY: number, player: Player): void {
  const d = mineral.data;
  const name = `${MODIFIER_NAMES[d.modifier]} ${ELEMENT_NAMES[d.element]}`;
  const rarity = RARITY_NAMES[d.rarity];
  const color = ELEMENT_COLORS[d.element];
  const desc = getAbilityDescription(d);

  // Compute synergy diff
  const hasEmptySlot = player.mutations.some(m => m === null);
  let gained: { name: string; color: string }[] = [];
  let lost: { name: string }[] = [];
  if (hasEmptySlot) {
    const simMutations = [...player.mutations];
    const emptyIdx = simMutations.indexOf(null);
    simMutations[emptyIdx] = d;
    const currentNames = new Set(player.synergies.synergies.map(s => s.name));
    const simResult = evaluateSynergies(simMutations, player.discoveredEvolutions);
    const newNames = new Set(simResult.synergies.map(s => s.name));
    gained = simResult.synergies.filter(s => !currentNames.has(s.name)).map(s => ({ name: s.name, color: s.color }));
    lost = player.synergies.synergies.filter(s => !newNames.has(s.name));
  }

  const diffLines = gained.length + lost.length;
  const panelW = 260;
  const panelH = 30 + diffLines * 10;
  const panelX = canvasW / 2 - panelW / 2;
  const panelY = slotsY - 60 - panelH;

  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = color + '88';
  ctx.lineWidth = 1;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  ctx.font = 'bold 10px monospace';
  const nameText = `NEARBY: ${name} `;
  const rarityText = `[${rarity}]`;
  const fullW = ctx.measureText(nameText + rarityText).width;
  const startX = canvasW / 2 - fullW / 2;
  ctx.textAlign = 'start';
  ctx.fillStyle = color;
  ctx.fillText(nameText, startX, panelY + 12);
  ctx.fillStyle = RARITY_COLORS[d.rarity];
  ctx.fillText(rarityText, startX + ctx.measureText(nameText).width, panelY + 12);
  ctx.fillStyle = '#99aaaa';
  ctx.font = '8px monospace';
  ctx.fillText(`Gives: ${desc}`, canvasW / 2, panelY + 24);

  // Synergy diff
  let lineY = panelY + 34;
  for (const s of gained) {
    ctx.fillStyle = '#44ff44';
    ctx.font = '8px monospace';
    ctx.fillText(`+ ${s.name}`, panelX + 6, lineY);
    lineY += 10;
  }
  for (const s of lost) {
    ctx.fillStyle = '#ff4444';
    ctx.font = '8px monospace';
    ctx.fillText(`- ${s.name}`, panelX + 6, lineY);
    lineY += 10;
  }
  ctx.textAlign = 'start';
}

function renderSynergies(ctx: CanvasRenderingContext2D, canvasW: number, player: Player): void {
  const synergies = player.synergies.synergies;
  if (synergies.length === 0) return;

  const x = canvasW - HUD_PADDING;
  let y = 36;

  // Background panel
  const panelH = synergies.length * 24 + 18;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(x - 150, y - 12, 154, panelH);

  ctx.fillStyle = '#777';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'end';
  ctx.fillText('SYNERGIES', x - 2, y);
  y += 6;

  for (const syn of synergies) {
    y += 13;
    if (syn.isEvolution) {
      ctx.fillStyle = '#ffcc00';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'end';
      ctx.fillText(`★ ${syn.name}`, x - 2, y);
    } else {
      ctx.fillStyle = syn.color;
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'end';
      ctx.fillText(`${syn.name}`, x - 2, y);
    }
    y += 11;
    ctx.fillStyle = syn.isEvolution ? '#bb9944' : '#999';
    ctx.font = '8px monospace';
    ctx.fillText(syn.description, x - 2, y);
  }

  ctx.textAlign = 'start';
}

const CORE_DESCS: Record<number, string> = {
  0: '+20 HP',
  1: '+15% spd',
  2: '+20% dmg',
  3: '-15% CD',
  4: '+10% steal',
  5: 'Overload spd',
};

function renderCoreMutations(ctx: CanvasRenderingContext2D, x: number, y: number, player: Player): void {
  ctx.fillStyle = '#555';
  ctx.font = '8px monospace';
  ctx.textAlign = 'start';
  ctx.fillText('CORE PASSIVES:', x, y);

  let offsetY = y + 12;
  for (const elem of player.coreMutations) {
    // Colored dot
    ctx.fillStyle = ELEMENT_COLORS[elem];
    ctx.beginPath();
    ctx.arc(x + 4, offsetY - 3, 3, 0, Math.PI * 2);
    ctx.fill();
    // Element name + bonus
    ctx.fillStyle = ELEMENT_COLORS[elem];
    ctx.font = 'bold 7px monospace';
    ctx.fillText(`${ELEMENT_NAMES[elem]}`, x + 10, offsetY);
    ctx.fillStyle = '#999';
    ctx.font = '7px monospace';
    ctx.fillText(CORE_DESCS[elem] || '', x + 52, offsetY);
    offsetY += 11;
  }
}

function renderBossHpBar(ctx: CanvasRenderingContext2D, canvasW: number, boss: Enemy): void {
  const barW = 200;
  const barH = 12;
  const barX = canvasW / 2 - barW / 2;
  const barY = 44;

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(barX - 4, barY - 14, barW + 8, barH + 18);

  // Label
  ctx.fillStyle = boss.baseColor + 'cc';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(boss.bossName, canvasW / 2, barY - 3);

  // Bar bg
  ctx.fillStyle = '#330011';
  ctx.fillRect(barX, barY, barW, barH);

  // Bar fill
  const hpFrac = Math.max(0, boss.hp / boss.maxHp);
  ctx.fillStyle = '#ff4488';
  ctx.fillRect(barX, barY, barW * hpFrac, barH);

  // Border
  ctx.strokeStyle = '#ff88aa';
  ctx.lineWidth = 1;
  ctx.strokeRect(barX, barY, barW, barH);

  // HP text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 8px monospace';
  ctx.fillText(`${boss.hp}/${boss.maxHp}`, canvasW / 2, barY + barH - 2);
  ctx.textAlign = 'start';
}

function renderEnemyLegend(ctx: CanvasRenderingContext2D, x: number, y: number, visibleEnemies: Enemy[]): void {
  const typeCounts = new Map<string, number>();
  let eliteCount = 0;
  for (const e of visibleEnemies) {
    typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
    if (e.isElite && !e.isBoss) eliteCount++;
  }

  if (typeCounts.size === 0) return;

  const rows = typeCounts.size + (eliteCount > 0 ? 1 : 0);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(x, y, 160, rows * 14 + 4);

  let row = 0;
  const typeInfo: Record<string, { color: string; desc: string }> = {
    crawler: { color: '#cc4444', desc: 'melee, slow, tough' },
    spitter: { color: '#cc8844', desc: 'ranged, fragile' },
    feeder: { color: '#44cc44', desc: 'fast, steals minerals' },
    boss: { color: '#ff4488', desc: 'GUARDIAN' },
  };

  for (const [type, count] of typeCounts) {
    const info = typeInfo[type];
    if (!info) continue;
    const ry = y + 12 + row * 14;

    const iconX = x + 8;
    ctx.fillStyle = info.color;
    ctx.beginPath();
    if (type === 'crawler') {
      ctx.rect(iconX - 4, ry - 7, 8, 8);
    } else if (type === 'spitter') {
      ctx.moveTo(iconX, ry - 8);
      ctx.lineTo(iconX + 4, ry);
      ctx.lineTo(iconX - 4, ry);
      ctx.closePath();
    } else {
      ctx.moveTo(iconX, ry - 7);
      ctx.lineTo(iconX + 4, ry - 3);
      ctx.lineTo(iconX, ry + 1);
      ctx.lineTo(iconX - 4, ry - 3);
      ctx.closePath();
    }
    ctx.fill();

    ctx.fillStyle = '#999';
    ctx.font = '8px monospace';
    ctx.textAlign = 'start';
    ctx.fillText(`×${count} ${info.desc}`, x + 16, ry);

    row++;
  }

  // Elite row
  if (eliteCount > 0) {
    const ry = y + 12 + row * 14;
    ctx.fillStyle = '#ffcc44';
    ctx.beginPath();
    ctx.arc(x + 8, ry - 3, 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffcc44';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffcc44';
    ctx.font = '8px monospace';
    ctx.fillText(`×${eliteCount} ELITE (stronger)`, x + 16, ry);
  }
}
