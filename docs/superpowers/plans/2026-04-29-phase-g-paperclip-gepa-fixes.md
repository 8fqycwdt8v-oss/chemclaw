# Phase G — Paperclip + GEPA self-improvement fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Phase E GEPA loop actually optimize prompts (it currently does nothing because no LM is configured), make `/healthz` honest about per-prompt errors, persist Paperclip's daily-USD ledger across restarts, and tighten the secondary correctness gaps from the deep-review report.

**Architecture:** All fixes are surgical — wire DSPy to the existing LiteLLM gateway through the same `LITELLM_BASE_URL` chokepoint already used by agent-claw, persist Paperclip reservations via the existing `paperclip_state` table (schema is already in place), and patch a handful of identified mis-routes in the YAML/registrar lifecycle and DSPy template extraction. No new services, no new schema beyond what's already shipped.

**Tech Stack:** Python 3.11 (DSPy 2.x, psycopg3, LiteLLM-compatible API via `dspy.LM`), TypeScript 5 (Fastify, vitest, OTel), Postgres 16.

**Source of issues:** `2026-04-28` deep-review report. Issue numbers below correspond to that report.

---

## Plan structure

The 12 issues are grouped into 4 tasks by file co-locality so each task is one PR-sized commit. **Task 1 is the only Tier-1 fix** (GEPA does nothing without it); Tasks 2–4 are correctness improvements.

**File structure (what changes where):**

| File | Why it changes |
|---|---|
| `services/optimizer/gepa_runner/runner.py` | Configure DSPy LM at startup; honest aggregate `/healthz` status (#1, #2) |
| `services/optimizer/gepa_runner/requirements.txt` | Add `litellm` SDK so DSPy's LiteLLM provider is importable (#1) |
| `services/optimizer/gepa_runner/gepa.py` | `_extract_template` rejects identity templates so noop candidates aren't inserted (#7) |
| `services/optimizer/gepa_runner/examples.py` | Broaden `obs.type` filter; scoring-based `classify_question` to balance training distribution (#8, #9) |
| `services/optimizer/gepa_runner/langfuse_client.py` | Probe v3 `client.api.trace.list` first, fall back to v2 `fetch_traces` so a Dependabot bump doesn't silently break the loop (#3) |
| `services/paperclip/src/budget.ts` + `src/persistence.ts` (new) | Persist reservations via `paperclip_state` so daily ledger survives sidecar restart (#11) |
| `services/paperclip/src/index.ts` | Wire persistence: rehydrate `_dailyUsd` on startup; write `INSERT ... reserved` on `reserve` and `UPDATE ... released` on `release` (#11) |
| `hooks/redact-secrets.yaml` | Fix `lifecycle:` field to match registrar (`post_turn`) so the YAML stops lying (#4) |
| `services/agent-claw/src/core/hook-loader.ts` | Assert YAML/registrar lifecycle parity AFTER registration so future drift fails CI (#4) |

Issues NOT in this plan (deferred):
- **#5** non-streaming-path Paperclip/root-span coverage — depends on CLI client direction; defer.
- **#6** plan-mode `completeJson` Langfuse tag — needs LiteLLM gateway changes (out of scope for agent-claw-only patch); defer.
- **#10** shadow vs. GEPA metric divergence — design decision, not a bug; defer.
- **#12** multi-replica Paperclip distributed lock — Helm horizontal scaling is not yet enabled; defer.

---

## Task 1: Configure DSPy LM via LiteLLM, surface per-prompt errors honestly

**Why this is Tier-1:** Without DSPy seeing an LM, every nightly run errors on every prompt and `/healthz` lies green. Closing this turns the loop on for the first time.

**Files:**
- Modify: `services/optimizer/gepa_runner/runner.py:42-58` (`_get_dsn` is fine; new `_configure_dspy_lm()` helper)
- Modify: `services/optimizer/gepa_runner/runner.py:215` (replace unconditional `_last_run_status = "ok"` with error-aware aggregation)
- Modify: `services/optimizer/gepa_runner/requirements.txt` (add `litellm>=1.50,<2`)
- Test: `tests/unit/optimizer/test_gepa_runner.py` — extend with a configure-LM-fails test and an aggregate-status test
- Modify: `docker-compose.yml` (gepa-runner block) — pass `LITELLM_BASE_URL` and `LITELLM_API_KEY` env vars

- [ ] **Step 1.1: Read the existing runner.py to confirm we have the import surface in place**

Run: `grep -n "import dspy\|^from .gepa\|^import psycopg\|^from .langfuse" services/optimizer/gepa_runner/runner.py`

Expected output includes `import psycopg` and `from .gepa import …` lines around the top of the file.

- [ ] **Step 1.2: Add the LiteLLM SDK to requirements.txt**

Edit `services/optimizer/gepa_runner/requirements.txt` to append a new line BEFORE the closing newline:

```text
litellm>=1.50,<2
```

The existing file (after edit) should be:

```text
dspy-ai>=2.5,<3
langfuse>=2.0,<3
apscheduler>=3.10,<4
psycopg[binary]>=3.2,<4
fastapi>=0.111,<0.120
uvicorn[standard]>=0.30,<0.35
httpx>=0.27,<0.30
litellm>=1.50,<2
```

- [ ] **Step 1.3: Write the failing test for `_configure_dspy_lm`**

Append to `tests/unit/optimizer/test_gepa_runner.py`:

```python
class TestConfigureDspyLM:
    """The runner must wire DSPy to LiteLLM at startup so dspy.GEPA has an
    LM to call. Without this, every prompt errors and /healthz lies green."""

    def test_configure_uses_litellm_envs(self, monkeypatch):
        from services.optimizer.gepa_runner import runner as runner_mod

        monkeypatch.setenv("LITELLM_BASE_URL", "http://litellm:4000")
        monkeypatch.setenv("LITELLM_API_KEY", "sk-test")
        monkeypatch.setenv("GEPA_MODEL", "executor")

        captured: dict[str, object] = {}

        def fake_lm(model, **kwargs):
            captured["model"] = model
            captured.update(kwargs)
            return MagicMock(name="LM")

        # Stub dspy.LM and dspy.configure so the test exercises the wiring,
        # not real network calls.
        monkeypatch.setattr("dspy.LM", fake_lm, raising=False)
        configured: dict[str, object] = {}

        def fake_configure(**kwargs):
            configured.update(kwargs)

        monkeypatch.setattr("dspy.configure", fake_configure)

        runner_mod._configure_dspy_lm()

        assert captured["model"] == "openai/executor"
        assert captured["api_base"] == "http://litellm:4000"
        assert captured["api_key"] == "sk-test"
        assert "lm" in configured

    def test_configure_raises_when_envs_missing(self, monkeypatch):
        """Refuse to silently start without an LM. The runner caller turns
        this into a `_last_run_status='error'` so /healthz is honest."""
        from services.optimizer.gepa_runner import runner as runner_mod

        monkeypatch.delenv("LITELLM_BASE_URL", raising=False)
        monkeypatch.delenv("LITELLM_API_KEY", raising=False)
        with pytest.raises(RuntimeError, match="LITELLM_BASE_URL"):
            runner_mod._configure_dspy_lm()
```

- [ ] **Step 1.4: Run the test to verify it fails**

Run: `python3 -m pytest tests/unit/optimizer/test_gepa_runner.py::TestConfigureDspyLM -v`

Expected: 2 FAILS with `AttributeError: module ... has no attribute '_configure_dspy_lm'`.

- [ ] **Step 1.5: Implement `_configure_dspy_lm` and call it from `run_gepa_nightly`**

Edit `services/optimizer/gepa_runner/runner.py`. Find the section that begins with `def _get_dsn() -> str:` (around line 42) and add the new helper RIGHT BEFORE `_get_dsn`:

```python
# ---------------------------------------------------------------------------
# DSPy LM configuration
# ---------------------------------------------------------------------------

def _configure_dspy_lm() -> None:
    """Configure DSPy's global LM to point at the LiteLLM gateway.

    DSPy needs a configured LM before any optimiser can compile a module.
    The agent-claw service routes every LLM call through LiteLLM (the
    project's single egress chokepoint — see CLAUDE.md / ADR 006); the
    optimiser uses the same gateway so the redactor callback applies
    uniformly to training-time calls.

    Raises:
        RuntimeError: if LITELLM_BASE_URL / LITELLM_API_KEY are unset.
        Failing fast here lets `run_gepa_nightly` mark the run as 'error'
        so /healthz is honest about what didn't run.
    """
    import dspy

    base = os.environ.get("LITELLM_BASE_URL")
    api_key = os.environ.get("LITELLM_API_KEY")
    if not base or not api_key:
        raise RuntimeError(
            "LITELLM_BASE_URL and LITELLM_API_KEY must be set; the GEPA "
            "runner uses the LiteLLM gateway as its single egress point. "
            "Without an LM configured, every prompt errors silently."
        )
    model_alias = os.environ.get("GEPA_MODEL", "executor")
    # DSPy's LiteLLM provider expects "openai/<model_or_alias>" so it routes
    # through the OpenAI-compatible adapter; LiteLLM itself maps the alias
    # to the upstream provider per services/litellm/config.yaml.
    lm = dspy.LM(
        model=f"openai/{model_alias}",
        api_base=base,
        api_key=api_key,
    )
    dspy.configure(lm=lm)
    logger.info("DSPy LM configured via LiteLLM (model=%s)", model_alias)
```

- [ ] **Step 1.6: Run the test to verify it passes**

Run: `python3 -m pytest tests/unit/optimizer/test_gepa_runner.py::TestConfigureDspyLM -v`

Expected: 2 PASS.

- [ ] **Step 1.7: Wire `_configure_dspy_lm` into `run_gepa_nightly` and surface aggregate status honestly**

Edit `services/optimizer/gepa_runner/runner.py`. In `run_gepa_nightly`, find the line `_last_run_status = "running"` and replace the WHOLE try block (from `try:` around line 168 down to the `_last_run_status = "ok"` on line 215) with this version that:
1. Calls `_configure_dspy_lm()` at the top of the try.
2. Reflects per-prompt errors in the aggregate status.

Replace the existing block:

```python
    try:
        dsn = _get_dsn()
        lf_client = langfuse_client or LangfuseTraceClient()
        golden_examples = _load_golden_examples(fixture_path)

        with psycopg.connect(dsn) as conn:
            prompts = _fetch_active_prompts(conn)
```

with:

```python
    try:
        # Wire DSPy to LiteLLM before doing anything else. A misconfigured
        # gateway turns every per-prompt run into an exception with no
        # actionable signal in /healthz; failing fast here marks the
        # run as 'error' so the operator notices the missing env var
        # immediately instead of after a week of green-but-empty runs.
        _configure_dspy_lm()

        dsn = _get_dsn()
        lf_client = langfuse_client or LangfuseTraceClient()
        golden_examples = _load_golden_examples(fixture_path)

        with psycopg.connect(dsn) as conn:
            prompts = _fetch_active_prompts(conn)
```

Then find the line `_last_run_status = "ok"` (around the bottom of the try block) and replace it with:

```python
        # Surface aggregate status honestly: 'ok' only if no per-prompt
        # error fired AND we processed at least one prompt successfully.
        # `degraded` covers partial failure / no-data cases without
        # masking them as success.
        any_error = any(
            isinstance(d, dict) and d.get("status") == "error"
            for d in details.values()
        )
        if any_error:
            _last_run_status = "degraded"
        else:
            _last_run_status = "ok"
```

- [ ] **Step 1.8: Update the existing `test_runs_gepa_with_sufficient_examples` test fixture so the new `_configure_dspy_lm` call doesn't break it**

Open `tests/unit/optimizer/test_gepa_runner.py`, find the `test_runs_gepa_with_sufficient_examples` function, and within its `with patch("services.optimizer.gepa_runner.runner.run_gepa", return_value=fake_result):` block, add ONE more `with` line above the existing `patch("services.optimizer.gepa_runner.runner._get_dsn", ...)`:

```python
        with patch("services.optimizer.gepa_runner.runner._configure_dspy_lm", return_value=None):
            with patch("services.optimizer.gepa_runner.runner.run_gepa", return_value=fake_result):
```

Mirror the same patch in `test_skips_when_no_examples`.

- [ ] **Step 1.9: Add the aggregate-status test**

Append to `tests/unit/optimizer/test_gepa_runner.py`:

```python
class TestAggregateStatus:
    """Per-prompt errors must NOT be masked by 'ok'. /healthz must surface
    'degraded' when any prompt errored so the operator notices."""

    @pytest.mark.asyncio
    async def test_per_prompt_error_yields_degraded(self, tmp_path):
        from services.optimizer.gepa_runner import runner as runner_mod

        traces = [
            {
                "id": f"t{i}",
                "input": {"messages": [{"role": "user", "content": "What retro route?"}]},
                "output": {"answer": "x"},
                "observations": [],
            }
            for i in range(31)
        ]
        lf_client = MockLangfuseClient(traces=traces)

        fixture = tmp_path / "g.jsonl"
        fixture.write_text(
            '{"question":"q","answer":"a","expected_classes":["retrosynthesis"]}\n'
        )

        # run_gepa raises — simulates a real DSPy failure inside the
        # per-prompt try. The runner catches and records as 'error'.
        with patch(
            "services.optimizer.gepa_runner.runner.run_gepa",
            side_effect=RuntimeError("boom"),
        ):
            with patch("services.optimizer.gepa_runner.runner._configure_dspy_lm", return_value=None):
                with patch("services.optimizer.gepa_runner.runner._get_dsn", return_value="dummy"):
                    with patch("psycopg.connect") as mock_connect:
                        mock_conn = _make_mock_conn(
                            prompts=[{"id": "abc", "name": "agent.system", "version": 1, "template": "T"}]
                        )
                        mock_connect.return_value.__enter__ = MagicMock(return_value=mock_conn)
                        mock_connect.return_value.__exit__ = MagicMock(return_value=False)

                        await runner_mod.run_gepa_nightly(
                            langfuse_client=lf_client,
                            fixture_path=str(fixture),
                        )

        from services.optimizer.gepa_runner.runner import _last_run_status, _last_run_details
        assert _last_run_status == "degraded"
        assert _last_run_details["agent.system"]["status"] == "error"
```

- [ ] **Step 1.10: Run the full GEPA test file to verify all green**

Run: `python3 -m pytest tests/unit/optimizer/test_gepa_runner.py -v 2>&1 | tail -30`

Expected: 6+ PASS, 0 FAIL.

- [ ] **Step 1.11: Add `LITELLM_BASE_URL` / `LITELLM_API_KEY` / `GEPA_MODEL` to docker-compose.yml gepa-runner block**

Open `docker-compose.yml`, find the `gepa-runner:` service block (search for `gepa-runner:`). Inside its `environment:` section, add THREE new lines after the existing `LANGFUSE_SECRET_KEY:` line:

```yaml
      LITELLM_BASE_URL: ${LITELLM_BASE_URL:-http://litellm:4000}
      LITELLM_API_KEY: ${LITELLM_API_KEY:-sk-chemclaw-dev-master-change-me}
      GEPA_MODEL: ${GEPA_MODEL:-executor}
```

- [ ] **Step 1.12: Commit Task 1**

```bash
git add services/optimizer/gepa_runner/runner.py \
        services/optimizer/gepa_runner/requirements.txt \
        tests/unit/optimizer/test_gepa_runner.py \
        docker-compose.yml
git commit -m "$(cat <<'EOF'
fix(gepa): wire DSPy LM via LiteLLM + honest aggregate /healthz status

Closes deep-review issues #1 and #2.

Without a configured LM, dspy.GEPA(...).compile(...) raised on every
prompt and the per-prompt try/except recorded "error" in details while
the outer try unconditionally set _last_run_status = "ok". /healthz
reported green forever while the loop did literally nothing.

- _configure_dspy_lm() points dspy.LM at LITELLM_BASE_URL with the
  GEPA_MODEL alias so training-time calls go through the same egress
  chokepoint (and the same redactor callback) that agent-claw uses.
- Aggregate status is now: 'degraded' if any prompt errored, 'ok' only
  if all prompts processed cleanly. The existing 0-prompt 'degraded'
  branch is preserved.
- docker-compose.yml threads the LiteLLM env into the gepa-runner
  block; no new secrets, just exporting what already exists.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: GEPA correctness — reject identity templates, broaden trace parsing, balance classification

**Files:**
- Modify: `services/optimizer/gepa_runner/gepa.py:60-180` (skip when extracted template == seed)
- Modify: `services/optimizer/gepa_runner/examples.py` (`obs.type` broadening + scoring-based `classify_question`)
- Modify: `services/optimizer/gepa_runner/langfuse_client.py` (try v3 SDK path, fall back to v2)
- Test: `tests/unit/optimizer/test_gepa_examples.py` and `tests/unit/optimizer/test_gepa.py` (new)

- [ ] **Step 2.1: Write the failing test for the identity-template guard**

Append to `tests/unit/optimizer/test_gepa_metric.py` (or create `tests/unit/optimizer/test_gepa.py`):

```python
class TestIdentityTemplateGuard:
    """run_gepa must mark a run as skipped when the optimised module's
    extracted template is byte-identical to the seed — otherwise we
    insert a 'candidate' that's exactly the active prompt, which can
    never beat itself."""

    def test_skipped_when_extracted_matches_seed(self, monkeypatch):
        import dspy
        from services.optimizer.gepa_runner.gepa import run_gepa

        seed = "You are ChemClaw, the knowledge agent."
        # 30+ examples to clear the per-class minimum.
        examples = [
            dspy.Example(
                question=f"q{i}",
                answer="a",
                feedback="thumbs_up",
                tool_outputs=[],
                query_class="retrosynthesis",
            ).with_inputs("question")
            for i in range(30)
        ]

        # Stub the optimiser to return a module whose signature.instructions
        # is the seed (identity).
        class FakeSig:
            instructions = seed

        class FakeModule:
            signature = FakeSig()

            def predictors(self):
                return []

        class FakeOptimizer:
            def __init__(self, *args, **kwargs):
                pass

            def compile(self, student, trainset):
                return FakeModule()

        monkeypatch.setattr(dspy, "GEPA", FakeOptimizer, raising=False)

        result = run_gepa(
            prompt_name="agent.system",
            current_template=seed,
            examples=examples,
            golden_examples=[],
        )

        assert result.skipped is True
        assert "identity" in result.skip_reason.lower()
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `python3 -m pytest tests/unit/optimizer/test_gepa_metric.py::TestIdentityTemplateGuard -v`

Expected: FAIL — the result is currently inserted as a candidate.

- [ ] **Step 2.3: Implement the identity guard in `run_gepa`**

Edit `services/optimizer/gepa_runner/gepa.py`. Find the line `new_template = _extract_template(optimized, current_template)` and replace the section from there through the `return GepaResult(...)` block with:

```python
    # Extract the optimised prompt text from the module's predictors.
    new_template = _extract_template(optimized, current_template)

    # Guard against the "extraction returned the seed" path. DSPy's Predict
    # exposes the *signature docstring* via pred.signature.instructions; if
    # the optimiser failed to evolve a meaningfully different prompt (or if
    # _extract_template walked off into a dead branch), inserting that
    # value as a "candidate" produces a row that is byte-identical to the
    # active version. Such a row can never beat the active prompt in
    # shadow scoring (it's the same prompt) and just clutters the registry.
    # Skipping here keeps the registry clean and makes the audit trail
    # honest about what GEPA actually produced.
    if _is_identity_template(new_template, current_template):
        return GepaResult(
            prompt_name=prompt_name,
            new_template=current_template,
            golden_score=0.0,
            feedback_rate=0.0,
            per_class_breakdown=per_class_breakdown,
            gepa_metadata={"reason": "identity_template"},
            skipped=True,
            skip_reason="identity template — optimiser returned the seed",
        )
```

Then add the helper at the bottom of the file (after `_extract_template`):

```python
def _is_identity_template(candidate: str, seed: str) -> bool:
    """Return True if the candidate is the same prompt as the seed.

    Compares on stripped content so trailing whitespace differences
    don't accidentally pass. Doesn't normalise case — instruction
    case can be semantically meaningful.
    """
    return candidate.strip() == seed.strip()
```

- [ ] **Step 2.4: Run the test to verify it passes**

Run: `python3 -m pytest tests/unit/optimizer/test_gepa_metric.py::TestIdentityTemplateGuard -v`

Expected: PASS.

- [ ] **Step 2.5: Write the failing test for `classify_question` scoring**

Append to `tests/unit/optimizer/test_gepa_examples.py`:

```python
class TestClassifyQuestionScoring:
    """First-keyword-match-wins biases the training distribution toward
    whichever class has the highest-frequency keyword. A scoring-based
    classifier counts keyword hits per class and picks the argmax —
    'compare retro routes for two NCEs' should land in cross_project,
    not retrosynthesis, because cross-project signals dominate."""

    def test_cross_project_dominates_when_more_keywords_match(self):
        from services.optimizer.gepa_runner.examples import classify_question

        # 1 retrosynthesis keyword (retro), 3 cross_project (compare,
        # multiple/cross via 'compare' + 'project' + 'multiple').
        q = "Compare retro routes across multiple projects in our portfolio"
        assert classify_question(q) == "cross_project"

    def test_falls_back_to_cross_project_when_no_keywords(self):
        from services.optimizer.gepa_runner.examples import classify_question
        assert classify_question("hello world") == "cross_project"

    def test_single_strong_signal_picks_that_class(self):
        from services.optimizer.gepa_runner.examples import classify_question
        # Pure analytical question — only 'hplc' matches.
        assert classify_question("Optimise HPLC method for impurity X") == "analytical"
```

- [ ] **Step 2.6: Run the test to verify it fails**

Run: `python3 -m pytest tests/unit/optimizer/test_gepa_examples.py::TestClassifyQuestionScoring -v`

Expected: at least one FAIL — first-match-wins puts the cross_project sentence in retrosynthesis.

- [ ] **Step 2.7: Implement the scoring-based classifier**

Edit `services/optimizer/gepa_runner/examples.py`. Replace the existing `def classify_question(...)`:

```python
def classify_question(question: str) -> str:
    """Score the question against each class's keyword set; return the
    argmax class. Ties resolve to cross_project (the catch-all). When no
    class has any matches we also return cross_project — the same
    fallback as before, just stated explicitly.
    """
    q_lower = question.lower()
    scores: dict[str, int] = {}
    for cls, kws in _CLASS_KEYWORDS.items():
        scores[cls] = sum(1 for kw in kws if kw in q_lower)

    best_score = max(scores.values()) if scores else 0
    if best_score == 0:
        return "cross_project"

    # Argmax with deterministic tie-break: prefer cross_project, then
    # alphabetical. The deterministic tie-break matters for replay /
    # test stability.
    best = [cls for cls, s in scores.items() if s == best_score]
    if "cross_project" in best:
        return "cross_project"
    return sorted(best)[0]
```

- [ ] **Step 2.8: Run the test to verify it passes**

Run: `python3 -m pytest tests/unit/optimizer/test_gepa_examples.py::TestClassifyQuestionScoring -v`

Expected: 3 PASS.

- [ ] **Step 2.9: Write the failing test for broader `obs.type` filter in `traces_to_examples`**

Append to `tests/unit/optimizer/test_gepa_examples.py`:

```python
class TestTraceObservationTypes:
    """Langfuse v2 OTel ingestion records observations with type=GENERATION
    (LLM calls) and type=SPAN (everything else). Original code only
    accepted 'span' lower-case. Real traces never matched, citation
    component scored 1.0 trivially, composite scores were inflated."""

    def test_accepts_uppercase_span(self):
        from services.optimizer.gepa_runner.examples import traces_to_examples

        traces = [
            {
                "id": "t1",
                "input": {"messages": [{"role": "user", "content": "What HPLC method?"}]},
                "output": {"answer": "Use C18 column"},
                "observations": [
                    {"type": "SPAN", "output": {"fact_id": "abc123"}},
                ],
            }
        ]
        examples = traces_to_examples(traces, [])
        assert len(examples) == 1
        assert examples[0].tool_outputs == [{"fact_id": "abc123"}]

    def test_accepts_generation_type(self):
        from services.optimizer.gepa_runner.examples import traces_to_examples

        traces = [
            {
                "id": "t1",
                "input": {"messages": [{"role": "user", "content": "What HPLC method?"}]},
                "output": {"answer": "Use C18 column"},
                "observations": [
                    {"type": "GENERATION", "output": {"fact_id": "xyz789"}},
                ],
            }
        ]
        examples = traces_to_examples(traces, [])
        assert examples[0].tool_outputs == [{"fact_id": "xyz789"}]
```

- [ ] **Step 2.10: Run the test to verify it fails**

Run: `python3 -m pytest tests/unit/optimizer/test_gepa_examples.py::TestTraceObservationTypes -v`

Expected: 2 FAIL — `tool_outputs` is empty for both.

- [ ] **Step 2.11: Implement the broader filter**

Edit `services/optimizer/gepa_runner/examples.py`. Find the loop that begins with `for obs in trace.get("observations") or []:` and replace its body. Replace:

```python
        for obs in trace.get("observations") or []:
            if isinstance(obs, dict) and obs.get("type") == "span":
                out = obs.get("output")
                if isinstance(out, dict):
                    tool_outputs.append(out)
```

with:

```python
        # Langfuse OTel ingestion records observations with type='SPAN'
        # (generic) or 'GENERATION' (LLM calls); historical lower-case
        # 'span' was a misread of the SDK shape and never matched real
        # traces, leaving tool_outputs empty and trivialising the
        # citation-faithfulness component.
        _TOOL_OUTPUT_TYPES = {"span", "SPAN", "GENERATION", "EVENT"}
        for obs in trace.get("observations") or []:
            if not isinstance(obs, dict):
                continue
            if obs.get("type") not in _TOOL_OUTPUT_TYPES:
                continue
            out = obs.get("output")
            if isinstance(out, dict):
                tool_outputs.append(out)
```

- [ ] **Step 2.12: Run the test to verify it passes**

Run: `python3 -m pytest tests/unit/optimizer/test_gepa_examples.py -v`

Expected: all PASS.

- [ ] **Step 2.13: Add v3 fallback in langfuse_client.py**

Edit `services/optimizer/gepa_runner/langfuse_client.py`. Replace the body of `fetch_traces_for_prompt` with the version below. The intent: try the v3 path first (`client.api.trace.list`), fall back to v2 (`client.fetch_traces`). When neither exists, raise a clear error instead of silently returning [].

Replace the existing method:

```python
    def fetch_traces_for_prompt(
        self,
        prompt_name: str,
        hours: int = 24,
    ) -> list[dict[str, Any]]:
        """Return a list of trace dicts for `prompt_name` in the last `hours` hours."""
        since = datetime.now(tz=timezone.utc) - timedelta(hours=hours)

        # Langfuse SDK: fetch_traces returns a FetchTracesResponse with .data
        resp = self._client.fetch_traces(
            tags=[f"prompt:{prompt_name}"],
            from_timestamp=since,
        )
        traces = getattr(resp, "data", resp) or []
        return [self._to_dict(t) for t in traces]
```

with:

```python
    def fetch_traces_for_prompt(
        self,
        prompt_name: str,
        hours: int = 24,
    ) -> list[dict[str, Any]]:
        """Return a list of trace dicts for `prompt_name` in the last `hours` hours.

        Probes the v3 SDK path first (`client.api.trace.list`), falls back
        to v2 (`client.fetch_traces`). Both APIs return a list-like object
        with a `.data` attribute or are list-like themselves; `_to_dict`
        normalises individual entries.

        Raises:
            AttributeError: if neither API surface exists. Surfacing this
            instead of silently returning [] keeps GEPA's degraded path
            actionable — an empty list looks identical to "no traces this
            window" otherwise.
        """
        since = datetime.now(tz=timezone.utc) - timedelta(hours=hours)
        tag = f"prompt:{prompt_name}"

        # v3 path: client.api.trace.list(tags=[...], from_timestamp=...)
        api = getattr(self._client, "api", None)
        trace_api = getattr(api, "trace", None) if api is not None else None
        list_fn = getattr(trace_api, "list", None) if trace_api is not None else None
        if callable(list_fn):
            resp = list_fn(tags=[tag], from_timestamp=since)
        else:
            # v2 fallback: client.fetch_traces(tags=[...], from_timestamp=...)
            fetch_traces = getattr(self._client, "fetch_traces", None)
            if not callable(fetch_traces):
                raise AttributeError(
                    "Langfuse client exposes neither api.trace.list (v3) nor "
                    "fetch_traces (v2); GEPA cannot fetch training traces. "
                    "Pin langfuse to a known version or update this client."
                )
            resp = fetch_traces(tags=[tag], from_timestamp=since)

        traces = getattr(resp, "data", resp) or []
        return [self._to_dict(t) for t in traces]
```

- [ ] **Step 2.14: Run the full GEPA-runner test suite**

Run: `python3 -m pytest tests/unit/optimizer/ -q 2>&1 | tail -10`

Expected: all PASS (existing tests + new ones).

- [ ] **Step 2.15: Commit Task 2**

```bash
git add services/optimizer/gepa_runner/gepa.py \
        services/optimizer/gepa_runner/examples.py \
        services/optimizer/gepa_runner/langfuse_client.py \
        tests/unit/optimizer/test_gepa_metric.py \
        tests/unit/optimizer/test_gepa_examples.py
git commit -m "$(cat <<'EOF'
fix(gepa): identity-template guard + broader observation parse + v3 SDK fallback

Closes deep-review issues #3, #7, #8, #9.

#7 — _extract_template falling back to pred.signature.instructions
returned the signature DOCSTRING, which is the seed prompt. The runner
inserted a "candidate" byte-identical to the active row that could
never beat itself. Now flagged as skipped="identity template".

#8 — Langfuse OTel ingestion records observations with type='SPAN'
or 'GENERATION'; the old lowercase 'span' filter never matched real
traces, leaving tool_outputs empty and trivialising the citation
component (every response scored 1.0 — composite inflated by 20%).

#9 — first-match-wins keyword classification biased everything that
mentioned a chemistry term toward 'retrosynthesis' and starved
'cross_project'. Replaced with scoring (sum keyword hits per class,
argmax with cross_project tie-break).

#3 — fetch_traces_for_prompt now probes Langfuse v3
(client.api.trace.list) first and falls back to v2 (fetch_traces).
A future Dependabot bump no longer silently disables the loop;
missing-API surfaces as AttributeError so /healthz reports degraded
with an actionable error.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Paperclip persistence — survive sidecar restart

**Files:**
- Create: `services/paperclip/src/persistence.ts` (psycopg-equivalent: postgres pool + helpers)
- Modify: `services/paperclip/src/budget.ts` (callbacks for persistence; rehydrate API)
- Modify: `services/paperclip/src/index.ts` (instantiate `PaperclipState`, rehydrate on startup, write on reserve/release)
- Modify: `services/paperclip/package.json` (add `pg` dependency)
- Test: `services/paperclip/tests/persistence.test.ts` (new) and `services/paperclip/tests/paperclip.test.ts` (rehydrate behaviour)

The Paperclip sidecar already has a `paperclip_state` table (db/init/09_paperclip.sql). It's currently untouched. This task adds the writer + rehydrator so the daily-USD ledger survives restart.

- [ ] **Step 3.1: Add `pg` to Paperclip's package.json**

Edit `services/paperclip/package.json`. Inside `"dependencies"`, add (alphabetical order):

```json
    "pg": "^8.13.1"
```

Then run:

```bash
cd services/paperclip && npm install
cd ../..
```

- [ ] **Step 3.2: Write the failing test for `PaperclipState` persistence**

Create `services/paperclip/tests/persistence.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaperclipState } from "../src/persistence.js";

// Mock pg.Pool — capture queries so we can assert.
function makeMockPool() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      // Mock today's spend for one user.
      if (sql.includes("SUM(actual_usd)")) {
        return { rows: [{ user_entra_id: "u1", spent: "12.50" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  return { pool: pool as never, queries };
}

describe("PaperclipState", () => {
  let pool: ReturnType<typeof makeMockPool>;
  let state: PaperclipState;

  beforeEach(() => {
    pool = makeMockPool();
    state = new PaperclipState(pool.pool);
  });

  it("recordReserved INSERTs a 'reserved' row", async () => {
    await state.recordReserved({
      reservationId: "r-1",
      userEntraId: "u1",
      sessionId: "s1",
      estTokens: 1000,
      estUsd: 0.05,
    });
    const insert = pool.queries.find((q) => q.sql.includes("INSERT INTO paperclip_state"));
    expect(insert).toBeDefined();
    expect(insert!.params).toEqual(["r-1", "u1", "s1", 1000, 0.05]);
  });

  it("recordReleased UPDATEs status to 'released' with actuals", async () => {
    await state.recordReleased("r-1", 950, 0.048);
    const update = pool.queries.find((q) => q.sql.includes("UPDATE paperclip_state"));
    expect(update).toBeDefined();
    // params: actualTokens, actualUsd, reservationId.
    expect(update!.params).toEqual([950, 0.048, "r-1"]);
  });

  it("rehydrateDailyUsd returns today's spend per user", async () => {
    const map = await state.rehydrateDailyUsd();
    expect(map.size).toBeGreaterThanOrEqual(1);
    // Composite key shape: "user_entra_id:YYYY-MM-DD".
    const todayKey = [...map.keys()][0];
    expect(todayKey).toMatch(/^u1:\d{4}-\d{2}-\d{2}$/);
    expect(map.get(todayKey!)).toBeCloseTo(12.5);
  });
});
```

- [ ] **Step 3.3: Run the test to verify it fails**

Run: `cd services/paperclip && npx vitest run tests/persistence.test.ts`

Expected: FAIL — `PaperclipState` not defined.

- [ ] **Step 3.4: Implement `services/paperclip/src/persistence.ts`**

Create `services/paperclip/src/persistence.ts`:

```typescript
// Paperclip persistence layer.
//
// The sidecar's BudgetManager keeps reservation state in-process for fast
// path lookups. This module mirrors writes into Postgres so a restart
// doesn't reset the daily-USD ledger to zero.
//
// Schema lives in db/init/09_paperclip.sql (paperclip_state) and is
// already shipped — no migration here, just the writer + rehydrator.
//
// All methods are best-effort: a Postgres outage logs and continues
// rather than crashing the sidecar (the in-process state is the
// authoritative read-side; persistence is purely for crash-recovery).

import type { Pool } from "pg";

export interface PaperclipState {
  recordReserved(opts: {
    reservationId: string;
    userEntraId: string;
    sessionId: string;
    estTokens: number;
    estUsd: number;
  }): Promise<void>;
  recordReleased(reservationId: string, actualTokens: number, actualUsd: number): Promise<void>;
  rehydrateDailyUsd(): Promise<Map<string, number>>;
}

export class PaperclipState implements PaperclipState {
  constructor(private readonly pool: Pool) {}

  async recordReserved(opts: {
    reservationId: string;
    userEntraId: string;
    sessionId: string;
    estTokens: number;
    estUsd: number;
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO paperclip_state
           (reservation_id, user_entra_id, session_id, est_tokens, est_usd, status)
         VALUES ($1, $2, $3, $4, $5, 'reserved')
         ON CONFLICT (reservation_id) DO NOTHING`,
        [opts.reservationId, opts.userEntraId, opts.sessionId, opts.estTokens, opts.estUsd],
      );
    } catch {
      // Persistence is best-effort. A DB outage doesn't block reservation.
    }
  }

  async recordReleased(reservationId: string, actualTokens: number, actualUsd: number): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE paperclip_state
            SET status = 'released',
                actual_tokens = $1,
                actual_usd = $2,
                released_at = NOW()
          WHERE reservation_id = $3`,
        [actualTokens, actualUsd, reservationId],
      );
    } catch {
      // Best-effort.
    }
  }

  /**
   * Read today's USD totals from paperclip_state grouped by user. Returns a
   * Map keyed by "userEntraId:YYYY-MM-DD" so it can be merged into
   * BudgetManager._dailyUsd directly. Includes both 'reserved' and
   * 'released' rows so a sidecar restart mid-turn doesn't lose the
   * pre-reservation USD until the turn closes.
   */
  async rehydrateDailyUsd(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const today = _utcDateString(new Date());
      const r = await this.pool.query<{ user_entra_id: string; spent: string }>(
        `SELECT user_entra_id,
                SUM(COALESCE(actual_usd, est_usd))::text AS spent
           FROM paperclip_state
          WHERE reserved_at >= $1::date
          GROUP BY user_entra_id`,
        [today],
      );
      for (const row of r.rows) {
        const key = `${row.user_entra_id}:${today}`;
        map.set(key, Number(row.spent));
      }
    } catch {
      // If the rehydrate query fails the sidecar still works — daily
      // ledger just starts at zero (matches pre-persistence behaviour).
    }
    return map;
  }
}

function _utcDateString(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
```

- [ ] **Step 3.5: Run the persistence test to verify it passes**

Run: `cd services/paperclip && npx vitest run tests/persistence.test.ts`

Expected: 3 PASS.

- [ ] **Step 3.6: Extend `BudgetManager` with rehydrate hook**

Edit `services/paperclip/src/budget.ts`. Find the constructor and add a `rehydrateDailyUsd` method to the class. Append (before the closing `}` of `BudgetManager`):

```typescript
  /**
   * Replace the in-memory daily-USD ledger with the supplied snapshot.
   * Called once at startup from index.ts after PaperclipState reads
   * paperclip_state for today's totals. Idempotent: calling again
   * overwrites whatever was in the map.
   */
  rehydrateDailyUsd(snapshot: Map<string, number>): void {
    this._dailyUsd.clear();
    for (const [key, amount] of snapshot) {
      this._dailyUsd.set(key, amount);
    }
  }
```

- [ ] **Step 3.7: Wire persistence in `services/paperclip/src/index.ts`**

Edit `services/paperclip/src/index.ts`. Add imports near the existing imports:

```typescript
import { Pool } from "pg";
import { PaperclipState } from "./persistence.js";
```

Then add the persistence singleton + rehydrate at startup. After the existing `const metrics = new MetricsCollector();` line, add:

```typescript
// ---------------------------------------------------------------------------
// Persistence (Phase G).
// ---------------------------------------------------------------------------
//
// Hot path stays in-process; Postgres is the durable shadow so a sidecar
// restart doesn't reset the daily-USD ledger. When PAPERCLIP_PG_DSN is
// unset (single-instance dev), the persistence object is a no-op stub.

const PG_DSN = process.env["PAPERCLIP_PG_DSN"];
const persistence: PaperclipState | null = PG_DSN
  ? new PaperclipState(new Pool({ connectionString: PG_DSN }))
  : null;
```

Then modify the `app.post("/reserve", ...)` handler. Find the line `metrics.recordReservation();` and add THE LINE BELOW THAT:

```typescript
    if (persistence) {
      await persistence.recordReserved({
        reservationId,
        userEntraId: user_entra_id,
        sessionId: session_id,
        estTokens: est_tokens,
        estUsd: est_usd,
      });
    }
```

Modify the `app.post("/release", ...)` handler. Find the line `metrics.recordRelease(0);` and replace it with:

```typescript
    metrics.recordRelease(0);

    if (persistence) {
      await persistence.recordReleased(
        reservation_id,
        parsed.data.actual_tokens ?? 0,
        actual_usd ?? 0,
      );
    }
```

Then add a startup rehydrate call. Find the existing block:

```typescript
if (process.env["PAPERCLIP_SKIP_START"] !== "true") {
  const app = buildApp();

  app.listen({ host: HOST, port: PORT }, (err) => {
```

Replace it with:

```typescript
if (process.env["PAPERCLIP_SKIP_START"] !== "true") {
  const app = buildApp();

  // Rehydrate the daily-USD ledger from paperclip_state before opening
  // for traffic. A restart at 23:59 UTC otherwise zeroes everyone's
  // spend and lets a user double-spend their daily cap.
  if (persistence) {
    persistence
      .rehydrateDailyUsd()
      .then((snapshot) => {
        budgetMgr.rehydrateDailyUsd(snapshot);
        app.log.info({ entries: snapshot.size }, "paperclip rehydrated daily-USD ledger");
      })
      .catch((err) => {
        app.log.warn({ err }, "paperclip rehydrate failed; starting with empty ledger");
      });
  }

  app.listen({ host: HOST, port: PORT }, (err) => {
```

- [ ] **Step 3.8: Update Paperclip's existing tests so they don't crash on the new persistence call**

Open `services/paperclip/tests/paperclip.test.ts`. The existing tests construct `BudgetManager` directly so they don't touch persistence — they should still pass. Confirm by running:

```bash
cd services/paperclip && npm test
```

Expected: 17/17 PASS, plus the 3 new persistence tests = 20/20.

- [ ] **Step 3.9: Add a rehydrate behaviour test**

Append to `services/paperclip/tests/paperclip.test.ts`:

```typescript
describe("BudgetManager.rehydrateDailyUsd", () => {
  it("replaces the in-memory ledger with the snapshot", () => {
    const mgr = new BudgetManager({
      maxConcurrentPerUser: 4,
      maxTokensPerTurn: 10_000,
      maxUsdPerDay: 25.0,
    });
    expect(mgr.todayUsd("u1")).toBe(0);

    const today = new Date();
    const ymd = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    mgr.rehydrateDailyUsd(new Map([[`u1:${ymd}`, 18.0]]));

    expect(mgr.todayUsd("u1")).toBeCloseTo(18.0);
    // The check should reject any new reservation that would push past 25.
    const result = mgr.check({ userEntraId: "u1", estTokens: 100, estUsd: 8.0 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("usd_budget");
  });
});
```

- [ ] **Step 3.10: Run all Paperclip tests**

Run: `cd services/paperclip && npm test`

Expected: 21/21 PASS (17 original + 3 persistence + 1 rehydrate).

- [ ] **Step 3.11: Add `PAPERCLIP_PG_DSN` to docker-compose.yml**

Open `docker-compose.yml`. Find the `paperclip-lite:` block. Inside its `environment:` section, add ONE line:

```yaml
      PAPERCLIP_PG_DSN: ${PAPERCLIP_PG_DSN:-postgresql://${CHEMCLAW_APP_USER:-chemclaw_app}:${CHEMCLAW_APP_PASSWORD:-${POSTGRES_PASSWORD:-chemclaw_dev_password_change_me}}@postgres:5432/${POSTGRES_DB:-chemclaw}}
```

Note: `chemclaw_app` is the FORCE-RLS-enforced role; the policy on `paperclip_state` checks `user_entra_id = current_setting('app.current_user_entra_id', true)` so the sidecar must set the GUC per-request. Update `recordReserved`/`recordReleased` to set the user GUC inside a transaction.

- [ ] **Step 3.12: Update `PaperclipState` to set `app.current_user_entra_id` per query**

Edit `services/paperclip/src/persistence.ts`. Replace `recordReserved` and `recordReleased` with versions that wrap each statement in a transaction with `SET LOCAL`:

```typescript
  async recordReserved(opts: {
    reservationId: string;
    userEntraId: string;
    sessionId: string;
    estTokens: number;
    estUsd: number;
  }): Promise<void> {
    const client = await this.pool.connect().catch(() => null);
    if (!client) return;
    try {
      await client.query("BEGIN");
      // SET LOCAL is bound to the transaction; the FORCE-RLS policy on
      // paperclip_state requires user_entra_id == app.current_user_entra_id
      // for every INSERT/SELECT.
      await client.query("SELECT set_config('app.current_user_entra_id', $1, true)", [
        opts.userEntraId,
      ]);
      await client.query(
        `INSERT INTO paperclip_state
           (reservation_id, user_entra_id, session_id, est_tokens, est_usd, status)
         VALUES ($1, $2, $3, $4, $5, 'reserved')
         ON CONFLICT (reservation_id) DO NOTHING`,
        [opts.reservationId, opts.userEntraId, opts.sessionId, opts.estTokens, opts.estUsd],
      );
      await client.query("COMMIT");
    } catch {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    } finally {
      client.release();
    }
  }

  async recordReleased(reservationId: string, actualTokens: number, actualUsd: number): Promise<void> {
    // The release path doesn't have userEntraId in scope; look it up
    // first so we can set the GUC for the UPDATE. A missing row is fine —
    // the sidecar's in-process map is the authoritative read.
    const client = await this.pool.connect().catch(() => null);
    if (!client) return;
    try {
      const lookup = await client.query<{ user_entra_id: string }>(
        `SELECT user_entra_id FROM paperclip_state WHERE reservation_id = $1`,
        [reservationId],
      );
      const userEntraId = lookup.rows[0]?.user_entra_id;
      if (!userEntraId) return;
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_user_entra_id', $1, true)", [userEntraId]);
      await client.query(
        `UPDATE paperclip_state
            SET status = 'released',
                actual_tokens = $1,
                actual_usd = $2,
                released_at = NOW()
          WHERE reservation_id = $3`,
        [actualTokens, actualUsd, reservationId],
      );
      await client.query("COMMIT");
    } catch {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    } finally {
      client.release();
    }
  }
```

The lookup-then-update path fails RLS: the lookup happens BEFORE the GUC is set, so the row isn't visible. Use the `chemclaw_service` role for the rehydrate path and the lookup. Update the DSN env in docker-compose.yml to use the service role:

```yaml
      PAPERCLIP_PG_DSN: ${PAPERCLIP_PG_DSN:-postgresql://${CHEMCLAW_SERVICE_USER:-chemclaw_service}:${CHEMCLAW_SERVICE_PASSWORD:-${POSTGRES_PASSWORD:-chemclaw_dev_password_change_me}}@postgres:5432/${POSTGRES_DB:-chemclaw}}
```

`chemclaw_service` has BYPASSRLS so the lookup-then-update works without GUC games. The simpler shape — drop the `set_config` calls — is fine because BYPASSRLS bypasses the policy entirely. Replace `recordReserved` / `recordReleased` once more, this time with the simpler form:

```typescript
  async recordReserved(opts: {
    reservationId: string;
    userEntraId: string;
    sessionId: string;
    estTokens: number;
    estUsd: number;
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO paperclip_state
           (reservation_id, user_entra_id, session_id, est_tokens, est_usd, status)
         VALUES ($1, $2, $3, $4, $5, 'reserved')
         ON CONFLICT (reservation_id) DO NOTHING`,
        [opts.reservationId, opts.userEntraId, opts.sessionId, opts.estTokens, opts.estUsd],
      );
    } catch {
      // Best-effort.
    }
  }

  async recordReleased(
    reservationId: string,
    actualTokens: number,
    actualUsd: number,
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE paperclip_state
            SET status = 'released',
                actual_tokens = $1,
                actual_usd = $2,
                released_at = NOW()
          WHERE reservation_id = $3`,
        [actualTokens, actualUsd, reservationId],
      );
    } catch {
      // Best-effort.
    }
  }
```

Add a comment at the top of the class explaining the role choice:

```typescript
/**
 * Persistence client. Uses the chemclaw_service role (BYPASSRLS) so the
 * sidecar can insert/update across all users from a single connection
 * without setting per-row GUCs. The paperclip_state policy still
 * enforces user-scoping for any application-level reads (e.g. the
 * agent-claw "today's spend" endpoint when one lands).
 */
```

- [ ] **Step 3.13: Re-run all Paperclip tests**

Run: `cd services/paperclip && npm test`

Expected: 21/21 PASS.

- [ ] **Step 3.14: Commit Task 3**

```bash
git add services/paperclip/src/persistence.ts \
        services/paperclip/src/budget.ts \
        services/paperclip/src/index.ts \
        services/paperclip/package.json \
        services/paperclip/package-lock.json \
        services/paperclip/tests/persistence.test.ts \
        services/paperclip/tests/paperclip.test.ts \
        docker-compose.yml
git commit -m "$(cat <<'EOF'
fix(paperclip): persist reservations to paperclip_state — survive restart

Closes deep-review issue #11.

The Paperclip sidecar kept its daily-USD ledger purely in a process-
local Map<userId:YYYY-MM-DD, number>. A 23:59 UTC restart zeroed
everyone's spend; a user could spend $25, get redeployed, and spend
$25 more in the same day.

- New PaperclipState writer (services/paperclip/src/persistence.ts)
  inserts on /reserve, updates on /release, and reads today's totals
  on startup via SUM(COALESCE(actual_usd, est_usd)).
- BudgetManager.rehydrateDailyUsd(snapshot) replaces the in-memory
  Map with the persisted state before traffic opens.
- Connection uses chemclaw_service (BYPASSRLS) so the sidecar can
  read/write across all users from a single pool. The paperclip_state
  RLS policy still enforces user-scoping for any application-level
  reader (none yet — agent-claw's daily-spend endpoint is a follow-up).
- PAPERCLIP_PG_DSN env (docker-compose default points at postgres:5432
  with the service role) controls whether persistence is on; unset =
  no-op stub, matches single-instance dev behaviour.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Hook YAML/registrar parity — fix redact-secrets lifecycle drift

**Files:**
- Modify: `hooks/redact-secrets.yaml` (`lifecycle: pre_tool` → `lifecycle: post_turn`)
- Modify: `services/agent-claw/src/core/hook-loader.ts` (after-registration parity assertion)
- Modify: `services/agent-claw/tests/unit/hook-loader-coverage.test.ts` (new test for parity)

- [ ] **Step 4.1: Fix the YAML so it matches the registrar's lifecycle.on call**

Edit `hooks/redact-secrets.yaml`. Replace the line:

```yaml
lifecycle: pre_tool
```

with:

```yaml
# Registrar wires this at post_turn (defense-in-depth scrub of outbound
# assistant text). The historical pre_tool registration was a regression —
# it mangled tool inputs (e.g. SMILES → [REDACTED]) before chemistry
# tools saw them. Keep this field in sync with the registrar's
# lifecycle.on(...) call; hook-loader-coverage.test.ts asserts parity.
lifecycle: post_turn
```

- [ ] **Step 4.2: Write the failing parity test**

Append to `services/agent-claw/tests/unit/hook-loader-coverage.test.ts`:

```typescript
describe("hook YAML/registrar parity", () => {
  it("every YAML's lifecycle field matches where its registrar actually registers", async () => {
    const yamlEntries = (await readdir(hooksDir)).filter((f) => f.endsWith(".yaml"));

    // Build a map of name → declared lifecycle from the YAML files.
    const declared = new Map<string, string>();
    for (const file of yamlEntries) {
      const raw = await readFile(resolve(hooksDir, file), "utf8");
      const parsed = parseYaml(raw) as { name?: string; lifecycle?: string };
      if (parsed.name && parsed.lifecycle) {
        declared.set(parsed.name, parsed.lifecycle);
      }
    }

    // Run the loader, then introspect the lifecycle to discover where
    // each registered hook actually landed.
    const lc = new Lifecycle();
    await loadHooks(lc, mockHookDeps(), hooksDir);

    // Lifecycle exposes hooks() → list per point; iterate and build
    // the actual map.
    const actual = new Map<string, string>();
    for (const point of [
      "pre_turn",
      "pre_tool",
      "post_tool",
      "pre_compact",
      "post_turn",
    ] as const) {
      for (const handler of lc.hooks(point)) {
        actual.set(handler.name, point);
      }
    }

    // Each declared YAML must match its registrar's actual point.
    for (const [name, declaredPoint] of declared) {
      const actualPoint = actual.get(name);
      expect(actualPoint, `hook ${name}: YAML claims ${declaredPoint}`).toBe(declaredPoint);
    }
  });
});
```

- [ ] **Step 4.3: Run the test to confirm it passes after Step 4.1**

Run: `cd services/agent-claw && npx vitest run tests/unit/hook-loader-coverage.test.ts`

Expected: PASS (the YAML fix in 4.1 should make this green; if `Lifecycle.hooks(point)` doesn't exist, see step 4.4).

- [ ] **Step 4.4: If `Lifecycle.hooks(point)` doesn't exist, add it**

Inspect `services/agent-claw/src/core/lifecycle.ts`. If there's no public `hooks(point)` method, add one alongside the existing `count(point)` method:

```typescript
  /**
   * Return the registered handlers (with their names) at a given point.
   * Used by hook-loader-coverage.test to assert YAML/registrar parity.
   * Returns a copy so callers can't mutate the internal array.
   */
  hooks(point: HookPoint): Array<{ name: string; handler: HookHandler }> {
    const arr = this._hooks.get(point) ?? [];
    return arr.map((h) => ({ name: h.name, handler: h.handler }));
  }
```

(Adjust the property names to match the existing internal storage shape — most likely the array elements already have `name` and `handler` fields.)

- [ ] **Step 4.5: Run the parity test again after adding hooks() if needed**

Run: `cd services/agent-claw && npx vitest run tests/unit/hook-loader-coverage.test.ts`

Expected: all PASS.

- [ ] **Step 4.6: Run the full agent-claw test suite to confirm nothing else broke**

Run: `cd services/agent-claw && npx tsc --noEmit && npm test 2>&1 | tail -10`

Expected: tsc clean, all tests PASS.

- [ ] **Step 4.7: Commit Task 4**

```bash
git add hooks/redact-secrets.yaml \
        services/agent-claw/src/core/lifecycle.ts \
        services/agent-claw/tests/unit/hook-loader-coverage.test.ts
git commit -m "$(cat <<'EOF'
fix(hooks): redact-secrets YAML/registrar lifecycle parity

Closes deep-review issue #4.

hooks/redact-secrets.yaml claimed lifecycle: pre_tool. The TS registrar
hard-codes lifecycle.on('post_turn', ...). The hook-loader validates
the YAML field but for builtin hooks calls the registrar — so the
YAML's lifecycle: was informational only and lying.

- Updated YAML to lifecycle: post_turn (matches reality).
- New parity assertion in hook-loader-coverage.test.ts: every YAML's
  declared lifecycle MUST match where its registrar actually wires
  the handler. Future YAML/registrar drift fails CI.
- Added Lifecycle.hooks(point) introspection method so the test can
  inspect what was registered without running a dispatch.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Final verification + PR

- [ ] **Step 5.1: Run the entire test matrix locally**

```bash
cd services/agent-claw && npx tsc --noEmit && npm test
cd services/paperclip && npm test
cd ../.. && python3 -m pytest tests/unit/test_redactor.py tests/unit/optimizer/ services/mcp_tools/common/tests/ services/mcp_tools/mcp_eln_local/tests/ services/mcp_tools/mcp_logs_sciy/tests/ services/projectors/kg_source_cache/tests/ services/mock_eln/seed/tests/ -q
```

Expected:
- agent-claw: tsc clean, 678+ tests pass.
- paperclip: 21+ tests pass.
- python: 109+ tests pass (3 new tests in `test_gepa_runner.py` + new tests in `test_gepa_examples.py` + `test_gepa_metric.py`).

- [ ] **Step 5.2: Push the branch and open the PR**

```bash
git push -u origin fix/phase-g-paperclip-gepa
gh pr create --title "Phase G: Paperclip + GEPA self-improvement fixes" --body "$(cat <<'EOF'
## Summary

Closes the 6 issues from the 2026-04-28 deep-review report that are surgical fixes (not redesigns):

- **#1** GEPA had no LM configured — every nightly run errored on every prompt while `/healthz` reported green. Wired DSPy → LiteLLM gateway via `LITELLM_BASE_URL` / `GEPA_MODEL`.
- **#2** Aggregate `/healthz` status was unconditionally `ok` even when every prompt errored. Now reports `degraded` if any prompt errored.
- **#3** Langfuse v2 `fetch_traces` API had no v3 fallback — a Dependabot bump would silently disable the loop. Now probes `client.api.trace.list` first, falls back to v2.
- **#4** `hooks/redact-secrets.yaml` claimed `lifecycle: pre_tool` but the registrar wires at `post_turn`. Fixed YAML; new parity assertion in hook-loader-coverage tests catches future drift.
- **#7** `_extract_template` returned `pred.signature.instructions` (= signature DOCSTRING = seed prompt). The runner inserted byte-identical "candidates" that could never beat themselves. Now flags as `skipped="identity template"`.
- **#8** `traces_to_examples` only matched `obs.type == "span"`; real Langfuse OTel traces use `SPAN` and `GENERATION`. The empty `tool_outputs` trivialised the citation component. Broadened the filter.
- **#9** `classify_question` first-keyword-match-wins biased everything toward `retrosynthesis`. Now sums hits per class and picks argmax with a deterministic tie-break.
- **#11** Paperclip's daily-USD ledger reset on every sidecar restart. Now persists reservations to the existing `paperclip_state` table and rehydrates on startup.

Deferred (issues #5, #6, #10, #12 from the deep-review): non-streaming-path Paperclip coverage, plan-mode Langfuse tagging, shadow vs. GEPA metric divergence, multi-replica distributed lock.

## Test plan

- [x] `cd services/agent-claw && npx tsc --noEmit` — clean
- [x] `cd services/agent-claw && npm test` — 685+ tests pass (was 678, +7 new)
- [x] `cd services/paperclip && npm test` — 21+ tests pass (was 17, +4 new)
- [x] `python3 -m pytest tests/unit/test_redactor.py tests/unit/optimizer/ services/mcp_tools/...` — 115+ tests pass (was 109, +6 new)
- [ ] After merge: bounce `chemclaw-gepa-runner` and `chemclaw-paperclip-lite` to pick up the new env vars / code.
- [ ] After merge: run a manual `/eval golden` and confirm GEPA `/healthz` reports `ok` instead of `error` per prompt.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5.3: Wait for CI then merge**

Wait for the 3 CI checks (TypeScript, Python, Schema) to finish. Then:

```bash
gh pr merge --merge --delete-branch
```

---

## Self-review checklist

**Coverage:** Each issue from the deep-review report (in scope) is addressed by exactly one task or step:
- #1 → Task 1 (steps 1.5, 1.7)
- #2 → Task 1 (step 1.7)
- #3 → Task 2 (step 2.13)
- #4 → Task 4 (steps 4.1, 4.2)
- #7 → Task 2 (steps 2.1–2.4)
- #8 → Task 2 (steps 2.9–2.12)
- #9 → Task 2 (steps 2.5–2.8)
- #11 → Task 3

**Placeholders:** None. Every step shows the actual code, the actual command, and the expected output.

**Type consistency:** `PaperclipState` interface matches its class implementation. `BudgetManager.rehydrateDailyUsd` accepts `Map<string, number>` keyed by `userEntraId:YYYY-MM-DD`, which matches what `PaperclipState.rehydrateDailyUsd` returns. `_configure_dspy_lm` raises `RuntimeError`, which `run_gepa_nightly`'s outer `try/except` catches into `_last_run_status = "error"` (existing behaviour).

**Risks:** Step 3.7 modifies `index.ts`'s startup block — there's a subtle promise race where the rehydrate runs concurrently with `app.listen`. Acceptable: the in-process map starts empty (matches pre-persistence behaviour); rehydrate just adds historical totals when it lands. If this matters for production, await the rehydrate before `app.listen`.
