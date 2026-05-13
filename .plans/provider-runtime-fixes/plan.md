# Provider Runtime Fixes

## Context
The provider-model-switching implementation compiles, but runtime review found that the central user-visible guarantees are not true yet. Agent and flow model precedence is inverted, CLI providers exist but are not registered or model-switchable, native API providers advertise tool support without reliably emitting tool calls, provider fallback can return an undefined model, and API keys are exposed as plain VS Code settings.

The goal is to turn the current provider scaffold into a runtime that can be trusted for agentic workflows. Each increment must preserve the existing VS Code-only path.

## Architectural Decisions
- Decision: Replace the registry's ambiguous `(spec, requestModel)` API with an explicit ordered resolution input. Rationale: the current call shape made session-selected VS Code models outrank agent and flow overrides. Alternatives rejected: fixing only call sites while leaving the ambiguous API in place.
- Decision: Add a provider capability matrix before enabling more providers. Rationale: routing, `/models`, tool filtering, and docs need one shared truth for `native-tools`, `native-text`, `delegated`, and `unavailable`. Alternatives rejected: relying on each call site to interpret `supportsTools()` independently.
- Decision: Broken native API providers must report text-only until tool translation passes fixtures. Rationale: advertising tool support while dropping tool-call deltas causes silent non-agentic behavior. Alternatives rejected: shipping partial parsers that fail unpredictably.
- Decision: CLI providers are delegated/text-only providers. Rationale: `claude-code:...`, `codex:...`, and `opencode:...` should route correctly, but they should not receive Raptor's internal tool definitions. Alternatives rejected: emulating structured tool calls for CLIs in this pass.
- Decision: Secrets move to VS Code `SecretStorage` or environment variables before expanding provider registration. Rationale: new provider registration should not deepen the plain-setting API key pattern that must be deprecated.

## Assumptions And Answers From Code
- Decision: Main chat currently resolves models via `getRegistry().resolve(activeAgent.model ?? '', request.model?.id)`. Source: code @ `extension.ts:2066`.
- Decision: Flow steps currently resolve models via `getRegistry().resolve(stepAgent.model ?? '', request.model?.id)`. Source: code @ `extension.ts:2412`.
- Decision: Registry resolves `requestModel` before explicit `spec`. Source: code @ `src/providers/registry.ts:87`.
- Decision: CLI providers are not imported or registered in activation. Source: code @ `extension.ts:44` and `extension.ts:600`.
- Decision: CLI providers only list a `default` model and several CLIs ignore the requested model. Source: code @ `src/providers/cli.ts:21` and `src/providers/cli.ts:155`.
- Decision: Anthropic tool-call streaming is acknowledged but not emitted. Source: code @ `src/providers/anthropic.ts:150`.
- Decision: OpenAI and OpenRouter parse tool call arguments per delta rather than accumulating chunks. Source: code @ `src/providers/openai.ts:145` and `src/providers/openrouter.ts:142`.
- Decision: Registry returns `available[0]` for unmatched explicit providers without checking length. Source: code @ `src/providers/registry.ts:130`.
- Decision: API keys are configured as plain settings. Source: code @ `package.json:133`.
- Decision: No `.agents/standards` or `.agents/common-mistakes` directory was present in this repository.

## Risks Accepted
- Direct API schemas may change: mitigate by re-checking official provider docs during implementation and adding request/stream fixtures.
- CLI flags vary by version: mitigate by making command paths/args configurable and logging attempted commands without secrets.
- Secret migration can disrupt existing users: mitigate by preserving env vars and deprecated setting fallback for one release.
- Tool-less providers can surprise agents: mitigate by stripping tools for `native-text` and `delegated` providers and showing a progress note.

## Increment DAG
- Inc 1 - Resolution and capabilities (M) - depends on: none - unblocks: 2, 3, 4, 5
- Inc 2 - Fallback and tool gating (M) - depends on: 1 - unblocks: 3, 4, 5, 6
- Inc 3 - Provider config and secrets (M) - depends on: 2 - unblocks: 4, 6
- Inc 4 - CLI provider routing (M) - depends on: 2, 3 - unblocks: 6
- Inc 5 - Native API tool translation (L) - depends on: 2, 3 - unblocks: 6
- Inc 6 - Verification and docs alignment (M) - depends on: 4, 5 - unblocks: release

## Increments

### Inc 1 - Resolution And Capabilities (M)
**Depends on:** none
**Unblocks:** 2, 3, 4, 5
**Done criteria:** Flow step model overrides agent model, agent model overrides VS Code session-selected model, session-selected model overrides global fallback, progress labels name the correct source, and every provider exposes one capability state.

#### Files To Touch

##### src/providers/types.ts
- What changes: Add model reference, resolution source, and provider capability types.
- Function(s): type-only.
- Data shapes: `RaptorModelRef { providerId?: string; modelId: string; displayName?: string }`, `ModelResolutionSource = 'flow-step-override' | 'agent-override' | 'session-selected' | 'fallback'`, `ProviderCapability = 'native-tools' | 'native-text' | 'delegated' | 'unavailable'`.
- Integration points: provider registry, provider implementations, progress labels, `/models`.
- Error paths: none.

##### src/providers/registry.ts
- What changes: Replace `resolve(spec, requestModel?)` with an explicit ordered API.
- Function(s): `resolveModel(input: ModelResolutionInput): Promise<ResolvedModel>`.
- Data shapes: `ModelResolutionInput { flowStepModel?: string; agentModel?: string; sessionModel?: RaptorModelRef; fallbackModel?: string; allowFallbackForExplicitProvider?: boolean }`.
- Integration points: `extension.ts` main loop, sub-agent loop, flow loop, `/models`.
- Error paths: explicit provider unavailable throws `ProviderError` unless fallback is explicitly allowed; fallback search skips unavailable providers and throws `no-models` if none remain.

##### extension.ts
- What changes: Update main chat, sub-agent, flow, `/models`, and any provider/status call to pass named precedence slots and consume capability state.
- Function(s): `handleChatRequest`, `toolSpawnAgent`, `runFlow`.
- Data shapes: pass `request.model` as a VS Code `sessionModel` reference, not as the highest-priority request model.
- Integration points: progress output, `activeAgent.model`, `step.model`.
- Error paths: catch `ProviderError` and show provider/source-specific message.

#### Edge Cases
- Flow step with `model: "openai:gpt-..."` beats a session-selected VS Code model.
- Agent with `model: "anthropic:..."` beats a session-selected VS Code model.
- No agent/flow model preserves VS Code session-selected behavior.
- Plain fallback `raptor.model` still tries provider priority.

#### Verification
- Run: `npm run compile`.
- Add or run lightweight unit tests for registry precedence.
- Run: `rg -n "getRegistry\\(\\)\\.resolve|\\.resolve\\(" extension.ts src` and confirm no stale ambiguous registry call remains except the new named API.
- Manual: create one agent and one flow step with model overrides and verify progress labels.

### Inc 2 - Fallback And Tool Gating (M)
**Depends on:** 1
**Unblocks:** 3, 4, 5, 6
**Done criteria:** No resolved model can contain `undefined`; providers that do not support tools are never given tool definitions; broken native providers report text-only until Inc 5 repairs them; fallback behavior is explicit and logged.

#### Files To Touch

##### src/providers/registry.ts
- What changes: Remove unsafe `available[0]` returns unless `available.length > 0`.
- Function(s): explicit provider match branches and fallback branch.
- Data shapes: typed `ProviderError` for no models / explicit provider unavailable.
- Integration points: main loop, sub-agent loop, flow loop.
- Error paths: empty provider lists skip fallback candidates or throw `no-models` for explicit providers.

##### extension.ts
- What changes: Filter tools by provider capability.
- Function(s): `handleChatRequest`, `toolSpawnAgent`, `runFlow`.
- Data shapes: `tools = capability === 'native-tools' ? requestedTools : []`.
- Integration points: progress labels and provider send calls.
- Error paths: if a workflow uses a delegated/text-only provider, show a progress note and proceed text-only.

##### src/providers/anthropic.ts
- What changes: Report `native-text` / `supportsTools(false)` until Inc 5 fixes and tests tool streaming.
- Function(s): provider capability method.
- Data shapes: provider capability.
- Integration points: extension tool filtering.
- Error paths: none.

##### src/providers/openai.ts
- What changes: Report `native-text` / `supportsTools(false)` until Inc 5 fixes and tests tool streaming.
- Function(s): provider capability method.
- Data shapes: provider capability.
- Integration points: extension tool filtering.
- Error paths: none.

##### src/providers/openrouter.ts
- What changes: Report `native-text` / `supportsTools(false)` until Inc 5 fixes and tests tool streaming.
- Function(s): provider capability method.
- Data shapes: provider capability.
- Integration points: extension tool filtering.
- Error paths: none.

#### Edge Cases
- Ollama currently returns `supportsTools(false)` and should not receive tool definitions.
- CLI providers should not enter endless tool loops once registered.
- Explicit provider unavailable should not silently run on VS Code.

#### Verification
- Run: `npm run compile`.
- Manual: enable Ollama with no server; model resolution reports unavailable/no models and does not crash.
- Manual: run a delegated/text-only provider prompt and confirm no tool calls are attempted.

### Inc 3 - Provider Config And Secrets (M)
**Depends on:** 2
**Unblocks:** 4, 6
**Done criteria:** Provider constructors receive config from a shared loader that reads VS Code `SecretStorage` first, environment variables second, and deprecated plain settings last.

#### Files To Touch

##### src/providers/config.ts
- What changes: Add shared provider configuration loading.
- Function(s): `loadProviderConfigs(context): Promise<ProviderConfigMap>`, `getProviderSecret(context, providerId, key)`.
- Data shapes: `ProviderConfig { enabled; apiKey?; baseUrl?; command?; defaultModel?; deprecatedSettingUsed?: boolean }`.
- Integration points: `extension.ts` activation and all provider constructors.
- Error paths: missing key disables provider with a status reason; deprecated setting usage emits a warning without logging the key.

##### extension.ts
- What changes: Use shared provider config loader during activation.
- Function(s): `activate`.
- Data shapes: `ProviderConfigMap`.
- Integration points: native provider registration and later CLI provider registration.
- Error paths: log provider status without secrets.

##### package.json
- What changes: Mark existing plain API key settings as deprecated in descriptions and add command contribution points for setting/clearing secrets.
- Function(s): manifest only.
- Data shapes: commands `raptor.setProviderApiKey`, `raptor.clearProviderApiKey`.
- Integration points: command registration.
- Error paths: none.

##### src/commands/register.ts
- What changes: Add required commands to set/clear provider API keys through input boxes backed by `SecretStorage`.
- Function(s): `raptor.setProviderApiKey`, `raptor.clearProviderApiKey`.
- Data shapes: provider id and secret value.
- Integration points: package command contributions.
- Error paths: invalid provider id displays message.

#### Edge Cases
- Existing users with settings-based keys keep working with a warning for one release.
- `/models` must not reveal secrets.
- Output-channel logs must not include key values.

#### Verification
- Run: `npm run compile`.
- Manual: set key via secret command and verify provider appears in `/models`.
- Manual: remove key and verify provider becomes unavailable without crashing.
- Manual: verify output channel, `/models`, error messages, and packaged manifest do not contain secret values.

### Inc 4 - CLI Provider Routing (M)
**Depends on:** 2, 3
**Unblocks:** 6
**Done criteria:** `/models` lists enabled CLI providers, `claude-code:*`, `codex:*`, and `opencode:*` specs route to their provider instead of fallback, and delegated providers receive no Raptor tools.

#### Files To Touch

##### extension.ts
- What changes: Import and register `createClaudeCodeProvider`, `createCodexProvider`, and `createOpenCodeProvider` based on shared provider config.
- Function(s): `activate`.
- Data shapes: CLI provider configs.
- Integration points: provider registry and `/models`.
- Error paths: missing executable makes provider status unavailable without breaking activation.

##### package.json
- What changes: Add CLI providers to settings.
- Function(s): manifest only.
- Data shapes: extend `raptor.providers.enabled`, `raptor.defaultProvider` enum, and add command/path/default model settings for CLI providers.
- Integration points: `activate`.
- Error paths: invalid command/path emits output-channel warning.

##### src/providers/cli.ts
- What changes: Allow explicit requested model synthesis and configurable command/args.
- Function(s): `listModels`, `resolveModel?` or provider hook consumed by registry, `argsForModel`.
- Data shapes: `CliProviderDefinition { knownModels?: string[]; acceptsArbitraryModel: boolean; modelEnvKey?: string }`.
- Integration points: registry explicit provider resolution.
- Error paths: missing CLI command surfaces as provider unavailable, not an uncaught spawn error.

##### src/providers/claude-code.ts
- What changes: Use requested model in CLI args or `ANTHROPIC_MODEL`.
- Function(s): `createClaudeCodeProvider`.
- Data shapes: `claude-code:sonnet`, `claude-code:opus`, and arbitrary ids.
- Integration points: CLI provider config.
- Error paths: auth failure reported with provider id.

##### src/providers/codex-cli.ts
- What changes: Preserve arbitrary requested model in `--model`.
- Function(s): `createCodexProvider`.
- Data shapes: `codex:<model>`.
- Integration points: CLI provider config.
- Error paths: auth failure reported with provider id.

##### src/providers/opencode-cli.ts
- What changes: Preserve arbitrary requested model in CLI args.
- Function(s): `createOpenCodeProvider`.
- Data shapes: `opencode:<provider/model>`.
- Integration points: CLI provider config.
- Error paths: missing config/auth reported with provider id.

#### Edge Cases
- `listModels()` may show `default` plus configured known models, but explicit specs must not require the list.
- Delegated providers receive no Raptor tools.
- CLI subprocess cancellation terminates children.

#### Verification
- Run: `npm run compile`.
- Manual: `/models` shows CLI providers when enabled.
- Manual: `codex:test-model` progress shows provider `codex`, not fallback.
- Manual: delegated provider route with a fake model id does not fallback.

### Inc 5 - Native API Tool Translation (L)
**Depends on:** 2, 3
**Unblocks:** 6
**Done criteria:** Native providers either correctly execute a read-file style tool loop with fixture coverage or remain honestly marked text-only.

#### Files To Touch

##### src/providers/openai.ts
- What changes: Fix request message shapes and accumulate streamed tool-call deltas by index/id before yielding complete `tool_call` events.
- Function(s): `buildRequestBody`, `streamResponse`.
- Data shapes: assistant messages use provider-correct `tool_calls`; tool result messages use provider-correct role/content shape; stream accumulator tracks `id`, `name`, and argument fragments.
- Integration points: main loop dispatches yielded calls.
- Error paths: malformed accumulated JSON yields a provider error instead of silent drop; if tests cannot pass, keep provider `native-text`.

##### src/providers/openrouter.ts
- What changes: Mirror OpenAI-compatible request/stream fixes while preserving OpenRouter headers/base URL.
- Function(s): `buildRequestBody`, `streamResponse`.
- Data shapes: same accumulator as OpenAI.
- Integration points: main loop dispatches yielded calls.
- Error paths: provider-specific errors include response status and sanitized body excerpt; if tests cannot pass, keep provider `native-text`.

##### src/providers/anthropic.ts
- What changes: Convert system prompt correctly, place tool results in user messages, and accumulate `tool_use` input deltas until block stop before yielding a complete tool call.
- Function(s): `buildRequestBody`, `streamResponse`.
- Data shapes: Anthropic content blocks mapped to internal text/tool events.
- Integration points: main loop dispatches yielded calls.
- Error paths: incomplete tool JSON yields typed provider error; if tests cannot pass, keep provider `native-text`.

##### test/provider-fixtures/*
- What changes: Add provider-specific fixtures for outbound request bodies and streamed tool-call chunks.
- Function(s): test fixtures.
- Data shapes: OpenAI/OpenRouter streamed tool deltas, Anthropic `tool_use` blocks, post-tool-result continuation messages.
- Integration points: provider tests.
- Error paths: failing fixture means provider capability remains `native-text`.

#### Edge Cases
- Tool-call arguments may arrive over many chunks.
- Multiple tool calls may stream interleaved by index.
- Text and tool calls can appear in the same assistant response.
- Provider may stop after requesting tools with no text.

#### Verification
- Run: `npm run compile`.
- Add provider stream parser tests using captured chunk fixtures.
- Add provider request-shape tests for outbound initial requests and post-tool-result continuation.
- Manual: run `readFile` or `listDir` through each native provider that has credentials, or confirm it is shown as text-only.

### Inc 6 - Verification And Docs Alignment (M)
**Depends on:** 4, 5
**Unblocks:** release
**Done criteria:** README and package settings match actual runtime capabilities, and manual checks cover precedence, CLI routing, native tool calls/text-only fallback, cancellation, secret redaction, and explicit provider errors.

#### Files To Touch

##### README.md
- What changes: Update compatibility matrix with honest capabilities: VS Code/native tools/delegated/text-only.
- Function(s): docs only.
- Data shapes: examples for `vscode:`, `anthropic:`, `openai:`, `openrouter:`, `ollama:`, `claude-code:`, `codex:`, `opencode:`.
- Integration points: setup and usage.
- Error paths: explain explicit provider unavailable behavior.

##### src/tools/catalog.ts
- What changes: Ensure `/models` appears in help.
- Function(s): `buildHelpMarkdown`.
- Data shapes: help markdown.
- Integration points: `/help`.
- Error paths: none.

##### package.json
- What changes: Ensure commands/settings match actual providers and activation behavior.
- Function(s): manifest only.
- Data shapes: provider settings.
- Integration points: VS Code contribution points.
- Error paths: none.

##### docs/provider-runtime-verification.md
- What changes: Add durable checklist with exact manual scenarios.
- Function(s): docs/checklist only.
- Data shapes: table of scenario, setup, expected progress label, expected behavior.
- Integration points: release readiness.
- Error paths: capture known limitations.

#### Edge Cases
- Native provider credentials may not be available on every machine; checklist separates required no-credential checks from optional credentialed checks.
- Packaging can pass while runtime is broken; manual checklist is required before claiming completion.
- Provider enablement/settings changes may require extension reload; document that unless hot refresh is implemented.

#### Verification
- Run: `npm run compile`.
- Run: `npx vsce package --no-dependencies`.
- Manual: agent override beats session model.
- Manual: flow step override beats agent and session model.
- Manual: CLI provider route does not fallback silently.
- Manual: native provider executes at least one tool call or is marked text-only.
- Manual: unavailable explicit provider produces clear error.
- Manual: native stream cancellation and CLI subprocess cancellation both stop work.
- Manual: `/models`, output channel, errors, and package manifest do not expose secrets.

## Cross-Cutting Verification
- `npm run compile`
- `npx vsce package --no-dependencies`
- `/models` with default settings, no credentials, and one credentialed provider.
- A VS Code-only chat turn with tools.
- An agent override turn with a different model from the VS Code session-selected model.
- A flow with step model override.
- Explicit unavailable provider, for example `ollama:anything` while server is stopped.
- Delegated provider route with a fake model id to confirm it does not fallback.
- Native provider either executes one tool call or is marked text-only.
- Native stream cancellation and CLI subprocess cancellation.
- No secret values in `/models`, output channel, error messages, or packaged manifest.

## Standards / Common-Mistakes Referenced
- No `.agents/standards` or `.agents/common-mistakes` files were present.
- Current code references: `extension.ts`, `src/providers/registry.ts`, `src/providers/cli.ts`, `src/providers/anthropic.ts`, `src/providers/openai.ts`, `src/providers/openrouter.ts`, `package.json`.

## Open Questions (CONSIDER From Review)
- CONSIDER: Whether to keep native API providers text-only for one release while tool-call translation receives fixture coverage.
- CONSIDER: Whether provider settings should refresh without extension reload; current plan allows reload if documented.
- CONSIDER: Whether explicit provider failures should ever fallback automatically; current plan defaults to no fallback for explicit providers.

## Out Of Scope
- Full CLI structured tool-call support.
- Bidirectional sync into external tool config files.
- Replacing the VS Code chat participant UI.
- Comprehensive test runner beyond focused provider/registry tests unless needed to complete these fixes.
