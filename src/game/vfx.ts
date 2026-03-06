import type { Camera } from './camera';

interface VfxEntry {
  type: 'ring' | 'flash' | 'trail' | 'sweep';
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  color: string;
  life: number;
  maxLife: number;
  angle?: number;       // sweep: center angle in radians
  sweepArc?: number;    // sweep: arc width in radians
}

const effects: VfxEntry[] = [];

export function addRing(x: number, y: number, radius: number, color: string, duration: number = 0.4): void {
  effects.push({ type: 'ring', x, y, radius: 0, maxRadius: radius, color, life: duration, maxLife: duration });
}

export function addFlash(x: number, y: number, radius: number, color: string, duration: number = 0.15): void {
  effects.push({ type: 'flash', x, y, radius, maxRadius: radius, color, life: duration, maxLife: duration });
}

export function addTrail(x: number, y: number, color: string, duration: number = 0.3): void {
  effects.push({ type: 'trail', x, y, radius: 3, maxRadius: 3, color, life: duration, maxLife: duration });
}

/** Sweep arc VFX for tendril attack — a fan-shaped slash */
export function addSweep(x: number, y: number, radius: number, angle: number, arc: number, color: string, duration: number = 0.2): void {
  effects.push({ type: 'sweep', x, y, radius, maxRadius: radius, color, life: duration, maxLife: duration, angle, sweepArc: arc });
}

export function updateVfx(dt: number): void {
  for (let i = effects.length - 1; i >= 0; i--) {
    effects[i].life -= dt;
    if (effects[i].life <= 0) {
      effects.splice(i, 1);
    }
  }
}

export function renderVfx(ctx: CanvasRenderingContext2D, camera: Camera): void {
  for (const e of effects) {
    const sx = e.x - camera.x;
    const sy = e.y - camera.y;
    const t = 1 - e.life / e.maxLife; // 0→1 progress

    ctx.save();

    if (e.type === 'ring') {
      const currentRadius = e.maxRadius * t;
      const alpha = 1 - t;
      ctx.beginPath();
      ctx.arc(sx, sy, currentRadius, 0, Math.PI * 2);
      ctx.strokeStyle = e.color;
      ctx.globalAlpha = alpha * 0.8;
      ctx.lineWidth = 2 + (1 - t) * 2;
      ctx.stroke();
    } else if (e.type === 'flash') {
      const alpha = e.life / e.maxLife;
      ctx.beginPath();
      ctx.arc(sx, sy, e.radius * (1 + t * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = e.color;
      ctx.globalAlpha = alpha * 0.5;
      ctx.fill();
    } else if (e.type === 'trail') {
      const alpha = e.life / e.maxLife;
      ctx.beginPath();
      ctx.arc(sx, sy, e.radius * alpha, 0, Math.PI * 2);
      ctx.fillStyle = e.color;
      ctx.globalAlpha = alpha * 0.6;
      ctx.fill();
    } else if (e.type === 'sweep') {
      const alpha = e.life / e.maxLife;
      const expand = 1 + (1 - alpha) * 0.3;   // grows slightly as it fades
      const r = e.maxRadius * expand;
      const a = e.angle ?? 0;
      const arc = e.sweepArc ?? Math.PI * 0.8;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, r, a - arc / 2, a + arc / 2);
      ctx.closePath();
      ctx.fillStyle = e.color;
      ctx.globalAlpha = alpha * 0.45;
      ctx.fill();
      // Edge highlight
      ctx.beginPath();
      ctx.arc(sx, sy, r, a - arc / 2, a + arc / 2);
      ctx.strokeStyle = e.color;
      ctx.globalAlpha = alpha * 0.8;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.restore();
  }
}
