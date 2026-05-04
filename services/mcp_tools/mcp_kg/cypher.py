"""Cypher builders for the knowledge-graph operations.

SECURITY NOTE ON LABEL/TYPE INTERPOLATION
-----------------------------------------
Cypher's `$param` binding mechanism only substitutes values, not labels or
relationship types. We therefore interpolate label and relationship-type
strings directly into the query text. This is safe ONLY because the Pydantic
layer (`models.LabelStr`, `models.PredicateStr`) constrains them to a strict
regex. We re-validate here as defense in depth.
"""

from __future__ import annotations

import re
from typing import Any

from services.mcp_tools.mcp_kg.models import QueryAtTimeRequest, WriteFactRequest

_LABEL_RE = re.compile(r"^[A-Z][A-Za-z0-9_]{0,79}$")
_PRED_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,79}$")
_ID_PROP_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
_GROUP_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,80}$")


def _safe_label(label: str) -> str:
    if not _LABEL_RE.fullmatch(label):
        raise ValueError(f"unsafe label: {label!r}")
    return label


def _safe_predicate(predicate: str) -> str:
    if not _PRED_RE.fullmatch(predicate):
        raise ValueError(f"unsafe predicate: {predicate!r}")
    return predicate


def _safe_id_property(id_property: str) -> str:
    if not _ID_PROP_RE.fullmatch(id_property):
        raise ValueError(f"unsafe id_property: {id_property!r}")
    return id_property


def _safe_group_id(group_id: str) -> str:
    """Defense-in-depth check on the tenant scope identifier.

    The Pydantic layer (`models.GroupIdStr`) already enforces this shape, but
    the same regex is re-validated here so a future refactor can't bypass it
    by constructing a request via internal Python paths.
    """
    if not _GROUP_ID_RE.fullmatch(group_id):
        raise ValueError(f"unsafe group_id: {group_id!r}")
    return group_id


# ---------------------------------------------------------------------------
# STARTUP — uniqueness constraint + indexes
# ---------------------------------------------------------------------------
def bootstrap_cyphers() -> list[str]:
    """Cypher statements to run on service startup. Idempotent.

    Requires Neo4j 5.7+ for `REQUIRE r.fact_id IS UNIQUE` on relationships.
    """
    return [
        # Relationship-level uniqueness on fact_id across the whole graph.
        # This is the primary defence against duplicate-edge races.
        "CREATE CONSTRAINT rel_fact_id_unique IF NOT EXISTS "
        "FOR ()-[r]-() REQUIRE r.fact_id IS UNIQUE",
        # Lookup index for fact_exists / invalidate_fact (prevents full-graph scan).
        "CREATE INDEX rel_fact_id_lookup IF NOT EXISTS "
        "FOR ()-[r]-() ON (r.fact_id)",
        # Tenant lookup index — every read filters by group_id. Without this,
        # a query for project A's facts scans every edge in the graph and
        # then post-filters; with it, the planner can use the index for
        # selective tenants. (Non-uniqueness: one tenant has many facts.)
        "CREATE INDEX rel_group_id_lookup IF NOT EXISTS "
        "FOR ()-[r]-() ON (r.group_id)",
    ]


# ---------------------------------------------------------------------------
# WRITE FACT (race-safe, single statement)
# ---------------------------------------------------------------------------
def build_write_fact_cypher(req: WriteFactRequest) -> tuple[str, dict[str, Any]]:
    """Build an idempotent, race-safe MERGE that creates the edge only when
    no edge with the same fact_id exists anywhere in the graph.

    Critical properties:
      - MERGE on `{fact_id}` matches an existing edge by its fact_id, so two
        concurrent calls with the same fact_id will result in exactly one edge
        (backed by the `rel_fact_id_unique` constraint).
      - ON CREATE applies all the edge metadata. ON MATCH is a no-op — we
        never overwrite a fact once written.
      - `created` in the RETURN tells the caller whether this call created the
        edge (true) or simply matched an existing one (false).

    Cross-tenant fact_id collisions (deliberate behaviour):
      The MERGE matches on `fact_id` only, NOT `(fact_id, group_id)`. This
      means if tenant A writes a fact_id that already exists from tenant B,
      the MERGE matches B's edge, ON CREATE does not fire, and A's group_id
      is silently dropped. The response's `created: false` flag is the only
      signal — and a subsequent query for the same fact_id under tenant A's
      group_id will return zero rows because read paths filter by group_id.
      This is a per-fact_id idempotency guarantee that wins over per-tenant
      attribution: shared canonical facts (e.g. "compound X has InChIKey Y")
      stay deduplicated globally rather than fanning out across tenants.
      Callers that need tenant-scoped uniqueness MUST construct fact_ids that
      include the group_id (the kg_experiments deterministic_fact_id helper
      should be extended in a later tranche if this becomes a hot path).
    """
    s_label = _safe_label(req.subject.label)
    o_label = _safe_label(req.object.label)
    pred = _safe_predicate(req.predicate)
    s_id_prop = _safe_id_property(req.subject.id_property)
    o_id_prop = _safe_id_property(req.object.id_property)
    _safe_group_id(req.group_id)  # defense-in-depth; param is bound below

    query = f"""
    MERGE (s:{s_label} {{ {s_id_prop}: $s_id_value }})
      ON CREATE SET s += $subject_properties, s.created_at = datetime()
    MERGE (o:{o_label} {{ {o_id_prop}: $o_id_value }})
      ON CREATE SET o += $object_properties, o.created_at = datetime()
    MERGE (s)-[r:{pred} {{ fact_id: $fact_id }}]->(o)
      ON CREATE SET r.t_valid_from = $t_valid_from,
                    r.recorded_at = $recorded_at,
                    r.t_valid_to = null,
                    r.invalidated_at = null,
                    r.confidence_tier = $confidence_tier,
                    r.confidence_score = $confidence_score,
                    r.provenance = $provenance,
                    r.group_id = $group_id,
                    r += $edge_properties
    RETURN r.fact_id AS fact_id,
           r.t_valid_from AS t_valid_from,
           r.recorded_at AS recorded_at,
           r.recorded_at = $recorded_at AS created
    """
    params = {
        "s_id_value": req.subject.id_value,
        "o_id_value": req.object.id_value,
        "subject_properties": req.subject_properties or {},
        "object_properties": req.object_properties or {},
        "edge_properties": req.edge_properties or {},
        "fact_id": None,          # filled in by driver.py
        "t_valid_from": None,
        "recorded_at": None,
        "confidence_tier": req.confidence_tier.value,
        "confidence_score": req.confidence_score,
        "provenance": None,       # filled in by driver.py (JSON-serialised)
        "group_id": req.group_id,
    }
    return query, params


# ---------------------------------------------------------------------------
# INVALIDATE FACT
# ---------------------------------------------------------------------------
def build_invalidate_fact_cypher() -> str:
    """Use the relationship index on fact_id (see bootstrap_cyphers).

    Tenant scope: the MATCH includes `group_id: $group_id` so a caller from
    project A cannot invalidate project B's fact even if they have the
    fact_id. Cross-tenant invalidation surfaces as LookupError (404) at the
    driver layer, identical to "fact_id not found".
    """
    return """
    MATCH ()-[r { fact_id: $fact_id, group_id: $group_id }]->()
    WITH r, r.t_valid_to AS prev_t_valid_to, r.invalidated_at AS prev_inv
    SET r.t_valid_to = CASE WHEN r.t_valid_to IS NULL THEN $t_valid_to ELSE r.t_valid_to END
    SET r.invalidated_at = CASE WHEN r.invalidated_at IS NULL THEN $invalidated_at ELSE r.invalidated_at END
    SET r.invalidation_reason = CASE WHEN r.invalidation_reason IS NULL THEN $reason ELSE r.invalidation_reason END
    SET r.invalidation_provenance = CASE WHEN r.invalidation_provenance IS NULL THEN $provenance ELSE r.invalidation_provenance END
    SET r.confidence_tier = $new_confidence_tier
    RETURN r.invalidated_at AS invalidated_at, (prev_inv IS NOT NULL) AS was_already_invalid
    """


# ---------------------------------------------------------------------------
# QUERY AT TIME
# ---------------------------------------------------------------------------
def build_query_at_time_cypher(req: QueryAtTimeRequest) -> tuple[str, dict[str, Any]]:
    """Return all facts incident to an entity, optionally at a given time."""
    label = _safe_label(req.entity.label)
    id_prop = _safe_id_property(req.entity.id_property)
    pred = _safe_predicate(req.predicate) if req.predicate else None
    _safe_group_id(req.group_id)

    if req.direction == "out":
        match = f"MATCH (n:{label} {{ {id_prop}: $id_value }})-[r{(':' + pred) if pred else ''}]->(m)"
    elif req.direction == "in":
        match = f"MATCH (n:{label} {{ {id_prop}: $id_value }})<-[r{(':' + pred) if pred else ''}]-(m)"
    else:
        match = f"MATCH (n:{label} {{ {id_prop}: $id_value }})-[r{(':' + pred) if pred else ''}]-(m)"

    # group_id is the load-bearing tenant filter — first WHERE clause so the
    # planner can drive the relationship index from this predicate. Putting
    # it last would let the planner consider less selective traversals first.
    where_clauses: list[str] = ["r.group_id = $group_id"]
    if req.at_time is not None:
        where_clauses.append(
            "(r.t_valid_from <= $at_time) AND (r.t_valid_to IS NULL OR r.t_valid_to > $at_time)"
        )
    if not req.include_invalidated:
        # Tranche 4 / H3 (M1 from PR #85 review): make the invalidation filter
        # *time-aware* when the caller specified an as-of timestamp. A fact
        # that was valid on at_time and only got invalidated later should be
        # surfaced — that's the snapshot the agent on at_time would have
        # seen. With at_time absent (current-state query), the filter
        # collapses to `r.invalidated_at IS NULL`, identical to the
        # pre-Tranche-4 behaviour.
        if req.at_time is not None:
            where_clauses.append(
                "(r.invalidated_at IS NULL OR r.invalidated_at > $at_time)"
            )
        else:
            where_clauses.append("r.invalidated_at IS NULL")
    where = "WHERE " + " AND ".join(where_clauses)

    query = f"""
    {match}
    {where}
    RETURN r.fact_id AS fact_id,
           type(r) AS predicate,
           labels(n) AS s_labels,
           labels(m) AS o_labels,
           n AS s_props,
           m AS o_props,
           properties(r) AS edge_properties,
           startNode(r) = n AS n_is_subject
    ORDER BY r.t_valid_from DESC
    LIMIT 1000
    """
    return query, {
        "id_value": req.entity.id_value,
        "at_time": req.at_time,
        "group_id": req.group_id,
    }


# ---------------------------------------------------------------------------
# Tranche 3 / H4 — provenance lookup
# ---------------------------------------------------------------------------
def build_get_fact_provenance_cypher() -> str:
    """Lookup a fact_id and return its bi-temporal + provenance envelope.

    Tenant scope: the MATCH includes `group_id: $group_id` so cross-tenant
    fact_id traversal returns LookupError, mirroring invalidate_fact's
    semantics. The relationship index `rel_fact_id_lookup` and
    `rel_group_id_lookup` cover this access pattern.

    Returns one row when the fact exists in the caller's tenant, zero rows
    otherwise.
    """
    return """
    MATCH (s)-[r { fact_id: $fact_id, group_id: $group_id }]->(o)
    RETURN type(r) AS predicate,
           labels(s) AS s_labels,
           labels(o) AS o_labels,
           s AS s_props,
           o AS o_props,
           r.t_valid_from        AS t_valid_from,
           r.t_valid_to          AS t_valid_to,
           r.recorded_at         AS recorded_at,
           r.invalidated_at      AS invalidated_at,
           r.invalidation_reason AS invalidation_reason,
           r.confidence_tier     AS confidence_tier,
           r.confidence_score    AS confidence_score,
           r.provenance          AS provenance
    LIMIT 1
    """
