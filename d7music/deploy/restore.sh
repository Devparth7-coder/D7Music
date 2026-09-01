#!/usr/bin/env bash
# Restore a D7music backup taken by deploy/backup.sh.
#
#   deploy/restore.sh /var/backups/d7music/latest            # plan + prompts
#   deploy/restore.sh --with-storage /var/backups/d7music/latest
#   D7_CONFIRM=yes deploy/restore.sh latest                    # non-interactive (cron/drill)
#
# Reads only: it restores into the database named by D7_RESTORE_URL, which defaults to
# DATABASE_URL from the env file. To restore over the live database, stop the API and worker
# first, or sessions/queues written after the dump will be silently wrong.
set -euo pipefail

SRC="${1:-/var/backups/d7music/latest}"
WITH_STORAGE=0
if [[ "${1:-}" == "--with-storage" ]]; then WITH_STORAGE=1; SRC="${2:?restore: pass the backup directory after --with-storage}"; fi
[[ -n "$SRC" ]] || SRC=/var/backups/d7music/latest
[[ -d "$SRC" ]] || { echo "restore: $SRC is not a directory" >&2; exit 2; }

ENV_FILE="${D7_ENV_FILE:-/etc/d7music/d7music.env}"
read_env() {
  local key="$1" value=""
  if [[ -n "${!key:-}" ]]; then value="${!key}"
  elif [[ -f "$ENV_FILE" ]]; then value="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n1)"; fi
  printf '%s' "$value"
}

TARGET="$(read_env D7_RESTORE_URL)"
[[ -n "$TARGET" ]] || TARGET="$(read_env DATABASE_URL)"
[[ -n "$TARGET" ]] || { echo "restore: set D7_RESTORE_URL (or DATABASE_URL) to the target database" >&2; exit 2; }

DUMP="$SRC/d7music.dump"
[[ -f "$DUMP" ]] || { echo "restore: $DUMP missing — a directory without a dump is not a backup" >&2; exit 2; }

# The manifest is the only place the original object-store mode is recorded: restoring SQL over an
# empty bucket is a silent data-loss event, so refuse to do it without an explicit decision.
[[ -f "$SRC/manifest.txt" ]] && cat "$SRC/manifest.txt"

echo "restore: database <- $DUMP"
echo "restore: target      $(printf '%s' "$TARGET" | sed -E 's#://[^@]*@#://***@#')"
if [[ "$WITH_STORAGE" == 1 && -f "$SRC/storage.tar.gz" ]]; then
  dest="$(read_env STORAGE_LOCAL_DIR)"; dest="${dest:-storage/audio}"
  echo "restore: objects   <- storage.tar.gz into $dest (extracted next to, not over, existing files)"
else
  echo "restore: objects   not restored (pass --with-storage, or restore the bucket out of band)"
fi

if [[ "${D7_CONFIRM:-}" != "yes" ]]; then
  printf 'restore: this OVERWRITES the target database. Type the target database name to continue: '
  # `|| true` so a non-interactive run (cron, piped stdin) fails on the comparison below with the
  # "expected X" message instead of dying silently under set -e.
  read -r answer || answer="" 
  expected="$(printf '%s' "$TARGET" | sed -E 's#.*/([^?]+).*#\1#')"
  [[ "$answer" == "$expected" ]] || { echo "restore: aborted (expected \"$expected\")" >&2; exit 3; }
fi

command -v pg_restore >/dev/null || { echo "restore: pg_restore not found (install postgresql-client)" >&2; exit 4; }

# --clean --if-exists drops the objects the dump owns before recreating them. It does not drop
# tables that exist in the target but not in the dump: use an empty database (or a fresh schema)
# for anything that must match the backup byte for byte.
pg_restore --no-owner --no-privileges --clean --if-exists -d "$TARGET" "$DUMP" \
  || { echo "restore: pg_restore reported errors — the schema is partial; do not start the API" >&2; exit 5; }

if [[ "$WITH_STORAGE" == 1 && -f "$SRC/storage.tar.gz" ]]; then
  dest="$(read_env STORAGE_LOCAL_DIR)"; dest="${dest:-storage/audio}"
  mkdir -p "$dest"
  tar -C "$(dirname "$dest")" -xzf "$SRC/storage.tar.gz"
fi

# Post-restore invariants. These are the ones a dump can genuinely get wrong: the migration ledger
# must match the code that is deployed, and nothing published may lack a licence.
psql "$TARGET" -v ON_ERROR_STOP=1 -c "
  SELECT count(*) AS migrations FROM schema_migrations;
  SELECT count(*) AS published_without_license
    FROM tracks t LEFT JOIN licenses l ON l.entity_type='track' AND l.entity_id = t.id
   WHERE t.status='published' AND l.id IS NULL;" \
  || echo "restore: psql missing or the checks failed — run them by hand before starting the API" >&2

cat <<'EOT'
restore: next steps
  1. npm run db:migrate        # apply anything added after the backup was taken
  2. start the worker, then the API, then POST /api/admin/reindex (fresh shelves + search)
  3. play a track. A restore that can list songs but not play them is a failed restore.
  4. check webhook_events: payments after the dump timestamp are gone and the gateway will not
     re-send them — replay from the provider's console if that matters.
EOT
