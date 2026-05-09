#!/usr/bin/env bash
# Assert every projector's interested_event_types is in the
# ingestion_event_catalog vocabulary (db/init/35_event_type_vocabulary.sql),
# and (mode=strict only) every catalog entry has at least one consumer.
#
# Run locally:  bash scripts/check_event_vocabulary.sh
# Strict mode:  CHECK_VOCAB_STRICT=1 bash scripts/check_event_vocabulary.sh
#
# Why this lint exists. The event-sourced ingestion layer relies on the
# event_type string matching across emitter, catalog, and projector. A
# typo or stale name silently breaks the projection — the projector
# subscribes to an event that nobody emits and stays quiet, no error.
# Tracked at the code-review level today; this lint enforces it.

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Catalog → set of declared event_types. We grep the canonical seed
# rather than parsing SQL — the keys are stable single-quoted literals
# at the start of each VALUES tuple in 35_event_type_vocabulary.sql.
catalog_file="${repo_root}/db/init/35_event_type_vocabulary.sql"
if [[ ! -f "${catalog_file}" ]]; then
  echo "ERROR: ${catalog_file} not found" >&2
  exit 1
fi

# Pull tuple-leading literals from the INSERT INTO ingestion_event_catalog
# block. The block is delimited by `INSERT INTO ingestion_event_catalog`
# above and `ON CONFLICT` below.
catalog_types=$(awk '
  /INSERT INTO ingestion_event_catalog/ { in_block = 1; next }
  /ON CONFLICT/                          { in_block = 0 }
  in_block && /^[[:space:]]*\(/         {
    if (match($0, /\x27[a-zA-Z_]+\x27/)) {
      print substr($0, RSTART + 1, RLENGTH - 2)
    }
  }
' "${catalog_file}" | sort -u)

if [[ -z "${catalog_types}" ]]; then
  echo "ERROR: parsed zero event types out of catalog file" >&2
  exit 1
fi

# Projectors → their declared interested_event_types tuples.
declare -A subscriptions=()
for projector_dir in "${repo_root}"/services/projectors/*/; do
  main_py="${projector_dir}main.py"
  [[ -f "${main_py}" ]] || continue
  projector_name=$(basename "${projector_dir}")
  # Skip the shared base.
  [[ "${projector_name}" == "common" ]] && continue
  # interested_event_types = ("event_a", "event_b") — single-line tuple.
  raw=$(grep -E 'interested_event_types\s*=\s*\(' "${main_py}" | head -n 1 || true)
  if [[ -z "${raw}" ]]; then
    continue  # custom-channel projectors with empty tuple are documented separately
  fi
  # Strip everything outside the parens, then pull single/double-quoted strings.
  inner=$(echo "${raw}" | sed -E 's/^[^(]*\(([^)]*)\).*/\1/')
  while IFS= read -r match; do
    [[ -n "${match}" ]] && subscriptions["${match}"]+=" ${projector_name}"
  done < <(echo "${inner}" | grep -oE "['\"][a-zA-Z_]+['\"]" | tr -d "'\"")
done

# Validate every subscription is in the catalog.
errors=()
for event_type in "${!subscriptions[@]}"; do
  if ! echo "${catalog_types}" | grep -Fxq "${event_type}"; then
    errors+=("projector(s) ${subscriptions[${event_type}]} subscribe to '${event_type}' but it is NOT in ingestion_event_catalog")
  fi
done

if (( ${#errors[@]} > 0 )); then
  echo "Event-vocabulary check FAILED:" >&2
  printf '  - %s\n' "${errors[@]}" >&2
  echo >&2
  echo "Either fix the projector's interested_event_types or add a row to db/init/35_event_type_vocabulary.sql." >&2
  exit 1
fi

# Strict mode (default OFF): every catalog entry has at least one consumer
# declared in `consumed_by`. Off by default because reserved/future
# entries (fact_invalidated, reaction_corrected, …) intentionally have
# no live consumer yet.
if [[ "${CHECK_VOCAB_STRICT:-0}" == "1" ]]; then
  orphans=$(awk '
    /INSERT INTO ingestion_event_catalog/ { in_block = 1; next }
    /ON CONFLICT/                          { in_block = 0 }
    in_block { print }
  ' "${catalog_file}" | grep -B0 -A6 "ARRAY\[\]::TEXT\[\]" || true)
  if [[ -n "${orphans}" ]]; then
    echo "Event-vocabulary STRICT check FAILED — catalog entries with empty consumers:" >&2
    echo "${orphans}" >&2
    exit 1
  fi
fi

echo "Event-vocabulary check OK ($(echo "${catalog_types}" | wc -l) catalog entries; ${#subscriptions[@]} live subscriptions)"
