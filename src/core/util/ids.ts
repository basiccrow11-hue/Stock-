let counter = 0;

/** Short unique id. Uses crypto when available so ids survive reloads without collisions. */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  const rand =
    typeof crypto !== 'undefined' && 'getRandomValues' in crypto
      ? Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join('')
      : Math.random().toString(36).slice(2);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand.slice(0, 6)}`;
}
