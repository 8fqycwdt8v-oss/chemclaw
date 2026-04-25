# ChemClaw — Claw Code for Chemistry

**Autonomous knowledge-intelligence agent for pharmaceutical chemical & analytical development.**  
**v1.0.0-claw** — full Claw Code harness redesign complete.

ChemClaw ingests heterogeneous scientific data (ELN entries, analytical results,
SOPs, project reports), maintains a **bi-temporal knowledge graph** with
confidence-scored edges, and serves scientists through a slash-driven chat interface.
It uses scientific tools autonomously (RDKit, DFT, GFN2-xTB, TabPFN, ASKCOS, etc.)
and reads source systems on-demand (Benchling ELN, STARLIMS LIMS, Waters Empower).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Streamlit (port 8501)  ·  slash palette  ·  plan-mode      │
└──────────────────────────────┬──────────────────────────────┘
                               │ SSE (port 3101)
┌──────────────────────────────▼──────────────────────────────┐
│  agent-claw (custom ~500-LOC harness)                        │
│                                                             │
│  Slash router → Hook dispatcher → ReAct loop               │
│  pre_turn  →  pre_tool  →  exec  →  post_tool  →  compact  │
│                                                             │
│  Tools: 30+ builtins · Forged tools · Skill packs (8 max)   │
│  Skills: retro / qc / cross_learning / deep_research /       │
│          askcos / aizynth / chemprop / xtb / admet / sirius  │
└────┬──────────────────┬────────────────────┬────────────────┘
     │ MCP (Python)     │ MCP (Python)       │ MCP (Python)
     ▼                  ▼                    ▼
Chemistry tools    Source-system adapters    KG + retrieval
rdkit · drfp       benchling (8013)         mcp-kg (8003)
askcos · aizynth   starlims (8014)          mcp-embedder (8004)
chemprop · xtb     waters-empower (8015)    mcp-tabicl (8005)
admetlab · sirius                           mcp-doc-fetcher (8006)

     │ all MCP calls route through
     ▼
LiteLLM gateway + PII redactor  →  Anthropic / OpenAI / ...

Data layer (unchanged):
  Postgres canonical → NOTIFY → projectors → Neo4j / pgvector
  chunk_embedder · reaction_vectorizer · kg_experiments
  kg_hypotheses · contextual_chunker · kg_source_cache
```

## Quickstart

```bash
cp .env.example .env
make setup          # one-time — .venv + node deps
make up             # Postgres + Neo4j
make db.seed        # sample projects + dev user

# In separate terminals:
make run.agent      # agent-claw on http://localhost:3101
make run.frontend   # Streamlit on http://localhost:8501
```

### Slash commands

| Verb | What it does |
|---|---|
| `/help` | List all verbs |
| `/skills` | Show available skill packs |
| `/plan <Q>` | Preview a multi-step plan before execution |
| `/route <SMILES>` | Retrosynthesis via ASKCOS or AiZynthFinder |
| `/screen <SMILES>` | ADMET screen + multi-step plan via PTC |
| `/dr <question>` | Deep research — KG traversal + report composition |
| `/feedback up\|down "<reason>"` | Send feedback on the last turn |
| `/eval` | Run the chemistry golden set for ad-hoc regression |
| `/learn` | Persist the last successful turn as a new skill |
| `/forged list` | Show forged tools catalog |

### With source systems (requires credentials in .env)

```bash
make up.full   # all services + sources profile
# Then in chat:
# "query ELN entries for project proj_001"
# "fetch HPLC run run_W001 and show purity"
```

## Test counts (v1.0.0-claw)

```
cd services/agent-claw && npm test          → 634 passed
python3 -m pytest services/mcp_tools/      → 47+ passed (chemistry) + 29 (new sources)
python3 -m pytest services/projectors/kg_source_cache/tests/ → 7 passed
```

## Further reading

- Harness redesign plan: `~/.claude/plans/go-through-the-three-vivid-sunset.md`
- ADR 004 — Harness engineering: [docs/adr/004-harness-engineering.md](docs/adr/004-harness-engineering.md)
- ADR 005 — Data layer revision: [docs/adr/005-data-layer-revision.md](docs/adr/005-data-layer-revision.md)
- Rollback runbook: [docs/runbooks/harness-rollback.md](docs/runbooks/harness-rollback.md)
- Local development: [docs/runbooks/local-dev.md](docs/runbooks/local-dev.md)
- Architecture Decision Record: [docs/adr/001-architecture.md](docs/adr/001-architecture.md)
- Instrument adapter template: [services/mcp_tools/mcp_instrument_template/README.md](services/mcp_tools/mcp_instrument_template/README.md)

## License

MIT — see [LICENSE](./LICENSE).
