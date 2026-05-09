#!/usr/bin/env bash
# Assert that every db/init/*.sql file self-records into schema_version.
#
# CLAUDE.md says SELECT * FROM schema_version is the canonical applied-init
# list. The Makefile loop INSERTs one row per file at apply time, but that
# fails open if a file is applied via raw `psql -f db/init/N_*.sql` outside
# the loop (which is the hot path during incident response). Backfilling
# every file with its own INSERT closes the gap; this lint keeps it closed.
#
# Run locally:  bash scripts/check_init_self_record.sh
# Exit code:    0 = all files self-record, 1 = at least one missing.

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
init_dir="${repo_root}/db/init"

if [[ ! -d "${init_dir}" ]]; then
  echo "ERROR: ${init_dir} not found" >&2
  exit 1
fi

missing=()
for f in "${init_dir}"/*.sql; do
  fname=$(basename "${f}")
  # Each file must contain `INSERT INTO schema_version (filename) VALUES ('<fname>')`.
  # We tolerate whitespace and case but require the exact filename literal.
  if ! grep -E -q "INSERT[[:space:]]+INTO[[:space:]]+schema_version" "${f}"; then
    missing+=("${fname}: no INSERT INTO schema_version found")
    continue
  fi
  if ! grep -F -q "'${fname}'" "${f}"; then
    missing+=("${fname}: schema_version INSERT does not reference filename '${fname}' as a literal")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "schema_version self-record check FAILED — ${#missing[@]} file(s) missing:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo >&2
  echo "Add the standard footer to each file (just before COMMIT):" >&2
  cat <<'TEMPLATE' >&2

  -- Self-record for schema_version (Makefile loop is belt-and-suspenders).
  INSERT INTO schema_version (filename)
  VALUES ('<this-file-name>.sql')
  ON CONFLICT DO NOTHING;

TEMPLATE
  exit 1
fi

echo "schema_version self-record check OK ($(ls "${init_dir}"/*.sql | wc -l) files)"
