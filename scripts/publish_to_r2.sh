#!/usr/bin/env bash
# publish_to_r2.sh — mirror the UNICORN per-object CARD files (and optionally the fitsgl cutout
# tiles) to Cloudflare R2, so the website serves them from R2's CDN instead of slow Corral/TACC.
# The destination keys mirror the Corral URL layout EXACTLY, so the site only needs R2_BASE set
# (app/data/_card/objectCard.tsx) — no path logic changes. Re-run any time to re-sync after a
# catalog/webprep update (rclone uploads only changed files).
#
# ── One-time setup ─────────────────────────────────────────────────────────
#   1. Install rclone (brew install rclone).
#   2. Create an R2 bucket + an S3 API token in the Cloudflare dashboard (R2 → Manage API Tokens),
#      and give the bucket a public custom domain (or enable the r2.dev URL).
#   3. Configure the rclone remote (secrets live in ~/.config/rclone/rclone.conf, NEVER in chat/repo):
#        rclone config create r2 s3 provider=Cloudflare \
#          access_key_id=<ACCESS_KEY_ID> secret_access_key=<SECRET_ACCESS_KEY> \
#          endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com acl=private
#   4. Set R2_BASE in objectCard.tsx to  https://<your-public-domain>/Catalogs  and deploy.
#
# ── Usage ──────────────────────────────────────────────────────────────────
#   ./publish_to_r2.sh cards                  # Scope A: every field's web/cards  (~30 GB)
#   ./publish_to_r2.sh cards CEERS GOODS-S    # just these fields
#   ./publish_to_r2.sh fitsgl                 # Scope B add-on: fitsgl tiles      (~133 GB)
#   ./publish_to_r2.sh all                    # cards + fitsgl, all fields
#   DRYRUN=1 ./publish_to_r2.sh cards         # show what WOULD transfer; upload nothing
#
# ── Per-machine config (override via env) ──────────────────────────────────
#   R2_REMOTE   rclone remote name                (default: r2)
#   R2_BUCKET   R2 bucket name                    (default: unicorn-web)
#   SRC_ROOTS   space-sep roots holding each field's <…>/Results/web/cards
#               (default: Adonalsium's catalog roots — EDIT to match this machine)
#   FITSGL_ROOT fitsgl tile tree: <FITSGL_ROOT>/<prefix>/…
set -euo pipefail

R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-unicorn-web}"
SRC_ROOTS="${SRC_ROOTS:-$HOME/Research/UNICORN /Volumes/Braize/UNICORN /Volumes/Nalthis/UNICORN /Volumes/Threnody/UNICORN}"
FITSGL_ROOT="${FITSGL_ROOT:-$HOME/Research/UNICORN/WebFiles/fitsgl_rebuild}"

# prefix → Corral catalog dir (fieldCatDir) and canonical field name (from SEARCH_FIELDS).
# (case lookups, not associative arrays, so this also runs on macOS's stock bash 3.2.)
ALL_PREFIXES="ceers goodss goodsn a2744 ngdeep egs primercosmos primeruds cosmos"
pfx_to_dir() { case "$1" in
  ceers) echo CEERS;; goodss) echo GOODSS;; goodsn) echo GOODSN;; a2744) echo A2744;;
  ngdeep) echo NGDEEP;; egs) echo EGS;; primercosmos) echo PRIMER-COSMOS;;
  primeruds) echo PRIMER-UDS;; cosmos) echo COSMOS;; *) echo "";; esac; }
pfx_to_field() { case "$1" in
  ceers) echo CEERS;; goodss) echo GOODS-S;; goodsn) echo GOODS-N;; a2744) echo A2744;;
  ngdeep) echo NGDEEP;; egs) echo EGS;; primercosmos) echo PRIMER-COSMOS;;
  primeruds) echo PRIMER-UDS;; cosmos) echo COSMOS;; *) echo "";; esac; }

RCLONE=(rclone --transfers 16 --checkers 32 --fast-list --s3-chunk-size 64M
        --s3-upload-concurrency 8 --stats 10s --stats-one-line --progress)
[ "${DRYRUN:-0}" = "1" ] && RCLONE+=(--dry-run)

want_field() {   # $1=field ; no filter args ⇒ all
  [ ${#WANT[@]} -eq 0 ] && return 0
  for f in "${WANT[@]}"; do [ "$f" = "$1" ] && return 0; [ "$f" = "all" ] && return 0; done
  return 1
}

sync_cards() {
  echo "── Scope A: web/cards → r2://${R2_BUCKET}/Catalogs/Legacy/<FIELD>/web/cards ──"
  local found=0
  for root in $SRC_ROOTS; do
    [ -d "$root" ] || continue
    while IFS= read -r cdir; do
      # derive the field prefix from a packed-card filename in this dir (glob, not find|head —
      # a pipe here races SIGPIPE against `pipefail` and silently kills the loop)
      local bin="" cand
      for cand in "$cdir"/*_cards.manifest.json "$cdir"/*_cards_*.bin; do
        [ -e "$cand" ] && { bin="$cand"; break; }
      done
      [ -n "$bin" ] || continue
      local pfx; pfx=$(basename "$bin"); pfx=${pfx%%_cards*}
      local d fld; d=$(pfx_to_dir "$pfx"); fld=$(pfx_to_field "$pfx"); [ -n "$fld" ] || fld="$pfx"
      [ -n "$d" ] || { echo "  ?? unknown prefix '$pfx' in $cdir — skipping"; continue; }
      want_field "$fld" || continue
      found=1
      echo "  [$fld]  $cdir"
      "${RCLONE[@]}" sync "$cdir" "${R2_REMOTE}:${R2_BUCKET}/Catalogs/Legacy/${d}/web/cards"
    done < <(find "$root" -type d -path "*/Results/web/cards" 2>/dev/null)
  done
  [ "$found" = 1 ] || { echo "  !! no web/cards dirs found under: $SRC_ROOTS"; echo "     set SRC_ROOTS for this machine."; exit 1; }
}

sync_fitsgl() {
  echo "── Scope B: fitsgl tiles → r2://${R2_BUCKET}/fitsgl/<prefix> ──"
  [ -d "$FITSGL_ROOT" ] || { echo "  !! FITSGL_ROOT not found: $FITSGL_ROOT"; exit 1; }
  for pfx in $ALL_PREFIXES; do
    local src="$FITSGL_ROOT/$pfx"
    [ -d "$src" ] || continue
    local fld; fld=$(pfx_to_field "$pfx")
    want_field "$fld" || continue
    echo "  [$fld]  $src"
    "${RCLONE[@]}" sync "$src" "${R2_REMOTE}:${R2_BUCKET}/fitsgl/${pfx}"
  done
}

MODE="${1:-}"; shift || true
WANT=("$@")
case "$MODE" in
  cards)  sync_cards ;;
  fitsgl) sync_fitsgl ;;
  all)    sync_cards; sync_fitsgl ;;
  *) echo "usage: $0 {cards|fitsgl|all} [FIELD ...]   (e.g. $0 cards CEERS GOODS-S)"; exit 2 ;;
esac
echo "done.${DRYRUN:+  (dry-run — nothing uploaded)}"
