# ChemClaw

**Autonomous Knowledge Intelligence Agent for chemical & analytical development.**

ChemClaw ingests heterogeneous scientific data (ELN entries, analytical
results, SOPs, project reports), maintains a **bi-temporal knowledge graph**
with confidence-scored edges and contradiction handling, and serves
scientists through a chat UI with deep-research and cross-project-learning
modes. It is designed to **act proactively** — new data triggers
investigation, correlation discovery, and outbound notifications — and to
**use scientific tools autonomously** (RDKit, DFT, GFN2-xTB, TabPFN, etc.).

## Status

Phase 0 — infrastructure skeleton. The local stack brings up Postgres (with
pgvector + pgvectorscale), Neo4j (for Graphiti-based bi-temporal KG), a
TypeScript/Fastify agent service, and a Streamlit frontend. An ELN JSON
importer writes canonical records into Postgres and emits events for
downstream projectors.

See the full implementation plan at
`~/.claude/plans/chemos-knowledge-intelligence-tranquil-marshmallow.md`.

## Architecture (one-line summary)

```
Streamlit  →  Fastify/Mastra agent  →  MCP tool servers (Python)
                    │                          ├── Graphiti/Neo4j KG
                    └── LiteLLM (+redactor)    ├── RDKit, DRFP, DFT, etc.
                          │                    └── (Phase 2+)
                          ↓
                     External LLM APIs

                Postgres (app DB + pgvector + event log)
                          ↑
             ELN JSON importer · SMB scraper · KG projector
```

- **Orchestration**: Paperclip (MIT, Node.js) — issues, approvals, budgets,
  heartbeats.
- **Agent runtime**: Mastra (TypeScript) — autonomous ReAct loop; tools
  registered; model controls flow.
- **Durable execution**: Temporal.io (for long-horizon investigations).
- **Data**: Postgres + pgvector + pgvectorscale; Neo4j Community + Graphiti.
- **Scientific tools**: Python MCP servers (RDKit, Marker, ChemDataExtractor,
  DRFP, xtb, PySCF, TabPFN, Chemprop, AiZynthFinder, NMR/MS parsers).
- **UI**: Streamlit — chat, KG explorer, feedback widgets, admin dashboard.
- **Egress**: LiteLLM proxy with a PII/IP redactor plugin; single outbound
  path for LLM inference.
- **Deployment target**: OpenShift via Helm (infra/helm/).

## Quickstart

```bash
cp .env.example .env
make setup      # one-time — .venv + node deps
make up         # Postgres + Neo4j
make db.seed    # sample projects + dev user access
source .venv/bin/activate
make import.sample

# In separate terminals:
make run.agent      # http://localhost:3100
make run.frontend   # http://localhost:8501
```

Full step-by-step: [docs/runbooks/local-dev.md](docs/runbooks/local-dev.md).

## License

MIT — see [LICENSE](./LICENSE).

## Further reading

- Full architectural spec: `~/.claude/plans/chemos-knowledge-intelligence-tranquil-marshmallow.md`
- Local development runbook: [docs/runbooks/local-dev.md](docs/runbooks/local-dev.md)
- Architecture Decision Record: [docs/adr/001-architecture.md](docs/adr/001-architecture.md)
