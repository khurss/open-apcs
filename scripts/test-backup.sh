#!/bin/sh
set -eu
suffix=$(cat /proc/sys/kernel/random/uuid | tr -d '-')
export PGDATABASE="apcs_backup_test_$suffix"
restored="${PGDATABASE}_restored"
corrupt_target="${PGDATABASE}_corrupt"
backup_dir=$(mktemp -d)
cleanup() {
  dropdb --if-exists "$restored" >/dev/null
  dropdb --if-exists "$corrupt_target" >/dev/null
  dropdb --if-exists "$PGDATABASE" >/dev/null
  rm -rf "$backup_dir"
}
trap cleanup EXIT INT TERM
createdb --template=template0 "$PGDATABASE"
psql -X -q -v ON_ERROR_STOP=1 -f apps/api/migrations/001-application.sql
psql -X -q -v ON_ERROR_STOP=1 -f apps/api/migrations/002-editors.sql
psql -X -q -v ON_ERROR_STOP=1 -f packages/storage/migrations/001-command-journal.sql
psql -X -q -v ON_ERROR_STOP=1 -f packages/storage/migrations/002-reconciliation.sql
psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO apcs_users (id,username,password_hash) VALUES ('00000000-0000-4000-8000-000000000001','fixture','fixture-only');
INSERT INTO apcs_projects (id,name,owner_id) VALUES ('00000000-0000-4000-8000-000000000002','Backup bench','00000000-0000-4000-8000-000000000001');
INSERT INTO apcs_documents (id,project_id,kind,name,document) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','graph','Persisted graph','{"schemaVersion":1,"nodes":[],"edges":[]}');
INSERT INTO apcs_document_revisions (document_id,revision,name,document,checksum,actor_id) VALUES ('00000000-0000-4000-8000-000000000003',1,'Immutable graph','{}',repeat('a',64),'00000000-0000-4000-8000-000000000001');
SQL
file=$(sh scripts/database-backup.sh "$backup_dir")
[ -f "$file" ] || { echo 'FAIL: no backup archive was created' >&2; exit 1; }
[ -f "$file.sha256" ]
[ "$(stat -c %a "$file")" = 600 ]
sh scripts/database-restore.sh "$file" "$restored"
[ "$(psql -X -Atq --dbname="$restored" -c 'SELECT name FROM apcs_projects')" = 'Backup bench' ]
[ "$(psql -X -Atq --dbname="$restored" -c 'SELECT name FROM apcs_documents')" = 'Persisted graph' ]
if psql -X -q -v ON_ERROR_STOP=1 --dbname="$restored" -c "UPDATE apcs_document_revisions SET name='tampered'" > /dev/null 2>&1; then
  echo 'FAIL: restored revision protection was lost' >&2; exit 1
fi
if sh scripts/database-restore.sh "$file" "$restored" > /dev/null 2>&1; then
  echo 'FAIL: restore overwrote an existing database' >&2; exit 1
fi
printf 'corrupted' >> "$file"
if sh scripts/database-restore.sh "$file" "$corrupt_target" > /dev/null 2>&1; then
  echo 'FAIL: corrupted backup was accepted' >&2; exit 1
fi
[ "$(psql -X -Atq --dbname=postgres -c "SELECT count(*) FROM pg_database WHERE datname='$corrupt_target'")" = 0 ]
printf 'Backup/restore checks passed: data, schema, immutability, permissions, overwrite refusal, corruption rejection.\n'
