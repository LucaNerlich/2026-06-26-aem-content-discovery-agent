// Mulberry32: deterministic, lightweight PRNG. Plenty good for picking templates,
// brand-guideline combos, and lastModified offsets — no crypto requirements.
export function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(arr, rng) {
  if (arr.length === 0) throw new Error("pick(): array is empty");
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

// Stable, deterministic shuffle. Used to spread categories evenly across a locale.
export function shuffle(arr, rng) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
