// fitsglSource — where a field's fitsgl tile pyramid is read from: Cloudflare R2 (via the
// `unicorn-r2` Worker, fast) first, Corral (TACC, slow/flaky) as the fallback.
//
// The choice is made ONCE per field per session, by loading that field's `fitsgl.json`:
// loadFitsglConfig URL-resolves every band/tile path against the config URL, so whichever
// base served the config also serves all of its tiles. scripts/publish_to_r2.sh uploads a
// field's fitsgl.json only AFTER all of its tiles, so a field whose config is on R2 is complete.
// Bases that aren't under the Corral root (e.g. a ?data= local mirror) are used as-is.
//
// Disable R2 for cutouts/maps (everything back on Corral) by blanking FITSGL_R2_ROOT.
import type { FitsglConfig } from "@fitsgl/core";

export const FITSGL_CORRAL_ROOT = "https://web.corral.tacc.utexas.edu/unicorn/fitsgl";
export const FITSGL_R2_ROOT = "https://unicorn-r2.unicorn-astro.workers.dev/fitsgl";

// An R2 attempt that stalls (rather than erroring) must not block the Corral fallback.
const R2_TIMEOUT_MS = 8000;

export type LoadedFitsgl = { config: FitsglConfig; base: string };
const _loaded = new Map<string, Promise<LoadedFitsgl>>();

function candidates(base: string): string[] {
  const b = base.replace(/\/$/, "");
  if (FITSGL_R2_ROOT && b.startsWith(FITSGL_CORRAL_ROOT + "/")) {
    return [FITSGL_R2_ROOT + b.slice(FITSGL_CORRAL_ROOT.length), b];
  }
  return [b];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Load a field's fitsgl.json from R2, else Corral. `base` = the Corral (or ?data=) field base,
 *  e.g. ".../unicorn/fitsgl/egs". Resolves to the config + the base it actually came from. */
export function loadFitsglWithFallback(base: string): Promise<LoadedFitsgl> {
  const key = base.replace(/\/$/, "");
  const hit = _loaded.get(key);
  if (hit) return hit;
  const p = (async () => {
    const { loadFitsglConfig } = await import("@fitsgl/core");
    const cands = candidates(key);
    let lastErr: unknown;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const isLast = i === cands.length - 1;
      try {
        const load = loadFitsglConfig(`${c}/fitsgl.json`);
        const config = isLast ? await load : await withTimeout(load, R2_TIMEOUT_MS);
        return { config, base: c };
      } catch (e) {
        lastErr = e;
        if (!isLast) console.warn(`[fitsgl] ${c} unavailable, falling back to Corral:`, e);
      }
    }
    throw lastErr;
  })();
  _loaded.set(key, p);
  p.catch(() => _loaded.delete(key));   // never cache a failure — allow a retry
  return p;
}

/** The base (R2 or Corral) a field's tiles should be read from. */
export async function resolveFitsglBase(base: string): Promise<string> {
  return (await loadFitsglWithFallback(base)).base;
}
