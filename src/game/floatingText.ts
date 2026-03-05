import type { Camera } from './camera';

interface FloatingTextEntry {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

const entries: FloatingTextEntry[] = [];

export function addFloatingText(x: number, y: number, text: string, color: string = '#fff', duration: number = 0.8): void {
  entries.push({ x, y, text, color, life: duration, maxLife: duration });
}

export function updateFloatingText(dt: number): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    entries[i].life -= dt;
    entries[i].y -= dt * 30; // Float upward
    if (entries[i].life <= 0) {
      entries.splice(i, 1);
    }
  }
}

export function renderFloatingText(ctx: CanvasRenderingContext2D, camera: Camera): void {
  for (const entry of entries) {
    const sx = entry.x - camera.x;
    const sy = entry.y - camera.y;
    const alpha = Math.min(1, entry.life / (entry.maxLife * 0.3));

    ctx.globalAlpha = alpha;
    ctx.fillStyle = entry.color;
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(entry.text, sx, sy);
    ctx.textAlign = 'start';
    ctx.globalAlpha = 1;
  }
}
