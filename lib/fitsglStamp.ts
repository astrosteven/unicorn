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
import { fetchStamp, type StampResult, type StampBand } from "./photometry";
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

// Bilinear sample of a row-major buffer at fractional (x,y); NaN if out of bounds or any corner is
// NaN (falls back to nearest inside the buffer). Used to resample a raw mosaic window to north-up.
function bilinear(buf: Float32Array, w: number, h: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return NaN;
    const v = buf[yi * w + xi]; return Number.isFinite(v) ? v : NaN;
  }
  const fx = x - x0, fy = y - y0;
  const v00 = buf[y0 * w + x0], v10 = buf[y0 * w + x0 + 1], v01 = buf[(y0 + 1) * w + x0], v11 = buf[(y0 + 1) * w + x0 + 1];
  if (!(Number.isFinite(v00) && Number.isFinite(v10) && Number.isFinite(v01) && Number.isFinite(v11))) {
    const xi = Math.round(x), yi = Math.round(y); const v = buf[yi * w + xi]; return Number.isFinite(v) ? v : NaN;
  }
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
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

        // 1) Assemble a RAW window (mosaic-oriented) oversized ~1.6× so it covers the north-up
        //    footprint after de-rotation (mosaics can be rotated — EGS ~40°).
        const rawHalf = Math.ceil(half * 1.6) + 1;
        const rw = 2 * rawHalf + 1;
        const raw = new Float32Array(rw * rw).fill(NaN);
        const rx0 = gx - rawHalf, ry0 = gy - rawHalf;
        for (let ty = Math.floor(ry0 / ts); ty <= Math.floor((gy + rawHalf) / ts); ty++) {
          for (let tx = Math.floor(rx0 / ts); tx <= Math.floor((gx + rawHalf) / ts); tx++) {
            if (tx < 0 || ty < 0 || tx >= gridTx || ty >= gridTy) continue;
            if (!pyr.hasTile(0, tx, ty)) continue;
            let tile: Float32Array;
            try { tile = await pyr.getTile(0, tx, ty); } catch { continue; }
            const ox = tx * ts, oy = ty * ts; // this tile's global-pixel origin (fpack tiles are ts×ts)
            for (let j = 0; j < ts; j++) {
              const ry = oy + j - ry0; if (ry < 0 || ry >= rw) continue;
              for (let i = 0; i < ts; i++) {
                const rx = ox + i - rx0; if (rx < 0 || rx >= rw) continue;
                raw[ry * rw + rx] = tile[j * ts + i];
              }
            }
          }
        }
        // 2) Resample to a NORTH-UP, EAST-LEFT cutout via the WCS so the grayscale stamps share the
        //    exact orientation of the fitsgl colour image. output pixel → sky → mosaic pixel → sample.
        const cut = new Float32Array(size * size).fill(NaN);
        const psArcsec = lvl.pixel_scale_arcsec || 0.03;
        const cosd = Math.cos((dec * Math.PI) / 180) || 1e-6;
        let anyPix = false;
        for (let oj = 0; oj < size; oj++) {
          const north = (half - oj) * psArcsec;   // arcsec; top row = north (dec increases up)
          for (let oi = 0; oi < size; oi++) {
            const east = (half - oi) * psArcsec;   // arcsec; left column = east (RA increases left)
            const pp = skyToPix(wcs, ra + east / (3600 * cosd), dec + north / 3600);
            const v = bilinear(raw, rw, rw, pp.x - rx0, pp.y - ry0);
            cut[oj * size + oi] = v;
            if (Number.isFinite(v)) anyPix = true;
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

// Warm the stamp cache for one source so a later open renders instantly. Mirrors LiveStampMontage's
// load order (fitsgl tiles → Worker /stamp) and populates the same module caches, then discards the
// result. Never throws. Used to prefetch query-result stamps in the background.
export async function precacheStamp(field: string, ra: number, dec: number, bands: string[]): Promise<void> {
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || !bands.length) return;
  if (fitsglStampAvailable(field)) {
    try {
      const s = await fetchFitsglStamp(field, ra, dec, bands, 25);
      if (s.bands.length) return;
    } catch { /* fall through to the Worker path */ }
  }
  try { await fetchStamp(field, ra, dec, undefined, bands); } catch { /* best-effort */ }
}
