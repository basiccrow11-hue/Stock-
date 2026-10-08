/**
 * One-shot requests to move keyboard focus once a page has rendered. Pages load lazily, so the
 * request waits for them; one older than a minute is stale (the user went elsewhere meanwhile).
 */
const requests = new Map<string, number>();

export function requestFocus(key: string): void {
  requests.set(key, Date.now());
}

/** True once per fresh request. */
export function takeFocusRequest(key: string): boolean {
  const at = requests.get(key);
  requests.delete(key);
  return at !== undefined && Date.now() - at < 60_000;
}
