#!/usr/bin/env bash
# D7music backup: custom-format dump of the database + the local audio objects.
#
#   deploy/backup.sh                     # uses /etc/d7music/d7music.env
#   D7_ENV_FILE=./.env deploy/backup.sh   # local trial run
#   deploy/backup.sh --dry-run            # print the plan, write nothing
#
# Why both halves: the database stores object *keys*; bytes live in STORAGE_LOCAL_DIR or the
# bucket. One without the other restores a library that cannot play. With STORAGE_DRIVER=s3 the
# bucket is snapshotted/copied by your provider (this script says so instead of pretending).
#
# Nightly dumps are not a recovery point for user data. Enable provider-side WAL archiving/PITR
# too, and restore-test this output on a scratch database every quarter.
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]] && DRY_RUN=1

ENV_FILE="${D7_ENV_FILE:-/etc/d7music/d7music.env}"
OUT_DIR="${D7_BACKUP_DIR:-/var/backups/d7music}"
KEEP="${D7_BACKUP_KEEP:-7}"

# Prefer the real environment; fall back to the env file (systemd EnvironmentFile format:
# KEY=VALUE, one per line, no inline comments — exactly what .env.example guarantees).
read_env() {
  local key="$1" value=""
  if [[ -n "${!key:-}" ]]; then
    value="${!key}"
  elif [[ -f "$ENV_FILE" ]]; then
    value="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n1)"
  fi
  printf '%s' "$value"
}

DATABASE_URL="$(read_env DATABASE_URL)"
DB_DRIVER="$(read_env DB_DRIVER)"
STORAGE_DIR="$(read_env STORAGE_LOCAL_DIR)"; STORAGE_DIR="${STORAGE_DIR:-storage/audio}"
STORAGE_DRIVER="$(read_env STORAGE_DRIVER)"; STORAGE_DRIVER="${STORAGE_DRIVER:-local}"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
host="$(hostname -s 2>/dev/null || echo host)"
work="$OUT_DIR/$ts"

if [[ -z "$DATABASE_URL" ]]; then
  if [[ "$DB_DRIVER" == "pglite" ]]; then
    pglite_dir="$(read_env PGLITE_DIR)"; pglite_dir="${pglite_dir:-.data/pglite}"
    echo "backup: DB_DRIVER=pglite - the cluster is a data directory; stop the app, then copy it:" >&2
    echo "        rsync -a --delete $pglite_dir/ $OUT_DIR/$ts/pglite/" >&2
    echo "        (a cluster copied mid-write restores corrupt; dev data is usually cheaper to re-seed)" >&2
    exit 2
  fi
  echo "backup: DATABASE_URL is empty and $ENV_FILE was not readable. Set D7_ENV_FILE or export DATABASE_URL." >&2
  exit 2
fi

if [[ "$DRY_RUN" == 0 ]]; then
  for tool in pg_dump tar; do
    command -v "$tool" >/dev/null || { echo "backup: $tool not found (install postgresql-client)" >&2; exit 3; }
  done
fi

# Masked: a connection string carries the password, and this line ends up in a cron log.
echo "backup: db=$(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@]*@#://***@#') storage=$STORAGE_DIR driver=$STORAGE_DRIVER -> $work"
if [[ "$DRY_RUN" == 1 ]]; then
  echo "backup: --dry-run, nothing written"
  exit 0
fi

umask 077
mkdir -p "$work"

# ---- database --------------------------------------------------------------
# --no-owner/--no-privileges so a restore into a differently-named role works; zstd keeps a
# multi-GB catalog dump small enough to ship off-site.
pg_dump --format=custom --compress=zstd --no-owner --no-privileges \
  "$DATABASE_URL" > "$work/d7music.dump" || { echo "backup: pg_dump failed" >&2; exit 4; }

# Verify before we prune anything: a dump that cannot be listed is not a backup.
if command -v pg_restore >/dev/null; then
  pg_restore --list "$work/d7music.dump" | grep -q 'TABLE DATA' \
    || { echo "backup: dump contains no table data — refusing to prune old backups" >&2; exit 5; }
else
  echo "backup: pg_restore missing; skipping verification" >&2
fi

# ---- objects ---------------------------------------------------------------
case "$STORAGE_DRIVER" in
  local)
    if [[ -d "$STORAGE_DIR" ]]; then
      tar -C "$(dirname "$STORAGE_DIR")" -czf "$work/storage.tar.gz" "$(basename "$STORAGE_DIR")"
      echo "backup: $(du -h "$work/storage.tar.gz" | cut -f1) of objects"
    else
      echo "backup: STORAGE_LOCAL_DIR=$STORAGE_DIR does not exist — no objects to back up" >&2
    fi
    ;;
  s3)
    echo "backup: STORAGE_DRIVER=s3 — snapshot/replicate the bucket with your provider; this script only dumps SQL."
    ;;
esac

# ---- manifest --------------------------------------------------------------
cat > "$work/manifest.txt" <<EOF
created_utc=$ts
host=$host
database=$(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@]*@#://***@#')
storage_driver=$STORAGE_DRIVER
storage_dir=$STORAGE_DIR
dump_bytes=$(stat -c%s "$work/d7music.dump" 2>/dev/null || stat -f%z "$work/d7music.dump")
objects=$( [[ -f "$work/storage.tar.gz" ]] && (stat -c%s "$work/storage.tar.gz" 2>/dev/null || stat -f%z "$work/storage.tar.gz") || echo 0 )
sha256=$( cd "$work" && sha256sum d7music.dump 2>/dev/null | cut -c1-64 || echo n/a )
EOF

ln -sfn "$work" "$OUT_DIR/latest"

# ---- prune -----------------------------------------------------------------
# Only after a verified dump exists, and never below one retained copy.
if [[ "$KEEP" =~ ^[0-9]+$ ]] && (( KEEP > 0 )); then
  ls -1dt "$OUT_DIR"/[0-9]* 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
    echo "backup: pruning $old"; rm -rf "$old"
  done
fi

echo "backup: done -> $work"
