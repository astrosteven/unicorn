// Client for the custom-aperture photometry Cloudflare Worker (unicorn-photometry).
// The map's draw tool converts a drawn circle/polygon → sky coords and calls
// measureAperture(); the Worker range-reads the CEERS SCI/ERR mosaics, sums the aperture
// (5×5 subpixel sampling, ERR in quadrature), and returns calibrated flux per band.
//
// Auth: the site already holds an authenticated Supabase session (lib/supabase). We send
// its access_token as a Bearer token — the Worker verifies it against the project's public
// ES256 JWKS. Anonymous users get a thrown "please sign in" (the tool is login-gated).
import { supabase } from "@/lib/supabase";

export const PHOTOMETRY_WORKER_URL =
  "https://unicorn-photometry.unicorn-astro.workers.dev/photometry";

// Aperture shapes accepted by the Worker. Circle center / polygon vertices are sky coords;
// the circle's center rides on the top-level ra/dec of the request.
export type Aperture =
  | { type: "circle"; radius_arcsec: number }
  | { type: "polygon"; vertices: [number, number][] }; // [[ra,dec],…] degrees

export interface BandFlux {
  band: string;
  flux_nJy: number;
  err_nJy: number;
  npix: number;
}

export interface PhotometryResult {
  field: string;
  ra: number;
  dec: number;
  shape: Aperture;
  user: string;
  results: BandFlux[];
  errors?: { band: string; error: string }[];
  meta?: { units: string; calibration: string; note: string };
}

// Measure an aperture at (ra,dec). `bands` optional — omit for the Worker's default set.
// Throws with a readable message on auth failure / Worker error.
export async function measureAperture(
  field: string,
  ra: number,
  dec: number,
  shape: Aperture,
  bands?: string[],
): Promise<PhotometryResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in to measure photometry.");

  const res = await fetch(PHOTOMETRY_WORKER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ field, ra, dec, shape, bands }),
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({} as { error?: string }))).error;
    throw new Error(msg ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<PhotometryResult>;
}

// AB magnitude from flux in nJy (nJy zero point = 31.4). Handy for the results panel.
export function abMagFromNJy(flux_nJy: number): number | null {
  return flux_nJy > 0 ? 31.4 - 2.5 * Math.log10(flux_nJy) : null;
}

// ---------------------------------------------------------------------------
// Raw grayscale cutouts for the visual inspector's LIVE montage.
//
// Same Worker, same Bearer-token auth as measureAperture(); a separate /stamp route
// returns the RAW SCI pixels of a small square cutout per band, so the client can render
// + re-stretch grayscale stamps instantly (no server-side PNG bake). We keep the raw
// Float32 pixels client-side; the montage component maps them to gray on a <canvas>.
// Only CEERS + NGDEEP are wired in the Worker today; other fields 400 (caller falls back).
export const STAMP_WORKER_URL =
  "https://unicorn-photometry.unicorn-astro.workers.dev/stamp";

// One band's decoded cutout: a row-major w×h Float32 SCI patch (NaN = off-image) plus the
// per-pixel 1σ noise scale (median ERR) used to set a symmetric display range.
export interface StampBand {
  band: string;
  w: number;
  h: number;
  noise: number;
  pixels: Float32Array;
}
export interface StampResult {
  size: number;          // 2*half+1 (each cell is size×size)
  bands: StampBand[];
}

// Module-level cache so re-opening an object (or a precache followed by a real open) is
// instant. Keyed by field:ra:dec:half:bands — same key precache and open both compute.
const stampCache = new Map<string, Promise<StampResult>>();
function stampKey(field: string, ra: number, dec: number, half: number, bands?: string[]): string {
  return `${field}:${ra}:${dec}:${half}:${bands ? bands.join(",") : "*"}`;
}

// Decode base64 of a little-endian Float32Array → Float32Array. atob → bytes → reinterpret
// the byte buffer as float32 (browsers are little-endian, matching the Worker's encoding).
function decodeFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

// Fetch raw cutout pixels at (ra,dec). `half` defaults to 25 (→ 51px cells); omit `bands`
// for the field's default set. Cached by identity so repeat opens are free. Throws a
// readable error on non-OK (auth failure / unsupported field) so the caller can fall back.
export async function fetchStamp(
  field: string,
  ra: number,
  dec: number,
  half?: number,
  bands?: string[],
): Promise<StampResult> {
  const h = half ?? 25;
  const key = stampKey(field, ra, dec, h, bands);
  const cached = stampCache.get(key);
  if (cached) return cached;

  const p = (async (): Promise<StampResult> => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Please sign in to load cutouts.");

    const res = await fetch(STAMP_WORKER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ field, ra, dec, half: h, bands }),
    });
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({} as { error?: string }))).error;
      throw new Error(msg ?? `HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      size: number;
      bands: { band: string; w: number; h: number; noise: number; data: string }[];
    };
    return {
      size: json.size,
      bands: json.bands.map(b => ({
        band: b.band, w: b.w, h: b.h, noise: b.noise, pixels: decodeFloat32(b.data),
      })),
    };
  })();

  // Cache the promise (so concurrent callers share one fetch); drop it on failure so a
  // later attempt can retry rather than re-throwing the cached rejection forever.
  stampCache.set(key, p);
  p.catch(() => stampCache.delete(key));
  return p;
}

// Precache a stamp (populate the module cache) and swallow errors — for warming the next
// few queue rows while the user inspects the current one. Never throws.
export function prefetchStamp(
  field: string,
  ra: number,
  dec: number,
  half?: number,
  bands?: string[],
): void {
  fetchStamp(field, ra, dec, half, bands).catch(() => { /* best-effort warm */ });
}
