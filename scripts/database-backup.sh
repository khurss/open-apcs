#!/bin/sh
set -eu
umask 077
: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
[ "$#" -eq 1 ] && [ -d "$1" ] || { echo 'Usage: database-backup.sh EXISTING_OUTPUT_DIRECTORY' >&2; exit 2; }
# The caller owns this local directory; archives include credential hashes and audit data.
temporary=$(mktemp "$1/.apcs-backup-XXXXXXXX.dump")
trap 'rm -f "$temporary" "$temporary.sha256"' EXIT INT TERM
pg_dump --format=custom --no-owner --no-acl --file="$temporary"
pg_restore --list "$temporary" >/dev/null
sha256sum < "$temporary" > "$temporary.sha256"
final="$(dirname "$temporary")/$(basename "$temporary" | sed 's/^\.//')"
mv "$temporary" "$final"
mv "$temporary.sha256" "$final.sha256"
printf '%s\n' "$final"
