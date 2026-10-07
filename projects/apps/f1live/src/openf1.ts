// OpenF1 fetch, throttled, with finished sessions kept in the Cache API.

const API = 'https://api.openf1.org/v1/';
let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Finished sessions don't change, so per-session responses are kept in the Cache API.
// ponytail: no expiry; "Clear saved data" in the help dialog empties it.
const CACHE = 'openf1-v1';
const openCache = (): Promise<Cache | null> =>
  globalThis.caches?.open(CACHE).catch(() => null) ?? Promise.resolve(null);

export async function api<T = any>(path: string): Promise<T[]> {
  const cache = path.includes('session_key=') ? await openCache() : null;
  const hit = await cache?.match(API + path);
  if (hit) return hit.json();
  for (let attempt = 0; ; attempt++) {
    const wait = nextSlot - Date.now();
    // ponytail: fixed spacing keeps us under OpenF1's free-tier burst limit; 429s back off below.
    nextSlot = Math.max(nextSlot, Date.now()) + 400;
    if (wait > 0) await sleep(wait);
    const res = await fetch(API + path);
    if (res.ok) {
      cache?.put(API + path, res.clone()).catch(() => {}); // full storage: just don't cache
      return res.json();
    }
    if (res.status === 404) return []; // OpenF1 answers "no results" with 404
    if (res.status !== 429 || attempt >= 5) throw new Error(`OpenF1 returned ${res.status}`);
    await sleep(2000 * (attempt + 1));
  }
}

export const clearCache = () => globalThis.caches?.delete(CACHE).catch(() => {});

// Circuit rotation (degrees) as used by broadcast maps; FastF1's source. Optional: null on any failure.
export async function circuitRotation(circuitKey: number, year: number): Promise<number | null> {
  try {
    const res = await fetch(`https://api.multiviewer.app/api/v1/circuits/${circuitKey}/${year}`);
    if (!res.ok) return null;
    const { rotation } = await res.json();
    return typeof rotation === 'number' ? rotation : null;
  } catch {
    return null; // blocked or offline: map stays unrotated
  }
}
