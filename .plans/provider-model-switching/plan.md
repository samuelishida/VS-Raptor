# Provider Model Switching Compatibility

## Context
VS Raptor currently runs inside VS Code and chooses models through `vscode.lm.selectChatModels()`. Agents and flows can specify `model`, but the resolved runtime model is still a `vscode.LanguageModelChat`. The goal is to make the same agent and flow model switching compatible with provider-qualified model specs such as `vscode:...`, `anthropic:...`, `openai:...`, `openrouter:...`, `ollama:...`, and delegated CLI-backed routes for Claude Code, Codex, and OpenCode.

The intended outcome is that users can keep one Raptor agent/flow config style while choosing the runtime per agent or per flow step. VS Code models remain the default path, but direct API and CLI provider support can be added without rewriting the chat loop every time.

## Architectural decisions
- Decision: Introduce a provider-neutral runtime interface instead of extending `vscode.LanguageModelChat` conditionals. Rationale: the current call sites assume VS Code message parts, tool calls, and `sendRequest`; a provider boundary lets each backend translate once. Alternatives rejected: adding `if provider === ...` branches inside `resolveModelForRequest`, `handleChatRequest`, `runFlow`, and summarization helpers.
- Decision: Keep VS Code as the first provider and default behavior. Rationale: this preserves current extension behavior and de-risks the first increment. Alternatives rejected: switching immediately to direct APIs for all models.
- Decision: Use provider-qualified model specs as the stable public syntax. Rationale: `vendor:model` already exists in config examples and maps naturally to providers. Alternatives rejected: separate `provider` and `model` config fields, because that makes per-flow-step overrides noisier and creates migration churn.
- Decision: Split native tool-loop providers from delegated-run providers. Rationale: OpenAI, Anthropic, OpenRouter, Ollama, and VS Code can participate in Raptor's tool loop; Claude Code, Codex CLI, and OpenCode may be better treated as subprocess runners that own their own loop. Alternatives rejected: forcing every CLI to emulate VS Code structured tool calls in the first pass.
- Decision: Add config importers after the provider registry, not before. Rationale: importing `.claude`, `.codex`, or `.opencode` conventions is useful only once Raptor has a clear normalized runtime model spec to target.

## Assumptions and answers from code
- Decision: Current runtime is VS Code LM-only. Source: code @ `src/config/model.ts:77`, where `resolveModelForRequest` returns `vscode.LanguageModelChat`; code @ `extension.ts:2040`, where the main loop calls `model.sendRequest(...)`.
- Decision: Agent and flow config already expose `model` strings that can carry provider-qualified specs. Source: code @ `src/config/loader.ts:13` and `src/config/loader.ts:24`.
- Decision: Config roots already include `.opencode` and `.claude`, but not `.codex`. Source: code @ `src/config/loader.ts:51`.
- Decision: Flow step overrides already outrank agent models. Source: code @ `extension.ts:2328` and `extension.ts:2338`.
- Decision: The main loop and flow loop share the same conceptual tool-call protocol. Source: code @ `extension.ts:2046` and `extension.ts:2388`.
- Decision: Summarization and memory extraction also depend directly on VS Code models. Source: code @ `extension.ts:304`, `extension.ts:436`, and `extension.ts:482`.
- Decision: There is no local `.agents/standards` directory in this repo. Source: code search / filesystem check.
- Decision: Claude Code has first-class model switching/config through `/model`, `--model`, `ANTHROPIC_MODEL`, and settings `model`. Source: Anthropic Claude Code model configuration, checked May 11, 2026.
- Decision: OpenCode has config-level `provider`, `model`, `small_model`, enabled/disabled provider lists, instructions, tools, MCP, and plugin settings. Source: OpenCode config/providers docs, checked May 11, 2026.
- Decision: Codex CLI uses `~/.codex/config.toml` / `$CODEX_HOME` configuration concepts and model/provider settings. Source: OpenAI Codex repository docs, checked May 11, 2026.
- Assumption: Direct API providers may require user-supplied API keys via VS Code settings or environment variables; keys should not be stored in agent/flow files.
- Assumption: CLI providers should initially be delegated-run only, not full structured tool-call providers.

## Risks accepted
- Provider SDK churn: mitigate by isolating provider code under `src/providers/` and keeping the core loop typed against Raptor-owned interfaces.
- Tool-call schema mismatch: mitigate by defining one internal `RaptorToolCall` shape and translation tests per provider.
- Streaming behavior differences: mitigate by making provider responses async iterables of text/tool events.
- CLI behavior instability: accept for delegated-run providers; revisit if a CLI exposes stable JSON or MCP-style tool-call protocols.
- Secret handling mistakes: mitigate by reading API keys from VS Code settings or env vars only and redacting provider errors in UI/logs where needed.

## Increment DAG
- Inc 1 - Runtime provider core (M) - depends on: none - unblocks: 2, 3, 4, 5
- Inc 2 - VS Code provider migration (M) - depends on: 1 - unblocks: 3, 6
- Inc 3 - Native API provider adapters (L) - depends on: 1, 2 - unblocks: 5, 6
- Inc 4 - CLI delegated providers (M) - depends on: 1 - unblocks: 5, 6
- Inc 5 - Config compatibility importers (M) - depends on: 1, 3, 4 - unblocks: 6
- Inc 6 - UI, docs, and verification polish (M) - depends on: 2, 3, 4, 5 - unblocks: release

## Increments

### Inc 1 - Runtime Provider Core (M)
**Depends on:** none
**Unblocks:** 2, 3, 4, 5
**Done criteria:** The codebase has provider-neutral model, message, response, and tool-call types plus a registry, with no behavior change yet.

#### Files to touch

##### src/config/model.ts
- What changes: Convert parsing and ranking helpers to return provider-neutral model specs/resolution plans.
- Function(s): `parseModelSpec(spec: string): ModelSpec`, `normalizeModelSpec(spec: string): string`
- Data shapes: `ModelSpec { provider?: string; model: string; raw: string }`
- Integration points: consumed by new provider registry and existing `resolveModelForRequest` wrapper during migration.
- Error paths: invalid empty model strings return a typed parse error or fallback marker, not a thrown exception.

##### src/providers/types.ts
- What changes: Add provider-neutral runtime interfaces.
- Function(s): type-only module.
- Data shapes: `RaptorModel`, `RaptorModelRequest`, `RaptorMessage`, `RaptorResponseEvent`, `RaptorToolCall`, `RaptorToolResult`, `ModelProvider`.
- Integration points: main loop, flow loop, summarization helpers, future adapters.
- Error paths: provider errors use a common `ProviderError` with `provider`, `code`, and user-safe `message`.

##### src/providers/registry.ts
- What changes: Add provider registration, model listing, model selection, and fallback behavior.
- Function(s): `createProviderRegistry(context): ProviderRegistry`, `resolveRuntimeModel(spec, requestModel?)`.
- Data shapes: `ResolvedModel { provider: ModelProvider; model: RaptorModel; source: string; available: RaptorModel[] }`.
- Integration points: replaces direct calls to `vscode.lm.selectChatModels()` after Inc 2.
- Error paths: unavailable provider falls through to default provider or first available model according to existing README behavior.

#### Edge cases
- Plain model specs such as `claude-sonnet-4.6` should still try all providers in configured priority order.
- Provider-qualified specs must not match a different provider.
- A missing provider should produce an actionable error when no fallback exists.

#### Verification
- Run: `npm run compile`
- Tests to add/update: unit tests for `parseModelSpec`, provider-qualified matching, and fallback source labels once a test harness exists.
- Done: existing chat behavior can still resolve VS Code models through a compatibility wrapper.

### Inc 2 - VS Code Provider Migration (M)
**Depends on:** 1
**Unblocks:** 3, 6
**Done criteria:** Main chat, sub-agent, flow, compaction, and memory extraction all use the provider-neutral interface while behavior remains equivalent for VS Code models.

#### Files to touch

##### src/providers/vscode.ts
- What changes: Implement `ModelProvider` for VS Code Language Model API.
- Function(s): `listModels()`, `sendRequest(request)`, `supportsTools()`.
- Data shapes: Translates `RaptorMessage` to `vscode.LanguageModelChatMessage` and `RaptorResponseEvent` from `LanguageModelTextPart` / `LanguageModelToolCallPart`.
- Integration points: registry default provider.
- Error paths: wraps `sendRequest` failures in `ProviderError`.

##### extension.ts
- What changes: Replace direct `vscode.LanguageModelChat` usage in main loop, flow loop, sub-agent loop, compaction, summaries, and memory extraction with `ResolvedModel`.
- Function(s): `handleChatRequest`, `toolSpawnAgent`, `fullCompactMessages`, `generateSessionSummary`, `extractAndStoreMemories`, `runFlow`.
- Data shapes: `messages` become `RaptorMessage[]` internally, or use adapter conversion at the boundary if a smaller migration is preferred.
- Integration points: `dispatchTool`, `renderToolResultDropdown`, `getToolDefs`.
- Error paths: provider errors render as model errors with provider/source included.

##### src/chat/message-adapter.ts
- What changes: Encapsulate conversion between VS Code chat history/request data and internal messages.
- Function(s): `buildRuntimeMessages(...)`, `appendToolResult(...)`, `compactRuntimeMessages(...)`.
- Data shapes: `RaptorMessage`.
- Integration points: replaces repeated message construction in main and flow loops.
- Error paths: unsupported message parts are ignored with debug logging, matching current text-only history behavior.

#### Edge cases
- `request.model` from VS Code chat UI should be treated as a VS Code provider session-selected model.
- Flow step `model` should still override agent and session-selected model.
- The local-model queue should key off provider plus model id, not VS Code model id alone.

#### Verification
- Run: `npm run compile`
- Run: `npx vsce package --no-dependencies`
- Manual: Use `@raptor`, `/agent`, and `/flow` with VS Code-exposed models and confirm progress labels preserve source labels.

### Inc 3 - Native API Provider Adapters (L)
**Depends on:** 1, 2
**Unblocks:** 5, 6
**Done criteria:** Raptor can route model specs to direct providers for Anthropic, OpenAI, OpenRouter, and Ollama while preserving the internal tool loop for providers that support tool calls.

#### Files to touch

##### package.json
- What changes: Add dependencies only when needed and prefer lightweight fetch-based adapters where practical.
- Function(s): package metadata only.
- Data shapes: new VS Code settings for provider enablement and API keys.
- Integration points: extension activation and provider registry.
- Error paths: missing keys disable the provider with a warning, not a startup failure.

##### src/providers/anthropic.ts
- What changes: Implement direct Claude API model listing where possible and chat/tool-call request translation.
- Function(s): `createAnthropicProvider(config): ModelProvider`.
- Data shapes: maps Anthropic content blocks to `RaptorResponseEvent`.
- Integration points: registry with provider id `anthropic`.
- Error paths: missing `ANTHROPIC_API_KEY` or VS Code secret setting disables provider.

##### src/providers/openai.ts
- What changes: Implement OpenAI/Codex-style direct API route.
- Function(s): `createOpenAIProvider(config): ModelProvider`.
- Data shapes: maps responses/tool calls to internal events.
- Integration points: provider id `openai`; supports specs such as `openai:gpt-5.2` and `openai:gpt-5.3-codex`.
- Error paths: missing key disables provider.

##### src/providers/openrouter.ts
- What changes: Implement OpenRouter route for provider/model names like `openrouter:anthropic/claude-...`.
- Function(s): `createOpenRouterProvider(config): ModelProvider`.
- Data shapes: provider-specific model ids remain opaque after the first colon.
- Integration points: provider id `openrouter`.
- Error paths: missing key disables provider.

##### src/providers/ollama.ts
- What changes: Implement local HTTP Ollama route.
- Function(s): `createOllamaProvider(config): ModelProvider`.
- Data shapes: model list from `/api/tags`; streaming events from chat endpoint.
- Integration points: local-model queue and provider registry.
- Error paths: connection refused disables provider with actionable status text.

#### Edge cases
- Re-check official provider API docs at implementation time; model/tool schemas and supported endpoints change frequently.
- Providers with no model-list endpoint should expose a configured/static model list and still allow explicit specs.
- Tool calls may need provider-specific JSON schemas; translation must preserve `callId`, `name`, and `input`.
- Some models do not support tools. The registry should reject them for agentic loops or run text-only with a clear status.

#### Verification
- Run: `npm run compile`
- Manual: With keys configured, run one text-only prompt and one tool-using prompt per provider.
- Manual: Run a flow that switches `anthropic:...` to `openai:...` to `ollama:...`.

### Inc 4 - CLI Delegated Providers (M)
**Depends on:** 1
**Unblocks:** 5, 6
**Done criteria:** Raptor can delegate a whole step/request to Claude Code, Codex, or OpenCode CLIs when configured, with model switching handled by provider-qualified specs.

#### Files to touch

##### src/providers/cli.ts
- What changes: Shared subprocess runner for delegated providers.
- Function(s): `createCliProvider(definition): ModelProvider`, `runDelegatedPrompt(...)`.
- Data shapes: `CliProviderDefinition { id; command; argsForModel(model, prompt); cwdPolicy; envKeys }`.
- Integration points: provider registry.
- Error paths: missing executable, non-zero exit, timeout, and cancellation all return provider errors.

##### src/providers/claude-code.ts
- What changes: Claude Code delegated provider.
- Function(s): `createClaudeCodeProvider(config): ModelProvider`.
- Data shapes: provider id `claude-code` or `claude`.
- Integration points: maps `claude-code:sonnet` to CLI args or environment variables without stealing `anthropic:` direct API specs.
- Error paths: missing CLI or authentication produces actionable message.

##### src/providers/codex-cli.ts
- What changes: Codex delegated provider.
- Function(s): `createCodexProvider(config): ModelProvider`.
- Data shapes: provider id `codex`.
- Integration points: maps `codex:<model>` to CLI args.
- Error paths: missing CLI or auth produces actionable message.

##### src/providers/opencode-cli.ts
- What changes: OpenCode delegated provider.
- Function(s): `createOpenCodeProvider(config): ModelProvider`.
- Data shapes: provider id `opencode`.
- Integration points: maps `opencode:<provider/model>` to CLI args.
- Error paths: missing CLI/auth/config produces actionable message.

##### extension.ts
- What changes: Add branch in loops for providers with `mode: 'delegated'`, where a step/request streams CLI output and does not expose Raptor tools.
- Function(s): `handleChatRequest`, `runFlow`.
- Data shapes: delegated providers return text events only.
- Integration points: flow summaries, conversation history, progress labels.
- Error paths: delegated provider failure aborts the current flow step with provider details.

#### Edge cases
- Re-check official CLI docs at implementation time; CLI flags, config file locations, and auth mechanisms change frequently.
- Delegated providers may edit files themselves. Raptor should refresh diagnostics/history after they finish, but not try to replay internal tool calls.
- Cancellation must kill the subprocess.
- CLI command output can be huge; cap chat output and send full logs to Raptor output channel or temp files.

#### Verification
- Run: `npm run compile`
- Manual: Configure each installed CLI and run a text-only delegated flow step.
- Manual: Cancel a delegated step and verify the child process exits.

### Inc 5 - Config Compatibility Importers (M)
**Depends on:** 1, 3, 4
**Unblocks:** 6
**Done criteria:** Raptor can read native-ish `.codex`, `.claude`, and `.opencode` config files into normalized Raptor agents/flows without breaking existing `agents.json` / `flows.json`.

#### Files to touch

##### src/config/loader.ts
- What changes: Add `.codex` to config discovery and split raw Raptor file loading from external importer loading.
- Function(s): `discoverConfigRoots()`, `loadExternalConfigs(root)`.
- Data shapes: existing `LoadedConfig`, plus warnings indicating imported source and unsupported fields.
- Integration points: same merge and precedence path.
- Error paths: malformed external config creates warning and skips only that file.

##### src/config/importers/opencode.ts
- What changes: Import relevant OpenCode agent/model conventions into Raptor agents/flows.
- Function(s): `loadOpenCodeConfig(root): Promise<PartialLoadedConfig>`.
- Data shapes: maps OpenCode `model` and `small_model` values to normalized direct provider specs where possible, and keeps unsupported provider config as warnings.
- Integration points: loader.
- Error paths: unsupported fields become warnings.

##### src/config/importers/claude.ts
- What changes: Import Claude-oriented instructions/agents where discoverable.
- Function(s): `loadClaudeConfig(root): Promise<PartialLoadedConfig>`.
- Data shapes: maps Claude Code `model` settings and aliases to `claude-code:...` by default, with an explicit setting to reinterpret aliases as `anthropic:...`.
- Integration points: loader.
- Error paths: ambiguous model aliases warn and default to direct Anthropic if configured.

##### src/config/importers/codex.ts
- What changes: Import Codex config/instructions where discoverable.
- Function(s): `loadCodexConfig(root): Promise<PartialLoadedConfig>`.
- Data shapes: maps Codex `model` / `model_provider` / profile fields to `codex:...` for delegated CLI runs or `openai:...` when the provider is clearly OpenAI-compatible.
- Integration points: loader.
- Error paths: unsupported format warns and skips.

##### README.md
- What changes: Document compatibility matrix and precedence.
- Function(s): docs only.
- Data shapes: examples for `agents.json`, `flows.json`, and imported configs.
- Integration points: user setup.
- Error paths: docs show how to inspect warnings in the Raptor output channel.

#### Edge cases
- Native configs from other tools may have different semantics for tools, permissions, or sandboxing. Raptor should import only safe, obvious fields.
- Existing Raptor files must keep higher precedence than imported compatibility files in the same root.
- `.codex` global path may differ by platform; keep discovery conservative.

#### Verification
- Run: `npm run compile`
- Manual: Create sample `.opencode`, `.claude`, and `.codex` directories and verify `/agents` / `/flows` list imported entries.
- Manual: Confirm existing `.raptor/agents.json` overrides imported entries by id.

### Inc 6 - UI, Docs, and Verification Polish (M)
**Depends on:** 2, 3, 4, 5
**Unblocks:** release
**Done criteria:** Users can see available providers/models, diagnose why a model was chosen, and follow docs to configure provider-specific switching.

#### Files to touch

##### package.json
- What changes: Add VS Code settings for enabled providers, API key storage hints, provider priority, CLI paths, timeouts, and default provider.
- Function(s): manifest only.
- Data shapes: `raptor.providers.enabled`, `raptor.providers.priority`, `raptor.provider.<id>.*`.
- Integration points: registry configuration.
- Error paths: invalid settings fall back with output-channel warnings.

##### src/tools/catalog.ts
- What changes: Add slash command help rows for model/provider inspection if commands are added.
- Function(s): `buildHelpMarkdown()`.
- Data shapes: help markdown.
- Integration points: `/help`.
- Error paths: none.

##### extension.ts
- What changes: Add `/models` or `/providers` command to list providers, available models, auth status, and current precedence.
- Function(s): `handleChatRequest`.
- Data shapes: provider status table.
- Integration points: provider registry.
- Error paths: unavailable provider displays status without throwing.

##### README.md
- What changes: Add compatibility docs, model selection rules, examples, and limitations.
- Function(s): docs only.
- Data shapes: provider matrix.
- Integration points: setup and usage docs.
- Error paths: docs explain fallback behavior and delegated-provider limitations.

#### Edge cases
- Avoid exposing secrets in provider status.
- Make source labels clear: `flow-step-override`, `agent-override`, `session-selected`, `fallback`.
- Clarify that delegated CLI providers do not use Raptor's internal tools.

#### Verification
- Run: `npm run compile`
- Run: `npx vsce package --no-dependencies`
- Manual: Use `/providers`, `/agents`, `/flows`, a normal prompt, a native-provider flow, and a delegated-provider flow.

## Cross-cutting verification
- Existing VS Code-only path must keep working after every increment.
- Model selection order remains: flow step override, agent override, session-selected VS Code model, global fallback.
- Provider-qualified model specs never cross-match another provider.
- Tool-call execution works for VS Code and native API providers.
- Delegated CLI providers stream output, handle cancellation, and do not pretend to expose internal Raptor tool calls.
- Packaging should continue to produce `raptor-vscode-extension-0.2.0.vsix`.

## Standards / common-mistakes referenced
- No `.agents/standards` or `.agents/common-mistakes` files were present in this repository.
- Existing repo patterns referenced: `src/config/model.ts`, `src/config/loader.ts`, `extension.ts`, `src/tools/registry.ts`, `src/tools/catalog.ts`.
- External primary docs checked May 11, 2026: Anthropic Claude Code model configuration, OpenCode config/providers docs, OpenAI Codex repository config docs.

## Open questions (CONSIDER from review)
- CONSIDER: Decide whether the short alias `claude:<model>` should be supported at all. The plan avoids ambiguity by using `anthropic:<model>` for direct API and `claude-code:<model>` for delegated CLI.
- CONSIDER: Add a lightweight test framework before Inc 3 if provider translation logic grows quickly.
- CONSIDER: Support MCP-based providers later if Claude/OpenCode/Codex expose stable structured tool protocols.

## Out of scope
- Replacing VS Code Chat Participant UI.
- Full native compatibility with every external tool setting.
- Bidirectional syncing back into `.claude`, `.codex`, or `.opencode` files.
- Building a separate standalone Raptor CLI.
- Storing provider API keys in plaintext config files.
