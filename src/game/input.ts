const keys = new Set<string>();
const justPressed = new Set<string>();

const GAME_KEYS = new Set([
  'Tab', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'KeyE', 'KeyF', 'KeyQ', 'KeyR',
]);

export function initInput(): void {
  window.addEventListener('keydown', (e) => {
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (!keys.has(e.code)) {
      justPressed.add(e.code);
    }
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
  });
  window.addEventListener('blur', () => {
    keys.clear();
    justPressed.clear();
  });
}

export function isKeyDown(code: string): boolean {
  return keys.has(code);
}

/** Returns true only once per key press (resets after consumption). */
export function wasKeyPressed(code: string): boolean {
  if (justPressed.has(code)) {
    justPressed.delete(code);
    return true;
  }
  return false;
}
