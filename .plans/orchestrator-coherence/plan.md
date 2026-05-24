# Orchestrator Coherence Cleanup

## Context
Raptor has already moved a lot of its surface area toward agent orchestration, but the repo still mixes two product stories: a deterministic orchestrator for agents/skills/flows, and a general coding assistant with autonomous sub-agents, mutable session state, and broad prompt-pack compatibility. The result is a runtime that can still behave differently based on prior chat state, ad hoc flow flags, imported external instruction files, or silent provider degradation.

This plan aligns the extension, plugin, skills, agents, installer, and docs around one product contract: Raptor is an orchestration-first runtime that applies named agents, named skills, and named flows more deterministically than ad hoc prompting. VS Code remains the native execution surface. Claude Code, Codex, OpenCode, and Cursor remain packaging/discovery targets, not parity runtimes.

## Architectural decisions
- Decision: Make deterministic orchestration the primary product contract. Rationale: the user goal is to reduce variance in agent execution by pushing work into named agents, skills, and flows. Alternatives rejected: keeping Raptor as a broad coding assistant with “orchestration features” would preserve the current incoherent behavior.
- Decision: Keep VS Code as the only first-class flow runner. Rationale: the extension owns the native tool loop, checkpointing, and execution state. Alternatives rejected: trying to make Claude/Codex/OpenCode/Cursor runtime-equivalent would keep forcing assistant-style compatibility compromises.
- Decision: Remove hidden ambient runtime choices from orchestration paths. Rationale: `/agent` session switching, `/flow --chat`, `/flow --keep-current`, `/flow --accept-models`, and stale `--autopilot` guidance make execution depend on chat history or operator choices instead of config. Alternatives rejected: documenting the flags better; that would not make execution more deterministic.
- Decision: Keep provider abstraction, but demote user-facing model-routing as a flow control surface. Rationale: providers are still needed for VS Code and delegated CLIs, but flows should preflight to one resolved execution plan instead of offering several runtime modes. Alternatives rejected: deleting provider abstraction entirely in this plan.
- Decision: Treat imported external assistant files as migration inputs, not first-class orchestrator agents. Rationale: `CLAUDE.md`, `instructions.md`, and OpenCode instruction blocks are useful source material, but silently loading them as runtime agents keeps old prompt-pack semantics load-bearing. Alternatives rejected: removing importers outright without a migration path.
- Decision: Separate `core`, `optional`, and `internal` skills/agents inside the current repo using metadata and packaging rules. Rationale: the repo can still host useful utilities, but the default installed/discoverable surface should match the orchestrator product. Alternatives rejected: splitting the repository or deleting every non-core skill immediately.
- Decision: Use shell-friendly distribution manifests as the packaging source of truth. Rationale: `install.sh` and `uninstall.sh` cannot depend on Node or `jq`, so classification data must be readable from POSIX shell. Alternatives rejected: making shell parse markdown frontmatter as the canonical distribution source.

## Assumptions and answers from code
- Decision: Project check command is `npm run compile`. Source: code @ [package.json:45](</media/smk/Shared/Code/VS Raptor/package.json:45>).
- Decision: No `.agents/standards/` or `.agents/common-mistakes/` directories exist in this repo today. Source: code search in repo root.
- Decision: The current extension command surface is `/help`, `/skills`, `/agents`, `/agent`, `/flows`, `/flow`, `/models`, and `/build-flow`. Source: code @ [package.json:81](</media/smk/Shared/Code/VS Raptor/package.json:81>), [src/tools/catalog.ts:49](</media/smk/Shared/Code/VS Raptor/src/tools/catalog.ts:49>).
- Decision: `/flow` currently exposes multiple execution modes: `--accept-models`, `--keep-current`, `--chat`, `--resume`, and `--memory`. Source: code @ [extension.ts:1486](</media/smk/Shared/Code/VS Raptor/extension.ts:1486>), [package.json:101](</media/smk/Shared/Code/VS Raptor/package.json:101>).
- Decision: The runtime still mentions `--autopilot`, but there is no implemented parser branch for that flag. Source: code @ [extension.ts:1591](</media/smk/Shared/Code/VS Raptor/extension.ts:1591>) plus repo-wide search.
- Decision: Flow execution can silently downgrade to text-only when the resolved provider lacks tool support. Source: code @ [extension.ts:2221](</media/smk/Shared/Code/VS Raptor/extension.ts:2221>).
- Decision: Flow handoff is currently summary-based, using truncated prose plus context compaction. Source: code @ [extension.ts:2208](</media/smk/Shared/Code/VS Raptor/extension.ts:2208>), [extension.ts:2241](</media/smk/Shared/Code/VS Raptor/extension.ts:2241>), [extension.ts:2310](</media/smk/Shared/Code/VS Raptor/extension.ts:2310>).
- Decision: `/agent <id>` currently mutates ambient session behavior via inferred active agent state. Source: code @ [extension.ts:1419](</media/smk/Shared/Code/VS Raptor/extension.ts:1419>), [extension.ts:1633](</media/smk/Shared/Code/VS Raptor/extension.ts:1633>).
- Decision: The runtime still exposes an autonomous `spawnAgent` tool with its own iteration loop and edit/terminal tools. Source: code @ [extension.ts:1226](</media/smk/Shared/Code/VS Raptor/extension.ts:1226>), [src/tools/registry.ts:191](</media/smk/Shared/Code/VS Raptor/src/tools/registry.ts:191>), [src/tools/catalog.ts:13](</media/smk/Shared/Code/VS Raptor/src/tools/catalog.ts:13>).
- Decision: Imported external config still becomes first-class agents today. Source: code @ [src/config/importers/claude.ts:20](</media/smk/Shared/Code/VS Raptor/src/config/importers/claude.ts:20>), [src/config/importers/codex.ts:42](</media/smk/Shared/Code/VS Raptor/src/config/importers/codex.ts:42>), [src/config/importers/opencode.ts:19](</media/smk/Shared/Code/VS Raptor/src/config/importers/opencode.ts:19>).
- Decision: Installer default behavior is “install every skill and every agent to every supported target.” Source: code @ [install.sh:294](</media/smk/Shared/Code/VS Raptor/install.sh:294>), [install.sh:481](</media/smk/Shared/Code/VS Raptor/install.sh:481>), [install.sh:529](</media/smk/Shared/Code/VS Raptor/install.sh:529>).
- Decision: Agent metadata still contains `hawk-skills` lineage text. Source: code @ [agents/audit-architecture.md:3](</media/smk/Shared/Code/VS Raptor/agents/audit-architecture.md:3>), [agents/plan-reviewer.md:3](</media/smk/Shared/Code/VS Raptor/agents/plan-reviewer.md:3>).
- Decision: There is no test suite or test directory in the repo today; verification is compile- and smoke-check driven. Source: code search in repo root.

## Risks accepted
- Existing users may rely on `/agent` ambient switching, `/flow --chat`, or broad all-skills installs. Mitigation: ship explicit migration notes and preserve `--resume` / `--memory` only where they still match the deterministic contract.
- Reducing the default skill surface may surprise users who currently get unrelated utilities “for free.” Mitigation: classify them as optional instead of deleting them unless they are clearly obsolete.
- Treating imported external instruction files as migration-only may reduce convenience for mixed-tool setups. Mitigation: keep the importers as discoverability/migration helpers and make the recommended path explicit in docs and `/build-flow`.
- Artifact-based step handoff will add file I/O and state shape changes. Mitigation: stage it in the flow increment and keep a narrow, documented checkpoint schema.

## Increment DAG
- Inc 1 — Product Contract and Exposure Metadata (M) — depends on: none — unblocks: 2, 3, 4, 5
- Inc 2 — Runtime Orchestrator Semantics (L) — depends on: 1 — unblocks: 3, 5
- Inc 3 — Deterministic Flow Execution (L) — depends on: 1, 2 — unblocks: 5
- Inc 4 — Packaged Surface and Skill Cleanup (M) — depends on: 1 — unblocks: 5
- Inc 5 — Importer Boundaries, Docs, and Smoke Verification (M) — depends on: 2, 3, 4 — unblocks: release

## Increments

### Inc 1 — Product Contract and Exposure Metadata (M)
**Depends on:** none  
**Unblocks:** 2, 3, 4, 5  
**Done criteria:** Every shipped skill and agent is explicitly classified as `core`, `optional`, or `internal` in one machine-readable inventory, the likely cleanup candidates are decided explicitly, and the repo’s top-level product story consistently describes Raptor as an orchestration runtime instead of a generic coding assistant.
**Status:** done

#### Files to touch

##### [README.md](/media/smk/Shared/Code/VS Raptor/README.md)
- What changes: rewrite the top-level positioning and feature summary around deterministic orchestration, named agents, named skills, and VS Code-native flow execution.
- Integration points: the project tagline, features list, installation sections, provider/flow notes, compatibility copy, and command docs.
- Error paths: avoid promising parity runtimes or assistant-style prompt-pack behavior that later increments will intentionally remove.

##### [package.json](/media/smk/Shared/Code/VS Raptor/package.json)
- What changes: tighten extension and chat participant descriptions so they match orchestration-first behavior.
- Integration points: extension description, chat participant description, slash-command descriptions, configuration descriptions, and keywords.
- Error paths: keep command IDs stable so existing installs still activate.

##### [catalog/skills.tsv](/media/smk/Shared/Code/VS Raptor/catalog/skills.tsv)
- What changes: add a shell-friendly skill distribution manifest.
- Data shapes: tab-separated rows with header `id	category	default_install	targets`; `category` constrained to `core|optional|internal`; `targets` as comma-separated target ids.
- Integration points: `install.sh`, `uninstall.sh`, README inventory, optional docs tooling.
- Error paths: this file becomes the packaging source of truth, so it must not depend on markdown parsing heuristics.

##### [catalog/agents.tsv](/media/smk/Shared/Code/VS Raptor/catalog/agents.tsv)
- What changes: add a matching agent distribution manifest.
- Data shapes: tab-separated rows with header `id	category	default_install	targets`; mark audit / plan-review agents as `internal`.
- Integration points: installer target rendering, uninstall bookkeeping, README inventory.
- Error paths: preserve compatibility with prefixed install names by keeping canonical ids unprefixed in the manifest.

##### [scripts/validate-inventory.mjs](/media/smk/Shared/Code/VS Raptor/scripts/validate-inventory.mjs)
- What changes: add a manifest-vs-files completeness check that compares `catalog/skills.tsv` and `catalog/agents.tsv` against the actual `skills/*/SKILL.md` and `agents/*.md` files shipped in the repo.
- Integration points: `npm run compile` is not sufficient for this check; wire it into `npm run smoke:orchestration` and, if cheap enough, a `prepack` or `prepublishOnly` script.
- Error paths: fail if a shipped skill/agent is missing from the manifest, if the manifest references a missing file, or if the classified target/default metadata is inconsistent with the filesystem set.

#### Edge cases
- Decide the inventory explicitly in this increment instead of leaving it as “likely”: `coding-process` should be either deleted or marked `internal`; `cap`, `design-master`, and `init-phoenix` should be either `optional` or removed from distribution.
- Keep the manifest authoritative even if the markdown skill/agent files later gain matching informational metadata.

#### Verification
- Run: `npm run compile`
- Tests to add/update: add `npm run validate:inventory` to cross-check manifest coverage, then use inventory greps such as `rg -n '^(coding-process|cap|design-master|init-phoenix)\t' catalog/skills.tsv`.
- Done: no top-level product copy contradicts the orchestration-first contract, and the skill/agent inventory is explicit enough for shell installer consumption.

### Inc 2 — Runtime Orchestrator Semantics (L)
**Depends on:** 1  
**Unblocks:** 3, 5  
**Done criteria:** User-facing runtime behavior no longer depends on hidden session-agent state or autopilot framing, direct agent invocation is request-scoped with an explicit command shape, and autonomous sub-agent execution is either internal-only or rewritten to fit an explicit orchestration contract.
**Status:** done

#### Files to touch

##### [src/chat/system-prompt.ts](/media/smk/Shared/Code/VS Raptor/src/chat/system-prompt.ts)
- What changes: rewrite the system prompt around explicit orchestration modes: route to a skill, invoke a named agent, run a named flow, or answer directly when no orchestration is needed.
- Integration points: default chat behavior, tool usage policy, user-facing tone.
- Error paths: do not keep assistant/autopilot phrasing that encourages broad self-directed execution.

##### [src/config/loader.ts](/media/smk/Shared/Code/VS Raptor/src/config/loader.ts)
- What changes: tighten `_default` agent semantics so it is a router/orchestrator, not a silent bundle with hard-coded behavior; remove hidden assumptions that every request should carry `agent-flow-builder`.
- Function(s): `ensureDefaultAgent(config: LoadedConfig): void`
- Data shapes: `_default` prompt and skill/tool defaults must line up with the new orchestration contract.
- Integration points: active-agent fallback when no explicit agent is invoked.

##### [extension.ts](/media/smk/Shared/Code/VS Raptor/extension.ts)
- What changes: replace ambient `/agent <id>` state switching with request-scoped selection. Chosen contract:
  `/agent <id>` shows agent details and usage;
  `/agent <id> <task...>` runs that task with the selected agent for the current request only;
  non-command turns always route through `_default` unless the user explicitly invokes a flow or agent in that turn.
- Function(s): command parsing around `/agent`, active-agent inference replacement, a new request-scope helper, message-building entrypoints, and the sub-agent execution helper.
- Helper boundaries: introduce a small `resolveRequestScope(...)` helper, a `buildPromptForRequestScope(...)` helper, and keep `toolSpawnAgent(...)` isolated from ambient session state.
- Data shapes: introduce an explicit request-scope shape threaded through the handler, for example `RequestScope { directAgentId?: string; directAgentTask?: string }`.
- Integration points: `/agents` help text, follow-up actions, message-building, any metadata currently using `activeAgent` / `activeModel`.
- Error paths: preserve backwards-compatible usage help for the old form and stop returning session-mutation metadata.

##### [src/tools/catalog.ts](/media/smk/Shared/Code/VS Raptor/src/tools/catalog.ts)
- What changes: update `/help` and tool descriptions so the catalog advertises orchestration capabilities, not assistant-autopilot powers.
- Integration points: core tool markdown, default orchestration tool list, sub-agent notes.

##### [src/tools/registry.ts](/media/smk/Shared/Code/VS Raptor/src/tools/registry.ts)
- What changes: decide whether `spawnAgent` remains a public tool. Chosen direction: keep it available only to internal orchestration workflows and explicit specialist agents, not as a default “core tool” exposed to every general session.
- Data shapes: internal allowlist or explicit exposure flag for tools that should not appear in general help/default routing.
- Error paths: do not break audit/plan flows that still need internal fan-out.

##### [extension.ts](/media/smk/Shared/Code/VS Raptor/extension.ts)
- What changes: if `spawnAgent` remains, rewrite its system prompt and result contract to be execution-worker oriented, not freeform autopilot. Require structured completion with scope summary, touched files, and verification notes.
- Function(s): `toolSpawnAgent(input: ToolInput): Promise<string>`
- Data shapes: structured text block or JSON-ish schema containing `status`, `summary`, `files`, `verification`.
- Error paths: worker tasks must fail closed when asked to expand scope or when no model is available.

#### Edge cases
- Existing chats may contain old active-agent metadata. The new runtime should ignore or safely downgrade it instead of carrying old hidden state forever.
- Internal fan-out for audit/planning flows must keep working even if `spawnAgent` disappears from user-facing help.

#### Verification
- Run: `npm run compile`
- Tests to add/update: add a manual smoke checklist for `/help` and `/agent` behavior in the PR notes.
- Done: user-facing prompt/help text contains no “autopilot” framing, `/agents` no longer tells users that `/agent <id>` switches the session, and running a non-command turn after `/agent <id>` does not inherit hidden state.

### Inc 3 — Deterministic Flow Execution (L)
**Depends on:** 1, 2  
**Unblocks:** 5  
**Done criteria:** A flow resolves to one explicit execution plan before step 1, no user-facing flow mode flags alter execution semantics at runtime, and step handoff/checkpoint state is explicit enough to support deterministic resume, memory inspection, and auditability.
**Status:** done

#### Files to touch

##### [package.json](/media/smk/Shared/Code/VS Raptor/package.json)
- What changes: simplify `/flow` command help text to the supported deterministic surface.
- Integration points: VS Code command palette/help, chat command descriptions.
- Error paths: keep `--resume`, `--memory`, and `--list` only if they still match the final checkpoint model.

##### [src/tools/catalog.ts](/media/smk/Shared/Code/VS Raptor/src/tools/catalog.ts)
- What changes: mirror the simplified `/flow` contract in generated help markdown.

##### [README.md](/media/smk/Shared/Code/VS Raptor/README.md)
- What changes: remove all user-facing references to `--accept-models`, `--keep-current`, `--chat`, and `--autopilot`; rewrite the flow runner note around deterministic preflight plus the new `--resume` / `--memory` contract.
- Integration points: slash-command table, flow runner note, provider/model section, flow examples.

##### [skills/agent-flow-builder/SKILL.md](/media/smk/Shared/Code/VS Raptor/skills/agent-flow-builder/SKILL.md)
- What changes: remove any guidance that assumes runtime flow flags still exist, and teach the new deterministic execution contract.
- Integration points: `/build-flow` injection in the runtime and generated examples.

##### [extension.ts](/media/smk/Shared/Code/VS Raptor/extension.ts)
- What changes: remove `--accept-models`, `--keep-current`, `--chat`, and stale `--autopilot` guidance. Add a preflight phase that resolves every step’s agent, provider, model, and tool capability before executing.
- Function(s): `/flow` command parsing, flow usage/help branches, `collectFlowModelChanges` replacement, `runFlow`, flow preflight helpers, flow state load/save helpers.
- Data shapes: introduce a durable checkpoint schema such as:
  `FlowRunState { flowId, runId, configFingerprint, originalPrompt, status, completedSteps, failedStepIndex?: number, failureReason?: string, startedAt, updatedAt, steps: Array<{ index, agentId, instructionDigest, resolvedProvider, resolvedModel, requestedTools, artifactPath, status, startedAt, updatedAt }> }`
- Integration points: `/flows`, `/flow --list`, `/flow --memory`, resume logic, output channel logging.
- Error paths: if a step requests tools and the resolved provider cannot run them, fail preflight before step 1 rather than silently downgrading to text-only execution.

##### [extension.ts](/media/smk/Shared/Code/VS Raptor/extension.ts)
- What changes: replace summary-only step handoff with artifact-backed handoff. Each run should live under `.raptor/flow-state/<flowId>/<runId>/` with:
  `state.json` for the checkpoint,
  `step-<n>.md` for human-readable step output,
  optional `step-<n>.json` for structured metadata if a step emits it,
  `latest.json` at `.raptor/flow-state/<flowId>/latest.json` as a pointer to the latest run for `--resume` / `--memory`.
- Function(s): `FlowState` replacement, `flowStateDir`, `flowStatePath` replacement, save/load/list helpers, step completion block, resume helpers.
- Data shapes: `--resume` resumes only the latest incomplete run whose `configFingerprint` matches the current authoritative flow/agent config and reruns the current incomplete step from its beginning; `--memory` is read-only inspection of the latest run’s checkpoint metadata, failure reason, and artifact paths.
- Error paths: detect missing artifact files or fingerprint mismatch during resume and require a fresh run instead of resuming from incomplete state; if a legacy single-file `<flowId>.json` checkpoint exists, show a migration warning and treat it as non-resumable unless an explicit one-time migration helper is added in Inc 5.

#### Edge cases
- Resuming after `flows.yaml` or `agents.yaml` changed should invalidate the old checkpoint via a config fingerprint mismatch.
- Flows with intentionally text-only steps must express that through tool configuration, not through provider fallback accidents.
- Existing partially completed runs from the pre-migration checkpoint format need an explicit compatibility story: warn and restart, or migrate once, but never silently reinterpret them.

#### Verification
- Run: `npm run compile`
- Tests to add/update: add a lightweight manual smoke scenario with a two-step flow, interruption, and resume; confirm saved artifacts and preflight output are visible.
- Done: no user-facing docs/help/runtime copy mentions removed flow flags, starting a tool-requiring flow with a text-only provider fails preflight with a specific user-facing error, and reopening VS Code plus `/flow <id> --resume` restores the same run id / step artifact set without regenerating completed steps.

### Inc 4 — Packaged Surface and Skill Cleanup (M)
**Depends on:** 1  
**Unblocks:** 5  
**Done criteria:** Fresh installs expose only the orchestrator-core surface by default, clearly optional skills are opt-in, and internal agents/skills are no longer documented or installed as if they were end-user entrypoints.
**Status:** done

#### Files to touch

##### [install.sh](/media/smk/Shared/Code/VS Raptor/install.sh)
- What changes: consume `catalog/skills.tsv` and `catalog/agents.tsv`, install only `default_install: true` entries by default, and add an explicit `--profile all` or equivalent override for optional utilities.
- Function(s): skill enumeration, interactive selection defaults, agent enumeration, help text.
- Data shapes: installer profile enum and metadata-derived inclusion filters.
- Integration points: target path rewriting, prefixed installs, model stripping for non-Claude targets.
- Error paths: do not install internal-only agents/skills into user-facing target directories unless a future debugging flag opts in. Write a per-target install manifest such as `<target-root>/.raptor-install.tsv` so uninstall can distinguish core vs optional assets in mixed-profile installs.

##### [uninstall.sh](/media/smk/Shared/Code/VS Raptor/uninstall.sh)
- What changes: keep uninstall detection compatible with the new profile/model, read the per-target install manifest when present, and ensure profile-driven or internal-only assets are removable without collateral deletion.
- Integration points: description matching, prefix filtering, agent cleanup.

##### [agents/*.md](/media/smk/Shared/Code/VS Raptor/agents)
- What changes: rewrite `hawk-skills` lineage text to Raptor/orchestrator wording and remove any remaining packaging copy that suggests direct end-user invocation for internal audit/review agents.
- Integration points: installer-copied agent files across Claude/Codex/OpenCode/Cursor.

##### [README.md](/media/smk/Shared/Code/VS Raptor/README.md)
- What changes: split the documented skill surface into `core`, `optional`, and `internal` categories. Document the default install profile and optional utilities explicitly.
- Integration points: install instructions, skill tables, plugin/tool compatibility sections.

##### [.claude-plugin/plugin.json](/media/smk/Shared/Code/VS Raptor/.claude-plugin/plugin.json)
- What changes: align plugin description/keywords with the narrower orchestrator surface and remove generic coding-assistant emphasis.

##### [skills/agent-flow-builder/SKILL.md](/media/smk/Shared/Code/VS Raptor/skills/agent-flow-builder/SKILL.md)
- What changes: narrow the example skill inventory to orchestration-core skills by default, with optional skills called out separately.

#### Edge cases
- Existing users may already have optional skills installed. The installer should not silently delete them on refresh; it should simply stop selecting them by default.
- If `coding-process` is removed entirely rather than reclassified, scrub all references from docs/examples/install output in this increment.
- Mixed-profile installs need deterministic uninstall behavior: removing a `core` refresh must not orphan optional assets, and removing `--profile all` assets must not wipe unrelated prefixed installs.

#### Verification
- Run: `bash -n install.sh uninstall.sh`
- Tests to add/update: dry-run install/uninstall with default and `--profile all`.
- Done: a default install yields only core orchestrator skills and the intended exported agents on each target.

### Inc 5 — Importer Boundaries, Docs, and Smoke Verification (M)
**Depends on:** 2, 3, 4  
**Unblocks:** release  
**Done criteria:** External assistant config importers no longer silently define first-class orchestrator runtime behavior, and the repo has a repeatable smoke-verification path for the new orchestration contract.
**Status:** done

#### Files to touch

##### [src/config/importers/claude.ts](/media/smk/Shared/Code/VS Raptor/src/config/importers/claude.ts)
- What changes: stop converting `CLAUDE.md` and Claude settings into normal runtime agents. Chosen direction: treat them as migration sources that produce warnings/suggestions or explicitly quarantined imported records, not default-executable agents.
- Data shapes: importer result may need `imports` or `migrationHints` in addition to `warnings` and `sources`, including a visible `origin` marker so users can see why something is detected but non-runtime-active.
- Integration points: config loader merge pipeline, `/agents` listing, README migration docs.
- Error paths: preserve visibility into the detected external config so users are not surprised that it was ignored.

##### [src/config/importers/codex.ts](/media/smk/Shared/Code/VS Raptor/src/config/importers/codex.ts)
- What changes: same migration-only treatment for `instructions.md` and `config.toml`.

##### [src/config/importers/opencode.ts](/media/smk/Shared/Code/VS Raptor/src/config/importers/opencode.ts)
- What changes: same migration-only treatment for imported OpenCode agents/instructions, unless they already conform to authoritative `.raptor` agent schema and are explicitly enabled.

##### [src/config/loader.ts](/media/smk/Shared/Code/VS Raptor/src/config/loader.ts)
- What changes: merge authoritative `.raptor` YAML config normally, but quarantine imported external assistant configs so they do not become ambient runtime agents by default.
- Function(s): root discovery/merge path, warning aggregation, source reporting.
- Integration points: `/agents`, `/flows`, build-flow defaults, default agent routing.

##### [extension.ts](/media/smk/Shared/Code/VS Raptor/extension.ts)
- What changes: surface migration warnings/help in `/help` or config load output when external assistant files are detected but not treated as first-class orchestrator config.
- Integration points: config load logging, `/agents` listing, `/build-flow` onboarding.

##### [README.md](/media/smk/Shared/Code/VS Raptor/README.md)
- What changes: add a migration section explaining that external tool configs are source material, while `.raptor/agents.yaml` and `.raptor/flows.yaml` are authoritative for orchestrated execution.

##### [package.json](/media/smk/Shared/Code/VS Raptor/package.json)
- What changes: add a concrete smoke script entry such as `smoke:orchestration`.

##### [scripts/smoke-orchestration.mjs](/media/smk/Shared/Code/VS Raptor/scripts/smoke-orchestration.mjs)
- What changes: add a repeatable smoke verifier that exercises authoritative config loading, importer quarantine behavior, and manifest/profile assumptions without requiring a full VS Code integration harness.
- Integration points: `package.json` script, fixture directories committed under the repo if needed.
- Script contract: exit 0 only when every assertion passes; print `OK:` lines for manifest validation, importer quarantine, and profile defaults; print `FAIL:` lines for any mismatch; leave a short machine-readable summary at the end so CI and humans can spot which subcheck failed.

##### [src/config/serde.ts](/media/smk/Shared/Code/VS Raptor/src/config/serde.ts)
- What changes: if needed for the smoke path or checkpoint migration helpers, expose stable read/write helpers reused by the smoke script and any one-time compatibility shim.

#### Edge cases
- Workspaces that only have `CLAUDE.md` or `instructions.md` should get a clear migration hint instead of appearing “empty” with no explanation.
- Imported external configs that happen to map cleanly to `.raptor` shapes should still be presented as migration candidates, not silently mixed into authoritative runtime state.

#### Verification
- Run: `npm run compile`
- Tests to add/update: add `npm run smoke:orchestration` covering config loading, importer quarantine, and manifest/profile sanity.
- Done: `.raptor` YAML is the only authoritative execution config, migration messages explain what Raptor detected from external tools, and users upgrading from pre-change imported agents or legacy checkpoints get explicit, observable migration behavior.

## Cross-cutting verification
- `npm run compile`
- `bash -n install.sh uninstall.sh`
- Manual VS Code smoke checks:
  - `/help` reflects the final command/tool surface
  - `/agent <id>` is request-scoped and no longer mutates ambient hidden state
  - `/flow <id>` shows a deterministic preflight plan and no removed flags
  - interrupt + resume preserves explicit step artifacts and resolved model metadata
  - `/build-flow` describes authoritative `.raptor/agents.yaml` + `.raptor/flows.yaml`
- Repo grep cleanup checks:
  - `rg -n 'autopilot|hawk-skills|--accept-models|--keep-current|--chat' README.md extension.ts src agents skills package.json --glob '!README.md' --glob '!skills/agent-flow-builder/SKILL.md' --glob '!agents/*.md'` for code paths
  - `rg -n 'autopilot|hawk-skills|--accept-models|--keep-current|--chat' README.md skills/agent-flow-builder/SKILL.md` for migration/docs only, where the match must be in an explicitly labeled migration section

## Standards / common-mistakes referenced
- No `.agents/standards/` directory present in this repo at planning time.
- No `.agents/common-mistakes/` directory present in this repo at planning time.

## Open questions (CONSIDER from review)
- If imported external assistant files become migration-only inputs, show their `origin` in `/agents` or a dedicated migration view so users can see why they are not active runtime agents.
- Consider a short deprecation window with warnings before removing legacy flow flags entirely if active users are likely to depend on them.
- Some Inc 4 docs cleanup can likely run in parallel with installer changes once Inc 1’s inventory is fixed.
- Pair repo grep cleanup checks with an allowlist so historical migration docs do not create false failures.

## Out of scope
- Rewriting the provider abstraction or deleting delegated CLI providers entirely in this plan.
- Making Claude Code, Codex, OpenCode, or Cursor runtime-equivalent to the VS Code flow runner.
- Splitting the repo into multiple packages or repositories.
- Large schema redesigns beyond what is required to support deterministic flow checkpoints/artifacts and importer quarantine.
