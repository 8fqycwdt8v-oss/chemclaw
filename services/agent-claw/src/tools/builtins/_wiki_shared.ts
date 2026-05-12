// Shared schemas + helpers for the knowledge-wiki builtins (Phase 1 of
// ADR 012). The data model lives in db/init/58_knowledge_wiki.sql.
//
// Phase 1 surface: read_article / list_articles / upsert_article /
// request_article. The wiki_pages / wiki_kg / wiki_search_index projectors
// (Phase 2-3) and the wiki_linter cron (Phase 4) consume the same tables.

import { z } from "zod";

import { isFeatureEnabled } from "../../config/flags.js";

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

/** Throws a clear error if the `wiki.enabled` feature flag is off. Every
 *  knowledge-wiki builtin calls this first so the surface is invisible until
 *  an admin enables it (default OFF — see db/init/22_feature_flags.sql). */
export async function assertWikiEnabled(userEntraId: string): Promise<void> {
  const on = await isFeatureEnabled("wiki.enabled", { user: userEntraId });
  if (!on) {
    throw new Error(
      "knowledge-wiki is disabled (feature flag `wiki.enabled`). " +
        "Ask an admin to enable it via PATCH /api/admin/feature-flags/wiki.enabled, " +
        "or set WIKI_ENABLED=true.",
    );
  }
}

// ---------------------------------------------------------------------------
// Enums / shared shapes
// ---------------------------------------------------------------------------

export const ARTICLE_KINDS = [
  "compound",
  "reaction_family",
  "nce_project",
  "synthesis_campaign",
  "document_digest",
  "researcher",
  "topic",
  "glossary",
  "index",
  "log",
  "contradiction",
] as const;
export const ArticleKind = z.enum(ARTICLE_KINDS);
export type ArticleKindT = z.infer<typeof ArticleKind>;

/** Kinds an agent may author/overwrite via `upsert_article`. Entity-backed
 *  kinds + the `index`/`log` catalogs are reserved for the wiki_pages
 *  projector — request those via `request_article`. */
export const AGENT_AUTHORABLE_KINDS: ReadonlySet<ArticleKindT> = new Set([
  "topic",
  "glossary",
  "contradiction",
]);

export const Maturity = z.enum(["EXPLORATORY", "WORKING", "FOUNDATION"]);
export type MaturityT = z.infer<typeof Maturity>;
export const MATURITY_RANK: Record<MaturityT, number> = {
  EXPLORATORY: 1,
  WORKING: 2,
  FOUNDATION: 3,
};

export const EntityRef = z.object({
  label: z.string().min(1).max(64),
  id_property: z.string().min(1).max(64),
  id_value: z.string().min(1).max(512),
});
export type EntityRefT = z.infer<typeof EntityRef>;

/** Slug: lowercase/uppercase alphanumerics plus `/ _ . -`. Must not start with
 *  a separator. Covers `compound/RYYVLZVUVIJVGH-UHFFFAOYSA-N`,
 *  `project/NCE-0042`, `topic/buchwald-hartwig-amination`, `glossary`. */
export const ArticleSlug = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/,
    "slug must be alphanumerics plus / _ . - and not start with a separator",
  );

export const CITE_KINDS = [
  "fact",
  "chunk",
  "experiment",
  "reaction",
  "hypothesis",
  "artifact",
  "document",
  "article",
] as const;
export const CiteKind = z.enum(CITE_KINDS);
export type CiteKindT = z.infer<typeof CiteKind>;

export const CitationRef = z.object({
  cite_kind: CiteKind,
  cite_ref: z.string().min(1).max(512),
  anchor: z.string().max(256).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});
export type CitationRefT = z.infer<typeof CitationRef>;

// ---------------------------------------------------------------------------
// Inline-citation parsing
// ---------------------------------------------------------------------------

const INLINE_CITATION_RE =
  /\[(fact|chunk|experiment|reaction|hypothesis|artifact|document|article):([^\]\s]+)\]/g;

/** Extract inline `[kind:ref]` citations from markdown body text, deduped on
 *  `(kind, ref)`. Used to populate knowledge_article_citations. */
export function parseInlineCitations(bodyMd: string): CitationRefT[] {
  const seen = new Set<string>();
  const out: CitationRefT[] = [];
  for (const m of bodyMd.matchAll(INLINE_CITATION_RE)) {
    if (!m[1] || !m[2]) continue;
    const kind = m[1] as CiteKindT;
    const ref = m[2].slice(0, 512);
    const key = `${kind}::${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cite_kind: kind, cite_ref: ref });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Human-block detection
// ---------------------------------------------------------------------------

const HUMAN_BLOCK_BEGIN_RE = /<!--\s*human:begin\b[^>]*-->/i;

/** True if the body contains a `<!-- human:begin ... -->` marker. Agents may
 *  not author these (the wiki-human-block-guard pre_tool hook denies it);
 *  they appear only in pages that humans have edited via PATCH. */
export function containsHumanBlock(bodyMd: string): boolean {
  return HUMAN_BLOCK_BEGIN_RE.test(bodyMd);
}

// ---------------------------------------------------------------------------
// Row → typed view
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pull a valid UUID session id off the tool-context scratchpad, or null. */
export function sessionIdFromScratchpad(
  scratchpad: Map<string, unknown>,
): string | null {
  const v = scratchpad.get("session_id");
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}

export interface ArticleRow {
  id: string;
  slug: string;
  kind: string;
  title: string;
  summary: string | null;
  body_md: string;
  entity_ref: unknown;
  nce_project_id: string | null;
  group_id: string;
  maturity: string;
  confidence_score: string | number | null;
  status: string;
  dirty: boolean;
  dirty_reason: string | null;
  has_human_edits: boolean;
  source_count: number;
  revision: number;
  etag: string | number;
  created_by: string;
  last_edited_by: string | null;
  created_at: string;
  updated_at: string;
}

export const ArticleSummarySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  kind: ArticleKind,
  title: z.string(),
  summary: z.string().nullable(),
  maturity: Maturity,
  confidence_score: z.number().nullable(),
  status: z.enum(["current", "archived"]),
  dirty: z.boolean(),
  has_human_edits: z.boolean(),
  source_count: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  updated_at: z.string(),
});
export type ArticleSummaryT = z.infer<typeof ArticleSummarySchema>;

export const ArticleDetailSchema = ArticleSummarySchema.extend({
  body_md: z.string(),
  entity_ref: EntityRef.nullable(),
  dirty_reason: z.string().nullable(),
  etag: z.number().int().positive(),
  /** True iff `dirty` — the page may lag its backing facts/documents; the
   *  wiki_pages projector (Phase 2) will regenerate it. */
  stale: z.boolean(),
  citations: z.array(CitationRef),
  created_by: z.string(),
  last_edited_by: z.string().nullable(),
  created_at: z.string(),
});
export type ArticleDetailT = z.infer<typeof ArticleDetailSchema>;

function numOrNull(v: string | number | null): number | null {
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function rowToSummary(r: ArticleRow): ArticleSummaryT {
  return ArticleSummarySchema.parse({
    id: r.id,
    slug: r.slug,
    kind: r.kind,
    title: r.title,
    summary: r.summary ?? null,
    maturity: r.maturity,
    confidence_score: numOrNull(r.confidence_score),
    status: r.status,
    dirty: r.dirty,
    has_human_edits: r.has_human_edits,
    source_count: r.source_count,
    revision: r.revision,
    updated_at: r.updated_at,
  });
}

export function rowToDetail(
  r: ArticleRow,
  citations: CitationRefT[],
): ArticleDetailT {
  return ArticleDetailSchema.parse({
    ...rowToSummary(r),
    body_md: r.body_md,
    entity_ref: r.entity_ref ?? null,
    dirty_reason: r.dirty_reason ?? null,
    etag: typeof r.etag === "number" ? r.etag : Number(r.etag),
    stale: r.dirty,
    citations,
    created_by: r.created_by,
    last_edited_by: r.last_edited_by ?? null,
    created_at: r.created_at,
  });
}

/** SELECT column list for a full ArticleRow (timestamps ISO-formatted). */
export const ARTICLE_SELECT_COLUMNS = `
  ka.id::text                                                    AS id,
  ka.slug,
  ka.kind,
  ka.title,
  ka.summary,
  ka.body_md,
  ka.entity_ref,
  ka.nce_project_id::text                                        AS nce_project_id,
  ka.group_id,
  ka.maturity,
  ka.confidence_score,
  ka.status,
  ka.dirty,
  ka.dirty_reason,
  ka.has_human_edits,
  ka.source_count,
  ka.revision,
  ka.etag,
  ka.created_by,
  ka.last_edited_by,
  to_char(ka.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF')         AS created_at,
  to_char(ka.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF')         AS updated_at
`.trim();
