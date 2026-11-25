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
#   SOURCE=corral ./publish_to_r2.sh cards    # copy from Corral's public HTTPS tree instead of
#                                             # local disk (= exactly what the site serves now;
#                                             # works for every field, slower: pulls from TACC)
#
# ── Per-machine config (override via env) ──────────────────────────────────
#   R2_REMOTE   rclone remote name                (default: r2)
#   R2_BUCKET   R2 bucket name                    (default: unicorn-web)
#   SOURCE      local | corral                    (default: local)
#   CORRAL_HOST Corral web host for SOURCE=corral (default: https://web.corral.tacc.utexas.edu)
#   MAX_DELETE  refuse to delete more than this many R2 files per rclone call (default: unlimited;
#               the scheduled GitHub Action sets it, so a bad Corral listing can't wipe the mirror)
#   SRC_ROOTS   space-sep roots holding each field's <…>/Results/web/cards
#               (default: Adonalsium's catalog roots — EDIT to match this machine)
#   FITSGL_ROOT fitsgl tile tree: <FITSGL_ROOT>/<prefix>/…
set -euo pipefail

R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-unicorn-web}"
SRC_ROOTS="${SRC_ROOTS:-$HOME/Research/UNICORN /Volumes/Braize/UNICORN /Volumes/Nalthis/UNICORN /Volumes/Threnody/UNICORN}"
FITSGL_ROOT="${FITSGL_ROOT:-$HOME/Research/UNICORN/WebFiles/fitsgl_rebuild}"
SOURCE="${SOURCE:-local}"
CORRAL_HOST="${CORRAL_HOST:-https://web.corral.tacc.utexas.edu}"
case "$SOURCE" in local|corral) ;; *) echo "SOURCE must be 'local' or 'corral' (got '$SOURCE')"; exit 2;; esac

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
        --s3-upload-concurrency 8 --stats 10s --stats-one-line)
[ "${DRYRUN:-0}" = "1" ] && RCLONE+=(--dry-run)
[ -t 1 ] && RCLONE+=(--progress)                  # live bar in a terminal only (not CI logs)
[ -n "${MAX_DELETE:-}" ] && RCLONE+=(--max-delete "$MAX_DELETE")
# SOURCE=corral reads Corral's Apache autoindex via rclone's on-the-fly http backend
# (":http:/<path>" with --http-url); Corral paths mirror the R2 keys under /unicorn/.
[ "$SOURCE" = "corral" ] && RCLONE+=(--http-url "$CORRAL_HOST")

# r2sync SRC DST — data files first (copy, no deletes), then a full sync that uploads the JSON
# indexes (cards manifest/idx, fitsgl.json, per-band manifest.json) and prunes stale keys. A
# reader therefore never sees a NEW index that points into OLD .bin/.fits.fz bytes mid-upload.
r2sync() {
  "${RCLONE[@]}" copy "$1" "$2" --exclude '*.json' --exclude '*.json.gz'
  "${RCLONE[@]}" sync "$1" "$2"
}

want_field() {   # $1=field ; no filter args ⇒ all
  [ ${#WANT[@]} -eq 0 ] && return 0
  for f in "${WANT[@]}"; do [ "$f" = "$1" ] && return 0; [ "$f" = "all" ] && return 0; done
  return 1
}

sync_cards_corral() {
  echo "── Scope A (from Corral): $CORRAL_HOST/unicorn/Catalogs/Legacy/<FIELD>/web/cards → r2://${R2_BUCKET}/… ──"
  local pfx d fld
  for pfx in $ALL_PREFIXES; do
    d=$(pfx_to_dir "$pfx"); fld=$(pfx_to_field "$pfx")
    want_field "$fld" || continue
    echo "  [$fld]  corral:Legacy/$d/web/cards"
    r2sync ":http:/unicorn/Catalogs/Legacy/${d}/web/cards" \
      "${R2_REMOTE}:${R2_BUCKET}/Catalogs/Legacy/${d}/web/cards"
  done
}

# Pass 1: discover local web/cards dirs → lines "DIR<TAB>FIELD<TAB>path" (nothing uploaded yet).
discover_local_cards() {
  local root cdir bin cand pfx d fld
  for root in $SRC_ROOTS; do
    [ -d "$root" ] || continue
    # prune backup / comparison trees (e.g. v0991_prenoise_backup/, code_backups/, v099_compare/)
    # so a stale copy is never synced onto the live field's R2 keys
    while IFS= read -r cdir; do
      # derive the field prefix from a packed-card filename in this dir (glob, not find|head —
      # a pipe here races SIGPIPE against `pipefail` and silently kills the loop)
      bin=""
      for cand in "$cdir"/*_cards.manifest.json "$cdir"/*_cards_*.bin; do
        [ -e "$cand" ] && { bin="$cand"; break; }
      done
      [ -n "$bin" ] || continue
      pfx=$(basename "$bin"); pfx=${pfx%%_cards*}
      d=$(pfx_to_dir "$pfx"); fld=$(pfx_to_field "$pfx")
      [ -n "$d" ] || { echo "  ?? unknown prefix '$pfx' in $cdir — skipping" >&2; continue; }
      want_field "$fld" || continue
      printf '%s\t%s\t%s\n' "$d" "$fld" "$cdir"
    done < <(find "$root" -type d \( -iname '*backup*' -o -iname '*_compare' \) -prune \
               -o -type d -path "*/Results/web/cards" -print 2>/dev/null)
  done
}

sync_cards() {
  [ "$SOURCE" = "corral" ] && { sync_cards_corral; return; }
  echo "── Scope A: web/cards → r2://${R2_BUCKET}/Catalogs/Legacy/<FIELD>/web/cards ──"
  local plan dups d fld cdir
  plan=$(discover_local_cards)
  [ -n "$plan" ] || { echo "  !! no web/cards dirs found under: $SRC_ROOTS"; echo "     set SRC_ROOTS for this machine (or SOURCE=corral)."; exit 1; }
  # two local dirs → same R2 key would overwrite each other (last one wins): refuse BEFORE uploading
  dups=$(printf '%s\n' "$plan" | cut -f1 | sort | uniq -d)
  if [ -n "$dups" ]; then
    echo "  !! more than one local web/cards dir maps to the same R2 key — nothing uploaded:"
    for d in $dups; do printf '%s\n' "$plan" | awk -F'\t' -v d="$d" '$1==d {print "       " $2 ": " $3}'; done
    echo "     narrow SRC_ROOTS (or move/rename the stale copy)."
    exit 1
  fi
  while IFS=$'\t' read -r d fld cdir; do
    echo "  [$fld]  $cdir"
    r2sync "$cdir" "${R2_REMOTE}:${R2_BUCKET}/Catalogs/Legacy/${d}/web/cards"
  done <<< "$plan"
}

sync_fitsgl() {
  echo "── Scope B: fitsgl tiles → r2://${R2_BUCKET}/fitsgl/<prefix>  (source: $SOURCE) ──"
  if [ "$SOURCE" = "corral" ]; then
    # Each Corral fitsgl/<prefix>/ dir holds an index.html (standalone viewer), so Apache serves
    # that instead of an autoindex and rclone would see an EMPTY dir. So: read the band dirs
    # from fitsgl.json, sync each <band>/ (those DO autoindex), then upload fitsgl.json last.
    local pfx fld cfg dirs b fail=0
    for pfx in $ALL_PREFIXES; do
      fld=$(pfx_to_field "$pfx"); want_field "$fld" || continue
      echo "  [$fld]  corral:fitsgl/$pfx"
      if ! cfg=$(curl -fsS --retry 5 --retry-delay 10 --max-time 300 "$CORRAL_HOST/unicorn/fitsgl/$pfx/fitsgl.json"); then
        echo "  !! [$fld] could not fetch fitsgl.json — skipping field"; fail=1; continue
      fi
      if ! dirs=$(printf '%s' "$cfg" | python3 -c 'import json,sys
for d in sorted({t.split("/")[0] for b in json.load(sys.stdin)["dataset"]["bands"] for t in b["tiles"] if t.count("/")==1 and "://" not in t}): print(d)') \
         || [ -z "$dirs" ]; then
        echo "  !! [$fld] no band dirs parsed from fitsgl.json — skipping field"; fail=1; continue
      fi
      for b in $dirs; do
        r2sync ":http:/unicorn/fitsgl/${pfx}/${b}" "${R2_REMOTE}:${R2_BUCKET}/fitsgl/${pfx}/${b}" || fail=1
      done
      "${RCLONE[@]}" copyto ":http:/unicorn/fitsgl/${pfx}/fitsgl.json" "${R2_REMOTE}:${R2_BUCKET}/fitsgl/${pfx}/fitsgl.json" || fail=1
    done
    [ "$fail" = 0 ] || { echo "  !! some fitsgl fields/bands failed (see above)"; exit 1; }
    return
  fi
  [ -d "$FITSGL_ROOT" ] || { echo "  !! FITSGL_ROOT not found: $FITSGL_ROOT"; exit 1; }
  for pfx in $ALL_PREFIXES; do
    local src="$FITSGL_ROOT/$pfx"
    [ -d "$src" ] || continue
    local fld; fld=$(pfx_to_field "$pfx")
    want_field "$fld" || continue
    echo "  [$fld]  $src"
    r2sync "$src" "${R2_REMOTE}:${R2_BUCKET}/fitsgl/${pfx}"
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
