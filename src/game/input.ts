const keys = new Set<string>();
const justPressed = new Set<string>();

export function initInput(): void {
  window.addEventListener('keydown', (e) => {
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
