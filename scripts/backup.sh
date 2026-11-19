#!/usr/bin/env bash
# Full PostgreSQL backup (custom format). Restore with: pg_restore -d "$DATABASE_URL" --clean <file>
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
out="${1:-groshi-ok-$(date +%Y%m%d-%H%M%S).dump}"
pg_dump --format=custom --no-owner "$DATABASE_URL" > "$out"
echo "Backup written to $out"
