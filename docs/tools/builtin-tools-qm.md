# ChemClaw Builtin Tools Reference — QM & Workflow Execution

This document covers quantum-chemistry tools (`qm_*`) and workflow execution tools (`workflow_*`, `write_file`). These are part of the M–Z builtin tool set; for full M–Z reference see [builtin-tools-m-z.md](builtin-tools-m-z.md).

---

## Quantum Chemistry Tools

All QM builtins share a common base schema:

**Common `QmRequestBase` input fields:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `smiles` | `string` | Yes | — | Input molecule as SMILES (1–10000 chars) |
| `method` | `string` | No | `"GFN2"` | Semiempirical method: `GFN0`, `GFN1`, `GFN2`, `GFN-FF`, `g-xTB`, `sTDA-xTB`, `IPEA-xTB` |
| `charge` | `integer` | No | `0` | Formal charge on the molecule |
| `multiplicity` | `integer` | No | `1` | Spin multiplicity (1 = singlet) |
| `solvent_model` | `string` | No | `"none"` | Implicit solvent: `none`, `alpb`, `gbsa` |
| `solvent_name` | `string` | No | — | Solvent identifier (e.g., `"water"`, `"acetonitrile"`) |
| `force_recompute` | `boolean` | No | `false` | Bypass cache and force fresh computation |

**Common `QmResponseBase` output fields:**

| Field | Type | Description |
|---|---|---|
| `job_id` | `string \| null` | Persisted `qm_jobs` UUID; `null` on immediate error before job creation |
| `cache_hit` | `boolean` | `true` if the result was served from cache (< 100 ms) |
| `status` | `string` | Job status: `"succeeded"`, `"failed"`, `"running"` |
| `summary` | `string` | Human-readable computation result summary |
| `method` | `string` | Method actually used |
| `task` | `string` | Task type identifier |

Results are cached by `(method, smiles, charge, multiplicity, solvent_model, params)` hash. The `qm_kg` projector converts each new `qm_jobs` row to a Neo4j `CalculationResult` node.

---

### `qm_single_point`

**Tool ID:** `qm_single_point`

**Description:** Compute a single-point energy for a SMILES using a tight-binding semiempirical method. Returns total energy in Hartree, HOMO-LUMO gap in eV, and dipole vector. Cache hits return in under 100 ms. Intended as a fast screening primitive before geometry optimization or frequency calculations.

**Annotations:** `readOnly: true`

**Additional Input Parameters:** None beyond `QmRequestBase`.

**Additional Output Fields:**

| Field | Type | Description |
|---|---|---|
| `energy_hartree` | `number \| null` | Total electronic energy in Hartree |
| `homo_lumo_eV` | `number \| null` | HOMO-LUMO gap in electron-volts |
| `dipole` | `number[] \| null` | Dipole moment vector `[x, y, z]` in Debye |

**Behavior Notes:**
- Wraps `mcp-xtb /single_point`. Typical latency 1–3 s for drug-like molecules; < 100 ms on cache hit.
- GFN-FF is a force-field method — HOMO-LUMO and dipole are not available for GFN-FF runs.
- Run `qm_geometry_opt` first if 3D geometry matters — single-point on unoptimized structures can be misleading.

---

### `qm_geometry_opt`

**Tool ID:** `qm_geometry_opt`

**Description:** Run a geometry optimization (energy minimization) for a SMILES using a tight-binding method. Returns the optimized XYZ geometry, final energy, and convergence metadata. Use before frequency calculations or single-point refinements.

**Annotations:** `readOnly: true`

**Additional Input Parameters:** None beyond `QmRequestBase`.

**Additional Output Fields:**

| Field | Type | Description |
|---|---|---|
| `energy_hartree` | `number \| null` | Final optimized energy in Hartree |
| `xyz` | `string \| null` | Optimized geometry in XYZ format (multi-line string) |
| `converged` | `boolean \| null` | Whether the optimization converged |
| `n_steps` | `integer \| null` | Number of optimization steps taken |

**Behavior Notes:**
- Wraps `mcp-xtb /geometry_opt`. Typical latency 5–30 s depending on molecular size.
- Non-convergence (`converged: false`) yields a partial geometry — inspect `summary` before using downstream.

---

### `qm_frequencies`

**Tool ID:** `qm_frequencies`

**Description:** Compute vibrational frequencies and thermochemical properties (zero-point energy, enthalpy, entropy, Gibbs free energy) for a SMILES at a given temperature. Should be called on a previously optimized geometry; running on a non-minimum structure may yield imaginary frequencies.

**Annotations:** `readOnly: true`

**Additional Input Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `temperature_k` | `number` | No | `298.15` | Temperature in Kelvin for thermochemical corrections |

**Additional Output Fields:**

| Field | Type | Description |
|---|---|---|
| `frequencies_cm1` | `number[] \| null` | Vibrational frequencies in cm⁻¹ |
| `zero_point_energy_hartree` | `number \| null` | Zero-point vibrational energy in Hartree |
| `enthalpy_hartree` | `number \| null` | Enthalpy at specified temperature (Hartree) |
| `entropy_cal_mol_k` | `number \| null` | Entropy in cal/(mol·K) |
| `gibbs_hartree` | `number \| null` | Gibbs free energy at specified temperature (Hartree) |
| `n_imaginary` | `integer \| null` | Number of imaginary frequencies; 0 confirms a true minimum |

**Behavior Notes:**
- Wraps `mcp-xtb /frequencies`. Typical latency 10–60 s.
- `n_imaginary > 0` means the geometry is a saddle point, not a minimum. Transition states intentionally have exactly 1 imaginary frequency.
- Thermochemical values use the rigid-rotor harmonic-oscillator approximation (standard for screening-level accuracy).

---

### `qm_fukui`

**Tool ID:** `qm_fukui`

**Description:** Compute Fukui functions (f⁺, f⁻, f⁰) for a SMILES using a tight-binding method. Fukui indices quantify per-atom local reactivity: f⁺ = electrophilic attack sites, f⁻ = nucleophilic attack sites, f⁰ = radical reactivity (dual descriptor).

**Annotations:** `readOnly: true`

**Additional Input Parameters:** None beyond `QmRequestBase`.

**Additional Output Fields:**

| Field | Type | Description |
|---|---|---|
| `fukui_plus` | `number[] \| null` | Per-atom f⁺ values (electrophilic susceptibility) |
| `fukui_minus` | `number[] \| null` | Per-atom f⁻ values (nucleophilic susceptibility) |
| `fukui_zero` | `number[] \| null` | Per-atom f⁰ dual descriptor (radical reactivity) |
| `atom_symbols` | `string[] \| null` | Element symbols in the same order as Fukui arrays |

**Behavior Notes:**
- Wraps `mcp-xtb /fukui`. Typical latency 2–10 s.
- Computed from finite differences of Mulliken charges for N, N±1 electrons.
- High f⁺ atoms = good nucleophile targets; high f⁻ atoms = good electrophile targets. Useful for directing metalation, halogenation, or protecting-group strategy.
- Array indices correspond to atom order in the input SMILES graph.

---

### `qm_redox_potential`

**Tool ID:** `qm_redox_potential`

**Description:** Estimate the reduction potential (E° vs. a reference electrode) using a thermodynamic cycle combining GFN2 solvation free energies. Useful for assessing electrochemical stability of intermediates or designing redox-active compounds.

**Annotations:** `readOnly: true`

**Additional Input Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `n_electrons` | `integer` | No | `1` | Number of electrons transferred in the redox event |
| `reference` | `string` | No | `"SHE"` | Reference electrode: `SHE`, `NHE`, `SCE`, `Fc/Fc+` |

**Additional Output Fields:**

| Field | Type | Description |
|---|---|---|
| `redox_potential_V` | `number \| null` | Estimated reduction potential in Volts vs. the specified reference |
| `delta_g_solv_oxidized_hartree` | `number \| null` | Solvation free energy of the oxidized form |
| `delta_g_solv_reduced_hartree` | `number \| null` | Solvation free energy of the reduced form |
| `reference` | `string \| null` | Reference electrode used |

**Behavior Notes:**
- Wraps `mcp-xtb /redox`. Typical latency 10–30 s (requires two geometry optimizations + solvation cycles).
- Default `solvent_model` overridden to `"alpb"` for redox (gas-phase redox potentials are unphysical).
- Thermodynamic cycle uses absolute proton reference −4.28 V for SHE (Trasatti convention). Error bars typically ±0.3–0.5 V.

---

### `qm_crest_screen`

**Tool ID:** `qm_crest_screen`

**Description:** Run a CREST ensemble screen for a SMILES. Three modes: `conformers` generates a low-energy conformer ensemble, `tautomers` enumerates tautomeric forms, `protomers` enumerates protonation states. Returns ranked ensemble with Boltzmann weights.

**Annotations:** `readOnly: true`

**Additional Input Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `mode` | `string` | No | `"conformers"` | Screen type: `conformers`, `tautomers`, `protomers` |
| `threads` | `integer` | No | `4` | CPU threads for parallel CREST sampling (1–32) |
| `n_max` | `integer` | No | `20` | Maximum ensemble members to return (1–200) |

**Output Fields:**

| Field | Type | Description |
|---|---|---|
| `job_id` | `string \| null` | Persisted job UUID |
| `cache_hit` | `boolean` | Whether served from cache |
| `method` | `string` | xTB method used |
| `task` | `string` | `"conformers"`, `"tautomers"`, or `"protomers"` |
| `summary` | `string` | Human-readable summary (ensemble size, energy window) |
| `ensemble` | `EnsembleEntry[]` | Ranked structures (see below) |

**`EnsembleEntry` fields:**

| Field | Type | Description |
|---|---|---|
| `ensemble_index` | `integer` | Zero-based rank (0 = lowest energy) |
| `xyz` | `string` | XYZ-format geometry (multi-line string) |
| `energy_hartree` | `number` | Electronic energy in Hartree |
| `boltzmann_weight` | `number` | Boltzmann population weight at 298 K (sums to 1.0) |

**Behavior Notes:**
- Wraps `mcp-crest`. The `mode` parameter routes to `/conformers`, `/tautomers`, or `/protomers`.
- This is the most expensive builtin (600-second timeout). CREST runs hundreds of GFN2-xTB optimizations internally.
- Cache hits are fast (< 100 ms).
- `boltzmann_weight` is at 298.15 K. Use raw `energy_hartree` to recompute at other temperatures.

---

## Workflow & File Tools

### `workflow_replay`

**Tool ID:** `workflow_replay`

**Description:** Replay a completed workflow run by re-executing it from the beginning with the same or overridden inputs. Useful for reproducing results or re-running with adjusted parameters without redefining the workflow.

**Annotations:** `readOnly: false`

**Input Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `run_id` | `string (UUID)` | Yes | — | UUID of the completed run to replay |
| `input_override` | `object` | No | — | Partial input override merged onto original run's inputs before replay |

**Output Fields:**

| Field | Type | Description |
|---|---|---|
| `run_id` | `string (UUID)` | UUID of the newly created replay run |
| `workflow_id` | `string (UUID)` | Workflow the run belongs to |
| `status` | `string` | Initial status of the replayed run (typically `"pending"` or `"running"`) |
| `parent_run_id` | `string (UUID)` | UUID of the original run that was replayed |
| `step_count` | `integer` | Number of steps in the replayed run |

---

### `workflow_run`

**Tool ID:** `workflow_run`

**Description:** Execute a workflow by ID, supplying its input values. Returns a run ID that can be polled via `workflow_inspect` or awaited. For long-running workflows, the agent should prefer polling rather than blocking.

**Annotations:** `readOnly: false`

**Input Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `workflow_id` | `string (UUID)` | Yes | — | UUID of the workflow to execute |
| `inputs` | `object` | No | `{}` | Key-value map of input values for the workflow run |
| `label` | `string` | No | — | Human-readable label for this run instance (max 200 chars) |

**Output Fields:**

| Field | Type | Description |
|---|---|---|
| `run_id` | `string (UUID)` | UUID of the created run |
| `workflow_id` | `string (UUID)` | Workflow this run belongs to |
| `status` | `string` | Initial run status |
| `created_at` | `string (ISO 8601)` | Timestamp when the run was created |

**Behavior Notes:**
- Creates a new workflow run and enqueues it for execution. Returns immediately with the run ID.
- Use `workflow_inspect` to poll for completion.
- Inputs must satisfy the workflow's declared input schema; validation errors surface as 422 from the workflow engine.

---

### `write_file`

**Tool ID:** `write_file`

**Description:** Write text content to a file in the agent's sandboxed workspace (E2B). Creates the file if it does not exist; overwrites if it does. Confined to the session sandbox — no access to the host filesystem.

**Annotations:** `readOnly: false`

**Input Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | — | File path within the sandbox to write |
| `content` | `string` | Yes | — | Text content to write |
| `encoding` | `string` | No | `"utf-8"` | Encoding: `"utf-8"` or `"base64"` |

**Output Fields:**

| Field | Type | Description |
|---|---|---|
| `path` | `string` | Resolved path of the written file |
| `bytes_written` | `integer` | Number of bytes written |
| `created` | `boolean` | `true` if newly created; `false` if overwritten |

**Behavior Notes:**
- All writes are confined to the E2B sandbox. Files do not persist beyond the session unless explicitly exported.
- Parent directories are created automatically.
- Use `read_file` to verify content, or `run_program` to execute the written file.
