/**
 * Chrome steps a focused number box on every wheel or trackpad scroll over it when nothing around
 * it can scroll, so a scroll meant for the page could quietly change an order's price or size (and
 * clicking away then saves it). Here a vertical scroll over a focused number box never changes it:
 * the nearest container that can scroll that way scrolls instead, as over any other control.
 */
export function installNumberWheelGuard(): void {
  // Not passive, or preventDefault would be ignored; capture, so it runs before anything else.
  document.addEventListener('wheel', onWheel, { passive: false, capture: true });
}

export function onWheel(e: WheelEvent): void {
  const el = e.target;
  // Ctrl + wheel is a zoom (and a trackpad pinch); the browser keeps it.
  if (!(el instanceof HTMLInputElement) || el.type !== 'number' || el !== document.activeElement || e.deltaY === 0 || e.ctrlKey) return;
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && (dy < 0 ? p.scrollTop > 0 : p.scrollTop + p.clientHeight < p.scrollHeight - 1)) {
      p.scrollTop += dy;
      return;
    }
  }
  const root = document.scrollingElement;
  if (root) root.scrollTop += dy;
}
