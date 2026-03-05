import { TILE_SIZE } from './constants';

export class Camera {
  x = 0;
  y = 0;

  // Screen shake
  private shakeIntensity = 0;
  private shakeDuration = 0;
  private shakeTimer = 0;
  shakeOffsetX = 0;
  shakeOffsetY = 0;

  follow(
    targetX: number,
    targetY: number,
    canvasW: number,
    canvasH: number,
    mapW: number,
    mapH: number,
  ): void {
    const worldW = mapW * TILE_SIZE;
    const worldH = mapH * TILE_SIZE;

    this.x = targetX - canvasW / 2;
    this.y = targetY - canvasH / 2;

    // Clamp to map edges
    if (this.x < 0) this.x = 0;
    if (this.y < 0) this.y = 0;
    if (this.x > worldW - canvasW) this.x = worldW - canvasW;
    if (this.y > worldH - canvasH) this.y = worldH - canvasH;

    // Apply shake offset
    this.x += this.shakeOffsetX;
    this.y += this.shakeOffsetY;
  }

  shake(intensity: number, duration: number): void {
    // Only override if new shake is stronger
    if (intensity >= this.shakeIntensity) {
      this.shakeIntensity = intensity;
      this.shakeDuration = duration;
      this.shakeTimer = duration;
    }
  }

  updateShake(dt: number): void {
    if (this.shakeTimer > 0) {
      this.shakeTimer -= dt;
      const t = this.shakeTimer / this.shakeDuration;
      const mag = this.shakeIntensity * t; // Decays over time
      this.shakeOffsetX = (Math.random() * 2 - 1) * mag;
      this.shakeOffsetY = (Math.random() * 2 - 1) * mag;

      if (this.shakeTimer <= 0) {
        this.shakeOffsetX = 0;
        this.shakeOffsetY = 0;
        this.shakeIntensity = 0;
      }
    }
  }
}
