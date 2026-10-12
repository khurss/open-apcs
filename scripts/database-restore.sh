#!/bin/sh
set -eu
umask 077
: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
[ "$#" -eq 2 ] && [ -f "$1" ] && [ -f "$1.sha256" ] || { echo 'Usage: database-restore.sh BACKUP_FILE NEW_DATABASE_NAME' >&2; exit 2; }
file=$1
target=$2
printf '%s\n' "$target" | LC_ALL=C grep -Eq '^[a-z][a-z0-9_]{2,62}$' || { echo 'Invalid destination database name' >&2; exit 2; }
expected=$(cat "$file.sha256")
actual=$(sha256sum < "$file")
[ "$expected" = "$actual" ] || { echo 'Backup checksum mismatch' >&2; exit 1; }
pg_restore --list "$file" >/dev/null
# createdb refuses an existing database. The script never drops a user database.
createdb --maintenance-db=postgres --template=template0 "$target"
pg_restore --dbname="$target" --single-transaction --exit-on-error --no-owner --no-acl "$file"
printf 'Restored into new database %s. Existing databases were not replaced.\n' "$target"
