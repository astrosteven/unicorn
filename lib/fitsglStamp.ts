// Live stamp cutouts sourced from the fitsgl fpack pyramids instead of the Worker /stamp path.
// The fitsgl tiles are PUBLIC static fpack/RICE FITS on the CDN (no Digest auth, no 3 GB byte-range
// into the native mosaic), and @fitsgl/core exposes a CPU decode: TilePyramid.getTile → Float32Array.
// So for a fitsgl-enabled field we read the base-level (z0) cutout directly in the browser, exactly
// the pixels the map already shows. Faithful to native to ~2.5% of the noise (verified separately).
//
// The fitsgl pyramid stores SCI only — no ERR — so the grayscale contrast is anchored on the cutout's
// own robust MAD. Empirically MAD ≈ 0.42× the native median ERR (correlated drizzle noise), so we
// scale the MAD up to an ERR-equivalent noise and the existing StampCell stretch/slider look identical.
//
// StampResult-compatible so LiveStampMontage renders it unchanged; ANY failure (missing tiles for a
// field/band, decode error, empty) throws/returns partial so the caller can fall back to the Worker.
import type { StampResult, StampBand } from "./photometry";
import { FITSGL_BASE } from "@/app/data/_card/FitsglCutout";

// Empirical cutout MAD ≈ 0.42× the formal per-pixel ERR (drizzle-correlated noise), so ×2.38 makes
// the fitsgl noise scale match the Worker's ERR-based one — same default stretch, same look.
const FITSGL_NOISE_CAL = 1 / 0.42;

// Whether this field has fitsgl tiles at all (manifest may still 404 per-band → caller falls back).
export function fitsglStampAvailable(field: string): boolean {
  return !!FITSGL_BASE[field];
}

// Per-band caches (manifest + pyramid) so re-opening an object or moving the montage is instant.
const maniCache = new Map<string, Promise<unknown>>();
const pyrCache = new Map<string, Promise<unknown>>();
function once<T>(m: Map<string, Promise<unknown>>, key: string, make: () => Promise<T>): Promise<T> {
  let p = m.get(key) as Promise<T> | undefined;
  if (!p) { p = make(); m.set(key, p); }
  return p;
}

function madNoise(cut: Float32Array): number {
  const finite: number[] = [];
  for (let i = 0; i < cut.length; i++) { const v = cut[i]; if (Number.isFinite(v)) finite.push(v); }
  if (!finite.length) return 0;
  finite.sort((a, b) => a - b);
  const med = finite[finite.length >> 1];
  const dev = finite.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = 1.4826 * dev[dev.length >> 1];
  return mad * FITSGL_NOISE_CAL;
}

export async function fetchFitsglStamp(
  field: string,
  ra: number,
  dec: number,
  bands: string[],
  half = 25,
  onProgress?: (loaded: number, total: number) => void,
): Promise<StampResult> {
  const base = FITSGL_BASE[field];
  if (!base) throw new Error(`no fitsgl tiles for ${field}`);
  // Dynamic import: the decode path is pure JS (no WebGL/window) but keep it out of SSR + the
  // initial bundle — only load @fitsgl/core when a stamp is actually requested.
  const core = await import("@fitsgl/core");
  const { loadManifest, TilePyramid, parseWcs, skyToPix } = core as typeof import("@fitsgl/core");

  const size = 2 * half + 1;
  const out: StampBand[] = [];
  const errors: { band: string; error: string }[] = [];
  let done = 0;

  await Promise.all(
    bands.map(async (band) => {
      const url = `${base}/${band}/manifest.json`;
      try {
        const mani = await once(maniCache, url, () => loadManifest(url));
        const pyr = await once(pyrCache, url, () => TilePyramid.load(url, { useWorker: false }));
        const lvl = mani.levels[0];
        const ts = mani.fpack_tile_size;
        const [gridTy, gridTx] = lvl.fpack_tile_count; // [n_y, n_x]
        const wcs = parseWcs(lvl.wcs);
        if (!wcs) throw new Error("unparseable z0 WCS");
        const p = skyToPix(wcs, ra, dec);
        const gx = Math.round(p.x), gy = Math.round(p.y);

        const cut = new Float32Array(size * size).fill(NaN);
        const x0 = gx - half, y0 = gy - half;
        const txMin = Math.floor(x0 / ts), txMax = Math.floor((gx + half) / ts);
        const tyMin = Math.floor(y0 / ts), tyMax = Math.floor((gy + half) / ts);
        let anyPix = false;
        for (let ty = tyMin; ty <= tyMax; ty++) {
          for (let tx = txMin; tx <= txMax; tx++) {
            if (tx < 0 || ty < 0 || tx >= gridTx || ty >= gridTy) continue;
            if (!pyr.hasTile(0, tx, ty)) continue;
            let tile: Float32Array;
            try { tile = await pyr.getTile(0, tx, ty); } catch { continue; }
            const ox = tx * ts, oy = ty * ts; // this tile's global-pixel origin (fpack tiles are ts×ts)
            for (let j = 0; j < ts; j++) {
              const cyy = oy + j - y0; if (cyy < 0 || cyy >= size) continue;
              for (let i = 0; i < ts; i++) {
                const cxx = ox + i - x0; if (cxx < 0 || cxx >= size) continue;
                const v = tile[j * ts + i];
                cut[cyy * size + cxx] = Number.isFinite(v) ? v : NaN;
                if (Number.isFinite(v)) anyPix = true;
              }
            }
          }
        }
        if (!anyPix) { errors.push({ band, error: "off-tile / all-NaN" }); }
        else out.push({ band, w: size, h: size, noise: madNoise(cut), pixels: cut });
      } catch (e) {
        errors.push({ band, error: e instanceof Error ? e.message : String(e) });
      } finally {
        done++; if (onProgress) onProgress(done, bands.length);
      }
    }),
  );

  out.sort((a, b) => bands.indexOf(a.band) - bands.indexOf(b.band));
  return { size, bands: out, errors };
}
