#!/bin/bash
# stage_campfire_for_worker.sh -- pull ONLY the main-mosaic SCI+ERR from a campfire NIRCam
# download script, gunzip them, and rename to the photometry Worker's convention, ready to
# upload to Corral (Images/<FIELD>/). Standalone helper (not IDL); reads the credential from
# YOUR existing download script so nothing is hard-coded here.
#
# The Worker byte-range reads UNCOMPRESSED FITS, so campfire's .fits.gz can't be used
# directly (you can't seek into a gzip stream). This stages a decompressed copy.
#
# Usage:
#   scripts/stage_campfire_for_worker.sh \
#       --script ~/Downloads/download_nircam_data.sh \
#       --slug egs --variant ceers --prefix egs_nrc \
#       --out ~/corral_upload/EGS
#
#   --slug     campfire field slug in the filenames (egs, cosmos, ...)
#   --variant  mosaic variant token between "30mas_" and "_sci/_err" (egs uses: ceers)
#   --prefix   output filename prefix (e.g. egs_nrc -> egs_nrc_f277w_sci.fits)
#   --out      output dir (created); upload its contents to Corral Images/<FIELD>/
#
# Resumable: a finished, correctly-sized .fits is skipped; re-run to continue.
# Needs ~110 GB free for a full EGS set (20 bands x sci+err, ~2.8 GB each uncompressed).
set -u

SCRIPT="" SLUG="" VARIANT="ceers" PREFIX="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --script) SCRIPT="$2"; shift 2 ;;
    --slug)   SLUG="$2";   shift 2 ;;
    --variant) VARIANT="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --out)    OUT="$2";    shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -z "$SCRIPT" ] || [ -z "$SLUG" ] || [ -z "$PREFIX" ] || [ -z "$OUT" ] && {
  echo "usage: --script <download.sh> --slug <egs> --variant <ceers> --prefix <egs_nrc> --out <dir>" >&2; exit 2; }
[ -f "$SCRIPT" ] || { echo "no such download script: $SCRIPT" >&2; exit 2; }

BASE_URL=$(grep -m1 "^BASE_URL=" "$SCRIPT" | sed "s/^BASE_URL='//; s/'$//")
TOKEN=$(grep -m1 "^DOWNLOAD_TOKEN=" "$SCRIPT" | sed "s/^DOWNLOAD_TOKEN='//; s/'$//")
API_KEY="${CAMPFIRE_API_KEY:-$TOKEN}"
[ -n "$BASE_URL" ] && [ -n "$API_KEY" ] || { echo "could not read BASE_URL / token from $SCRIPT" >&2; exit 2; }

# Bearer via curl config on stdin, so the token never appears in the process list.
auth_curl() { printf 'header = "Authorization: Bearer %s"\n' "$API_KEY" | curl -K - "$@"; }

mkdir -p "$OUT"
# The main-mosaic SCI/ERR keys: exclude _spam / _NE / _SW / wht / srcmask by matching the
# exact variant token before _sci/_err. (No mapfile — macOS bash 3.2 lacks it.)
KEYFILE=$(mktemp)
grep -oE "data%2F[^']*_${SLUG}_30mas_${VARIANT}_(sci|err)\.fits\.gz" "$SCRIPT" | sort -u > "$KEYFILE"
count=$(wc -l < "$KEYFILE" | tr -d ' ')
[ "$count" -gt 0 ] || { echo "no $SLUG/$VARIANT sci+err mosaics found in $SCRIPT" >&2; rm -f "$KEYFILE"; exit 1; }
echo "staging $count files ($SLUG/$VARIANT) -> $OUT/"

n=0
while IFS= read -r key; do
  n=$((n + 1))
  # Pull band + kind straight from the (url-encoded) key — avoids %2F decoding quirks.
  band=$(echo "$key" | sed -E 's/.*mosaic_nircam_(f[0-9]+[mnw])_.*/\1/')
  kind=$(echo "$key" | grep -oE '(sci|err)\.fits\.gz' | grep -oE '(sci|err)')
  out="$OUT/${PREFIX}_${band}_${kind}.fits"
  echo "[$n/$count] $band $kind -> $(basename "$out")"
  if [ -s "$out" ]; then echo "  exists, skipping"; continue; fi
  gz="$out.gz.part"
  if ! auth_curl -fL --progress-bar -o "$gz" "$BASE_URL/api/v1/storage/download?key=$key"; then
    echo "  download failed (see above); re-run to retry" >&2; rm -f "$gz"; continue
  fi
  echo "  gunzip…"
  if gunzip -c "$gz" > "$out.part" && mv -f "$out.part" "$out"; then
    rm -f "$gz"
  else
    echo "  gunzip failed" >&2; rm -f "$gz" "$out.part"; continue
  fi
done < "$KEYFILE"
rm -f "$KEYFILE"

echo ""
echo "done. Upload the contents of $OUT/ to Corral at Images/<FIELD>/ (uncompressed .fits)."
echo "Then tell me and I'll add the field to the Worker config + enable it on the map."
