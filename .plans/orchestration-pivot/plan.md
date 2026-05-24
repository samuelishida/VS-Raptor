# Orchestration Pivot

## Context
Raptor currently mixes three concerns in one runtime path: VS Code chat orchestration, config authoring/loading, and a broad provider surface that still includes direct HTTP providers. The next iteration should tighten the product around the targets that matter now: VS Code runtime orchestration, delegated CLI providers (`claude-code`, `codex`, `opencode`), and installable skill/agent packs for Claude Code, Codex, OpenCode, and Cursor. The user also wants persisted agent/flow config to move from JSON to YAML, wants `/build-flow` to remain as a convenience alias with sensible defaults when no arguments are provided, and wants removed command / `raptor`-router references cleaned up immediately rather than hidden behind a compatibility shim.

## Architectural decisions
- Decision: keep the provider registry abstraction, but reduce the concrete provider implementations to `vscode` plus delegated CLIs. Rationale: `extension.ts` currently resolves models and providers through a shared registry, and delegated CLIs still need shared resolution, command validation, availability reporting, and fallback selection. Alternatives rejected: deleting the registry entirely would reintroduce provider branching in the chat loop and make delegated CLIs harder to manage consistently.
- Decision: move persisted orchestration config to YAML-first files while retaining a temporary legacy JSON import path during the migration. Rationale: the user asked for YAML, but an immediate hard cut would strand existing `.raptor/agents.json` / `flows.json` users between increments. Alternatives rejected: an all-at-once JSON removal in Inc 1 creates an avoidable migration cliff.
- Decision: keep `/build-flow` as a thin VS Code alias for the installed `agent-flow-builder` workflow, not as a separate parallel authoring system. Rationale: the extension already injects skill instructions into the chat loop; keeping one authoring workflow prevents drift between slash-command UX and installed skill UX. Alternatives rejected: moving all entrypoints to `/skills` only would make the common case slower and was explicitly rejected by the user.
- Decision: treat Cursor as a packaging/install target, not a first-class model provider. Rationale: current code only has VS Code and CLI provider runtimes, while Cursor appears in docs/install surfaces. Alternatives rejected: inventing a Cursor runtime provider in the same plan would add unvalidated surface area with no code precedent.
- Decision: separate canonical agent/skill source content from target-specific install rendering inside the current repo. Rationale: current `agents/*.md` content is copied verbatim even though target tools have different expectations. Alternatives rejected: splitting the repo or publishing a separate skill-pack package is out of scope for this plan.
- Decision: enforce a strict settings trust boundary for CLI launch configuration. `raptor.provider.<id>.command` is honored only from user or machine scope; workspace and folder overrides are ignored with a warning and the built-in command is used instead. `raptor.provider.<id>.baseUrl` is removed from the consolidated runtime, so any lingering workspace value is treated as unsupported legacy config and ignored. `raptor.providers.enabled`, `raptor.defaultProvider`, and `defaultModel` may remain workspace-configurable because they do not change executable paths or credentials.

## Assumptions and answers from code
- Decision: `/build-flow` already exists as a VS Code chat command and is injected by `extension.ts`. Source: code @ `package.json:104`, `extension.ts:1685`, `extension.ts:1904`.
- Decision: current config discovery is root-based and precedence-ordered across `~/.raptor`, workspace `.github`, `.claude`, `.opencode`, `.codex`, and `.raptor`. Source: code @ `src/config/loader.ts:54`, `src/config/loader.ts:83`.
- Decision: persisted agents/flows are currently JSON-only (`agents.json`, `flows.json`) and the skill text still instructs JSON read/write. Source: code @ `src/config/loader.ts:56`, `src/config/loader.ts:417`, `src/config/loader.ts:430`, `skills/agent-flow-builder/SKILL.md:12`, `skills/agent-flow-builder/SKILL.md:36`.
- Decision: the runtime still creates direct API providers for `anthropic`, `openai`, `openrouter`, and `ollama` during activation. Source: code @ `extension.ts:251`, `extension.ts:260`, `extension.ts:269`, `extension.ts:278`, `extension.ts:287`.
- Decision: delegated CLI providers already exist for `claude-code`, `codex`, and `opencode`, all sharing `src/providers/cli.ts`. Source: code @ `extension.ts:291`, `extension.ts:295`, `extension.ts:299`, `src/providers/cli.ts:370`.
- Decision: the OpenCode importer currently rewrites bare model names to `openai:<model>`, which will become invalid if direct OpenAI support is removed. Source: code @ `src/config/importers/opencode.ts:72`.
- Decision: the default `_default` agent is currently synthesized at load time and depends on `agent-flow-builder` being available. Source: code @ `src/config/loader.ts:352`.
- Decision: Cursor is currently represented in docs/install positioning, not as a runtime provider. Source: code @ `README.md:197`, `README.md:211`.
- Decision: there is no `.agents/standards/` or `.agents/common-mistakes/` directory in this repo today. Source: code search @ `find .agents -maxdepth 2 -type f`.
- Decision: project check command is `npm run compile`. Source: code @ `package.json:46`.
- Decision: user-confirmed choices for this plan are: keep `/build-flow`, enhance it, and default missing inputs; clean up removed commands / `raptor` references immediately; move persisted config to YAML; streamline provider architecture around VS Code, Claude Code, Codex, OpenCode, and Cursor; do not split the repo; do not redesign specialist planning/audit skills beyond removing explicit public `raptor` references. Source: user-confirmed.

## Risks accepted
- YAML migration risk: comment and formatting preservation will not be guaranteed if we rewrite legacy config through a serializer. Mitigation: preserve semantic data, not exact formatting, and document that migration rewrites structure.
- Packaging drift risk: target-specific agent install rendering introduces another layer that can fall out of sync. Mitigation: define a single canonical source format and make installers/renderers deterministic.
- Breaking-change risk for provider users: removing direct API providers and their settings will break users who rely on them. Mitigation: ship the removal in a dedicated increment with explicit README/settings cleanup and release-note callouts.
- Security hardening tradeoff: restricting CLI command overrides to trusted/user scope may remove a currently-flexible workspace override path. Mitigation: prefer safety and document the supported override locations.

## Increment DAG
- Inc 1 — YAML Config Substrate (M) — depends on: none — unblocks: 2, 3, 5
- Inc 2 — `/build-flow` Alias and Authoring Defaults (M) — depends on: 1 — unblocks: 4, 5
- Inc 3 — Provider Surface Consolidation (L) — depends on: 1 — unblocks: 4, 5
- Inc 4 — Target Packaging Cleanup (M) — depends on: 2, 3 — unblocks: 5
- Inc 5 — Migration Sweep and Verification (M) — depends on: 2, 3, 4 — unblocks: release

## Increments

### Inc 1 — YAML Config Substrate (M)
**Depends on:** none  
**Unblocks:** 2, 3, 5  
**Status:** done  
**Done criteria:** Raptor can load agents and flows from YAML files, write paths are centralized, and legacy JSON can still be imported without breaking existing workspaces.

#### Files to touch

##### `package.json`
- What changes: add the runtime YAML dependency and any supporting script entries needed for config migration checks.
- Data shapes: no schema changes here beyond dependency metadata.
- Integration points: compile/runtime module resolution.
- Error paths: missing dependency or bundling mismatch should fail at compile time.

##### `src/config/loader.ts`
- What changes: replace hard-coded `agents.json` / `flows.json` assumptions with YAML-first collection discovery and a single read path per collection.
- Function(s): introduce helpers such as `readConfigCollection(kind: 'agents' | 'flows')`, `discoverConfigFile(root, kind)`, `parseCollectionFile(text, source, kind)`.
- Data shapes: support `Agent[]`, `Flow[]`, and optionally `{ agents: Agent[] }` / `{ flows: Flow[] }` in YAML and legacy JSON.
- Integration points: existing `loadConfig()`, cache signature computation, config root precedence, warnings collection.
- Error paths: malformed YAML/JSON must produce warnings tied to the file path without crashing the loader.

##### `src/config/*` (new helper module, e.g. `serde.ts` or `files.ts`)
- What changes: centralize parse/stringify logic and config file naming so authoring and loading use the same rules.
- Function(s): `serializeAgentsYaml(agents: Agent[]): string`, `serializeFlowsYaml(flows: Flow[]): string`, `legacyJsonPathFor(kind)`.
- Data shapes: canonical YAML output format for agents and flows.
- Integration points: consumed by Inc 2 write path and Inc 5 migration sweep.
- Error paths: serialization should be total for normalized config objects.

##### `README.md`
- What changes: document YAML as the primary persisted format and describe the temporary JSON migration behavior.
- Integration points: config location and authoring sections.
- Error paths: doc drift against loader behavior.

#### Edge cases
- Both YAML and legacy JSON exist for the same root and collection.
- YAML exists but is empty or contains only comments.
- Imported `.opencode` / `.claude` / `.codex` config continues to merge correctly beside YAML-first native config.

#### Verification
- Run: `npm run compile`
- Tests to add/update: compile-level verification plus a manual workspace check with `agents.yaml`, `flows.yaml`, and a legacy JSON-only workspace.
- Done: `/agents` and `/flows` reflect YAML-authored entries; malformed YAML produces a readable warning instead of a crash.

### Inc 2 — `/build-flow` Alias and Authoring Defaults (M)
**Depends on:** 1  
**Unblocks:** 4, 5  
**Status:** done  
**Done criteria:** `/build-flow` remains available, empty invocation starts an interview with sensible defaults, and generated config is YAML-backed instead of JSON-backed.

#### Files to touch

##### `extension.ts`
- What changes: reduce `/build-flow` to a thin alias that injects the `agent-flow-builder` workflow plus YAML-aware defaults instead of a JSON-specific hard-coded script.
- Function(s): replace `injectBuildFlowCommand(messages)` with a version that can inject default values and optional parsed hints from the slash-command arguments.
- Data shapes: optional default bundle such as `{ flowKind, toolScope, modelPreference, skillIds }`.
- Integration points: request command handling, message construction, active agent prompt composition.
- Error paths: missing skill content should degrade to a clear user-facing error, not a silent no-op.

##### `skills/agent-flow-builder/SKILL.md`
- What changes: rewrite the skill contract around `.raptor/agents.yaml` / `.raptor/flows.yaml`, default-value behavior, and no-required-flags authoring.
- Data shapes: YAML examples for agents and flows, default tool/model behavior when omitted.
- Integration points: VS Code `/build-flow`, installed skill usage in Codex/OpenCode/Claude Code, README command examples.
- Error paths: malformed existing YAML should still block writes with a precise explanation.

##### `src/tools/catalog.ts`
- What changes: refresh help text so `/build-flow` is described as a convenience alias for the installed flow-builder workflow.
- Integration points: `/help` output.

##### `README.md`
- What changes: update command docs and flow-authoring examples to show YAML paths and defaulted `/build-flow`.
- Error paths: docs must match the actual interview/write behavior.

#### Edge cases
- `/build-flow` with no prompt at all.
- `/build-flow` with a terse prompt but no explicit model/tools.
- User already has existing agents/flows with the same ids and needs replacement semantics preserved.

#### Verification
- Run: `npm run compile`
- Tests to add/update: manual invocation of `/build-flow` with and without trailing text.
- Done: empty `/build-flow` starts the interview, and generated files are YAML with merged existing entries preserved.

### Inc 3 — Provider Surface Consolidation (L)
**Depends on:** 1  
**Unblocks:** 4, 5  
**Status:** done  
**Done criteria:** the supported runtime providers are `vscode`, `claude-code`, `codex`, and `opencode`; direct API providers and their settings are removed; command/env trust boundaries are tightened for delegated CLIs.

#### Files to touch

##### `extension.ts`
- What changes: replace the current `switch`-based provider bootstrap with a compact factory/registration path for the supported provider set only.
- Function(s): activation provider-registration block, any provider-specific help text, error messages that still mention removed providers.
- Integration points: startup, `/models`, chat resolution fallback messaging.
- Error paths: unknown provider ids in settings should log warnings and be ignored.

##### `src/providers/config.ts`
- What changes: shrink provider config loading to the supported ids, define the canonical provider catalog, and enforce the trust policy above when reading provider launch settings.
- Function(s): `loadProviderConfigs()`, `getProviderSecret()`.
- Data shapes: provider config map for `vscode`, `claude-code`, `codex`, `opencode` only; trust metadata for ignored workspace overrides.
- Integration points: `extension.ts`, settings schema in `package.json`.
- Error paths: unsupported legacy provider ids should emit deprecation/removal warnings, not silently mutate behavior.

##### `src/providers/cli.ts`
- What changes: harden delegated CLI launch behavior by limiting inherited environment variables to an allowlist plus explicitly provided secrets, and by validating command overrides against the policy above.
- Function(s): `buildEnv()`, command resolution / runtime config handling.
- Data shapes: allowlisted env map, normalized command config.
- Integration points: `claude-code`, `codex`, `opencode` provider wrappers.
- Error paths: rejected commands or untrusted overrides should surface clear provider-unavailable messages.

##### `src/providers/registry.ts`
- What changes: simplify fallback and provider ordering around the reduced provider set, while preserving model resolution semantics and explicit-provider error reporting.
- Function(s): fallback ordering and explicit-provider resolution paths.
- Integration points: main chat loop, flow runner, `/models`.

##### `src/config/importers/opencode.ts`
- What changes: stop normalizing OpenCode bare model names to removed provider prefixes and align imported model specs with the delegated OpenCode provider semantics.
- Function(s): `normalizeModelSpec()`.
- Data shapes: bare model names should resolve to `opencode:<model>` or another explicitly chosen supported shape.
- Integration points: workspace `.opencode` imports, model resolution, migration of existing OpenCode-authored configs.
- Error paths: imported configs that already use removed provider prefixes should warn clearly.

##### `src/commands/register.ts`
- What changes: remove or repurpose SecretStorage commands that only existed for direct API providers.
- Integration points: command palette surface, activation events, README command docs.
- Error paths: stale command ids in old keybindings should fail predictably rather than point to dead behavior.

##### `src/providers/anthropic.ts`
- What changes: remove.
- Integration points: compile graph, imports, README references.

##### `src/providers/openai.ts`
- What changes: remove.
- Integration points: compile graph, imports, README references.

##### `src/providers/openrouter.ts`
- What changes: remove.
- Integration points: compile graph, imports, README references.

##### `src/providers/ollama.ts`
- What changes: remove from runtime provider surface as part of the same consolidation.
- Integration points: compile graph, imports, settings docs, model examples.

##### `package.json`
- What changes: update configuration schema so `raptor.defaultProvider` and `raptor.providers.enabled` only expose the supported providers; remove deprecated direct-provider settings and any command contributions/activation events that only served direct API key management.
- Integration points: VS Code settings UI, command palette, extension activation.
- Error paths: stale user settings remain in `settings.json` but no longer affect runtime.

##### `README.md`
- What changes: rewrite provider setup docs around VS Code plus delegated CLIs, and explicitly position Cursor as an install target rather than a provider.

#### Edge cases
- Workspace settings still contain removed provider ids.
- Default provider points to a removed provider after upgrade.
- CLI binary exists but is not authenticated or not installed.
- Model spec references a removed provider prefix.

#### Verification
- Run: `npm run compile`
- Tests to add/update: manual `/models` inspection across supported providers; manual failure-path checks for missing CLI binaries and removed provider settings.
- Done: no code path imports or registers removed providers, and provider help/docs only reference the supported set.

### Inc 4 — Target Packaging Cleanup (M)
**Depends on:** 2, 3  
**Unblocks:** 5  
**Status:** done  
**Done criteria:** installed assets for Claude Code, Codex, OpenCode, and Cursor are derived from one canonical source surface inside this repo, and install/uninstall agree on the exact render destinations.

#### Files to touch

##### `agents/`
- What changes: keep `agents/` as the single canonical source tree for specialist agent definitions, and render each file into target-specific agent directories instead of copying verbatim.
- Generated destinations: `~/.claude/agents/<name>.md`, `~/.codex/agents/<name>.md`, `~/.opencode/agents/<name>.md`, `~/.cursor/agents/<name>.md`.
- Data shapes: canonical agent metadata fields plus prompt body.
- Integration points: installers, packaged skill/agent assets, audit/planning flows.
- Error paths: invalid canonical metadata should fail render-time validation.

##### `install.sh`
- What changes: stop treating agent files as opaque copies; render canonical agent content into the exact target directories above, including any target-specific frontmatter or path rewrites.
- Integration points: Claude/Codex/OpenCode/Cursor install flows, namespacing/prefix handling.
- Error paths: target render failures must stop the install with a clear message.

##### `uninstall.sh`
- What changes: mirror the exact target destinations and naming rules from `install.sh`.
- Integration points: target-specific cleanup.

#### Edge cases
- Prefix-scoped installs and uninstalls across multiple targets.
- Claude-target formatting differences versus Cursor/Codex/OpenCode expectations.
- Agent frontmatter or content that needs target-specific name/path rewrites.

#### Verification
- Run: `bash -n install.sh uninstall.sh` and `npm run compile`
- Tests to add/update: manual dry-run installs for at least Claude and Cursor surfaces.
- Done: target installs no longer depend on accidental compatibility of raw source files.

### Inc 5 — Migration Sweep and Verification (M)
**Depends on:** 2, 3, 4  
**Unblocks:** release  
**Status:** done  
**Done criteria:** migration behavior is coherent end to end, dead JSON/provider/documentation remnants are removed or deliberately retained as legacy import only, and the release surface matches the new architecture.

#### Files to touch

##### `README.md`
- What changes: final docs sweep for YAML config, provider surface, `/build-flow`, install targets, and removed legacy references.

##### `skills/**/*.md`
- What changes: final sweep for stale public `raptor` router references and any examples that still assume the old command surface.
- Integration points: installable skill UX across non-VS-Code tools.

##### `skills/agent-flow-builder/SKILL.md`
- What changes: final example cleanup after Inc 4 packaging decisions land.

##### `src/config/loader.ts` and supporting config helpers
- What changes: remove any transitional duplication that Inc 1 needed, keeping YAML as the canonical source of truth and treating legacy JSON as import-only fallback during migration.
- Integration points: warnings, precedence, serialization helpers.

##### `extension.ts` and `src/tools/catalog.ts`
- What changes: final wording cleanup for help/error messages that still mention removed providers, JSON files, or deprecated compatibility language.

##### Release-note / migration doc file if added by the team
- What changes: document how existing JSON users migrate and what provider settings were removed.

#### Edge cases
- YAML and JSON both present in the same root after migration.
- Users upgrading directly from a release that still used direct API providers.
- New docs drifting from actual install/runtime behavior.

#### Verification
- Run: `npm run compile` and `bash -n install.sh uninstall.sh`
- Tests to add/update: manual release checklist covering VS Code runtime, delegated CLI availability, YAML authoring, and target installs.
- Done: the repo can be described accurately without caveats about the old provider surface or JSON-first config.

## Cross-cutting verification
- In VS Code, confirm `/build-flow` with no arguments starts the interview, writes YAML, and leaves `/agents`, `/flows`, and `/flow <id>` working.
- In a workspace that still has only legacy JSON, confirm the loader surfaces data and warns about the migration path instead of failing silently.
- With only `vscode` enabled, confirm normal orchestration still works.
- With each delegated CLI provider enabled one at a time, confirm `/models` and a simple chat request show clean availability or clean failure messaging.
- Dry-run install/uninstall flows for Claude Code, Codex/OpenCode, and Cursor-facing assets after packaging cleanup.

## Standards / common-mistakes referenced
- None present in `.agents/standards/` or `.agents/common-mistakes/` at planning time.

## Open questions (CONSIDER from review)
- Should legacy JSON loading remain indefinitely as a warning-backed fallback, or should a later release convert it into an explicit one-shot import command?
- Do we want Cursor installs to emit only rule/instruction files, or also install the canonical specialist agent content in a Cursor-specific discoverable location?

## Out of scope
- Redesigning the specialist planning/audit skills beyond removing explicit public `raptor` references.
- Splitting the repository into separate extension and skill-pack repos or packages.
- Adding new runtime providers beyond VS Code and the delegated CLI set.
- Reintroducing a compatibility shim for removed commands or public `raptor` skill references.
