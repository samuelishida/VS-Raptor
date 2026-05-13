# Raptor Compatibility Fixup

## Context
Raptor's provider and agent-builder work compiles, but runtime compatibility is still incomplete across VS Code, Claude Code, Codex CLI, OpenCode, and native API providers. The installed VSIX can lose the built-in agent-builder skill, CLI settings are not fully wired, CLI prompt transport is inconsistent, Anthropic receives an invalid first-message shape, CLI availability is over-reported, and `SKILL.md` edits are not part of the config cache freshness key.

The intended outcome is that an installed VS Code extension can run `/build-flow` without relying on workspace-local skill files, provider settings actually affect provider execution, CLI providers report availability honestly, and native/CLI provider message transport is deterministic.

## Architectural decisions
- Decision: split extension built-ins from repo plugin assets. Rationale: VS Code runtime should not depend on root `skills/` being packaged as loose files, while Claude/Codex/OpenCode plugin compatibility can continue to use `plugin.json`, `skills/`, and `agents/` in the repository. Alternatives rejected: remove `.vscodeignore` exclusions and ship all root skills in the VSIX; that bloats VSIX and still requires loader changes to read extension resources.
- Decision: add built-in skills/agents as compiled TypeScript data and merge them at the lowest precedence. Rationale: `dist/src/**` is packaged and already loaded by the extension. Workspace/global config must still override defaults.
- Decision: make CLI prompt transport explicit per provider. Rationale: Codex and Claude can read stdin, while OpenCode currently uses argv. A shared runner that always writes stdin creates provider-specific ambiguity.
- Decision: represent provider system instructions explicitly before native API conversion. Rationale: Anthropic needs top-level `system` and user-first message history; OpenAI/OpenRouter can use `system`; VS Code can receive the system prompt as a first user message if needed.
- Decision: CLI availability must be checked before `/models` reports models and before chat execution. Rationale: a provider with configured models but no executable is not usable.
- Decision: add provider health/status separately from model listing. Rationale: `listModels(): RaptorModel[]` cannot explain missing executables or missing API keys, and an empty list can otherwise trigger silent fallback.
- Decision: config cache freshness must include loaded `skills/*/SKILL.md` mtimes. Rationale: agent-builder iteration should not require an extension restart.

## Assumptions and answers from code
- Answered from code: packaged VSIX excludes root `agents/**` and `skills/**`, while `plugin.json` points to those directories. Source: `.vscodeignore:13`, `plugin.json:7`.
- Answered from code: runtime loader reads `agents.json`, `flows.json`, `skills.md`, and `skills/*/SKILL.md`, not root `agents/*.md`. Source: `src/config/loader.ts:351`, `src/config/loader.ts:377`, `src/config/loader.ts:412`.
- Answered from code: `/build-flow` only injects a command asking for `agent-flow-builder`; it does not guarantee that skill exists. Source: `extension.ts:2111`, `extension.ts:2388`.
- Answered from code: provider command/default model settings are read into `ProviderConfig`. Source: `src/providers/config.ts:37`.
- Answered from code: activation does not pass `command` to CLI provider wrappers, and Codex/OpenCode wrappers ignore `model`. Source: `extension.ts:647`, `src/providers/codex-cli.ts:5`, `src/providers/opencode-cli.ts:5`.
- Answered from code: `createCliProvider()` consumes `config.COMMAND`, but wrappers never set it. Source: `src/providers/cli.ts:33`.
- Answered from code: the shared CLI runner writes prompt text to stdin for all CLI providers, including Claude/OpenCode providers that also put the prompt in argv. Source: `src/providers/cli.ts:101`, `src/providers/cli.ts:109`, `src/providers/cli.ts:184`, `src/providers/cli.ts:219`.
- Answered from code: `buildMessages()` creates a first user message containing system prompt content, then a synthetic assistant "Ready" message. Source: `extension.ts:2324`, `extension.ts:2341`.
- Answered from code: Anthropic strips only the first user message to top-level `system`, leaving the synthetic assistant as the first API message. Source: `src/providers/anthropic.ts:97`.
- Answered from code: CLI `listModels()` always returns known models and never checks command availability. Source: `src/providers/cli.ts:41`.
- Answered from code: config cache freshness tracks only root `skills.md`, `agents.json`, and `flows.json`; it does not include nested `SKILL.md` files. Source: `src/config/loader.ts:423`, `src/config/loader.ts:433`.
- Answered from code: project check command is `npm run compile`. Source: `package.json:12`.
- Answered from code: there are no `.agents/standards` or `.agents/common-mistakes` files in this repo. Source: local inspection.

## Risks accepted
- Root plugin assets and VS Code built-ins can diverge: mitigate by making the built-in data import from source constants or by adding a verification check that compares built-in skill ids with root skill files.
- CLI behavior can differ by installed CLI version: mitigate with provider-specific dry-run checks against local `--help`/`--version` and clear errors when commands fail.
- Adding a `system` role to provider-neutral messages touches several conversion paths: mitigate by keeping the compatibility layer small and adding compile plus manual provider checks after each increment.
- OpenCode may not support stdin prompt input: accept argv prompt transport for OpenCode initially, but do not also write stdin.

## Increment DAG
- Inc 1 - Built-in Raptor Assets (M) - depends on: none - unblocks: 2, 6 - **done**
- Inc 2 - Config Cache and Loader Freshness (S) - depends on: none - unblocks: 6 - **done**
- Inc 3 - CLI Settings, Availability, and Transport (L) - depends on: none - unblocks: 6 - **done**
- Inc 4 - Provider Message Normalization (L) - depends on: none - unblocks: 6 - **done**
- Inc 5 - Native Provider Tool Shapes (M) - depends on: 4 - unblocks: 6 - **done**
- Inc 6 - Cross-provider Verification Polish (M) - depends on: 1, 2, 3, 4, 5 - unblocks: release

## Increments

### Inc 1 - Built-in Raptor Assets (M)
**Depends on:** none  
**Unblocks:** 2, 6  
**Done criteria:** Installed VSIX runtime has `raptor` and `agent-flow-builder` skills available even when the opened workspace has no `skills/` directory.

#### Files to touch

##### src/config/builtins.ts
- What changes: add compiled built-in skill and default agent definitions for VS Code runtime.
- Function(s): `getBuiltinConfig(): Pick<LoadedConfig, 'skills' | 'agents' | 'flows' | 'warnings' | 'sources'>`.
- Data shapes: `Skill` entries for `raptor` and `agent-flow-builder`; optional default `Agent` entry only if no user `_default` overrides it.
- Integration points: called by `loadConfig()` before global/workspace config roots are merged.
- Error paths: none; built-ins are static and should not throw.

##### scripts/check-builtins.mjs or equivalent
- What changes: add a package check that compares built-in skill ids and content sources against root `skills/raptor/SKILL.md` and `skills/agent-flow-builder/SKILL.md`.
- Function(s): CLI script invoked by `npm run check:builtins` if a script is added.
- Data shapes: reads root SKILL.md files and the built-in source file; fails if required ids are missing or content drift is detected beyond intentional metadata differences.
- Integration points: optional package script; also referenced in release verification.
- Error paths: missing root plugin files should fail in the repository but not in an installed VSIX.

##### src/config/loader.ts
- What changes: merge built-ins at lowest precedence before `discoverConfigRoots()` results.
- Function(s): `loadConfig(): Promise<LoadedConfig>`, `ensureDefaultAgent(config: LoadedConfig): void`.
- Data shapes: built-in skills use existing `Skill` map ids and `source: 'builtin:<id>'`.
- Integration points: `getSkillContent()` should work without change because built-ins use the same `Skill` shape.
- Error paths: user config with same ids should override built-ins and produce the existing override warnings if applicable.

##### .vscodeignore / plugin.json
- What changes: make packaging intent explicit.
- Function(s): none.
- Data shapes: package resources only.
- Integration points: either exclude `plugin.json` from VSIX if root plugin assets remain excluded, or include `skills/**` and `agents/**` intentionally and add loader support for extension-resource files. Choose the former for this plan.
- Error paths: `npx vsce ls --no-dependencies` must not show a dangling `plugin.json` that points at excluded folders.

#### Edge cases
- Workspace defines its own `skills/raptor/SKILL.md`: workspace skill overrides built-in.
- Workspace defines `_default` in `agents.json`: `ensureDefaultAgent()` must not replace it.
- No workspace open: built-in skills still load.

#### Verification
- Run: `npm run compile`.
- Run: built-in parity check if `npm run check:builtins` is added.
- Run: `npx vsce ls --no-dependencies`.
- Manual: inspect `/agents` and `/build-flow` in an empty workspace; `_default` should reference loaded `raptor` and `agent-flow-builder`.

### Inc 2 - Config Cache and Loader Freshness (S)
**Depends on:** none  
**Unblocks:** 6  
**Done criteria:** Editing any loaded `skills/*/SKILL.md` changes the config cache key and reloads the skill on the next request.

#### Files to touch

##### src/config/loader.ts
- What changes: replace the single max-mtime cache key with a stable freshness signature that includes root files, config-root nested `skills/*/SKILL.md`, and workspace-root `skills/*/SKILL.md`.
- Function(s): `getConfig(): Promise<LoadedConfig>`, `loadConfig(): Promise<LoadedConfig>`, new helper `collectConfigMtimes(roots: string[]): Promise<number[]>` or `computeConfigSignature(roots: string[]): Promise<string>`.
- Data shapes: `CacheEntry` changes from `{ mtime: number; data: LoadedConfig }` to `{ signature: string; data: LoadedConfig }`.
- Integration points: both `loadConfig()` and `getConfig()` use the same helper so cache freshness and initial cache write cannot drift.
- Error paths: missing directories count as empty; unreadable files should keep current warning behavior during load.

#### Edge cases
- A new skill directory is added after first load.
- A skill directory is deleted after first load.
- A root `skills.md` and nested `skills/*/SKILL.md` both exist.
- Workspace-root `skills/*/SKILL.md` changes after initial load.

#### Verification
- Run: `npm run compile`.
- Manual: edit `skills/agent-flow-builder/SKILL.md`, invoke `/build-flow`, and verify updated instructions appear in the prompt/logged loaded skill content.

### Inc 3 - CLI Settings, Availability, and Transport (L)
**Depends on:** none  
**Unblocks:** 6  
**Done criteria:** Claude Code, Codex CLI, and OpenCode providers honor configured command/default model settings, never use shell execution, use only their declared prompt transport, and report unavailable when the executable cannot be resolved.

#### Files to touch

##### src/providers/cli.ts
- What changes: add explicit CLI command resolution and prompt transport.
- Function(s):  
  - `createCliProvider(definition: CliProviderDefinition, config?: CliProviderRuntimeConfig): ModelProvider`  
  - `resolveCommand(command: string): Promise<{ ok: true; command: string } | { ok: false; reason: string }>`  
  - `getStatus(): Promise<ProviderStatus>` or equivalent provider health method  
  - `streamCliCommand(command, args, options, token): AsyncIterable<RaptorResponseEvent>`  
  - `buildCliInvocation(definition, model, prompt): { args: string[]; stdin?: string }`
- Data shapes:  
  - `CliProviderDefinition` gains `promptTransport: 'argv' | 'stdin'` or equivalent return-level `stdin` flag.  
  - `CliProviderRuntimeConfig` includes `command?: string`, `apiKeyEnv?: Record<string, string>`, `defaultModel?: string`.
- Integration points: `getStatus()` checks command availability; `listModels()` returns `[]` when unavailable; `sendRequest()` throws `ProviderError(providerId, 'command-not-found', ...)` if unavailable.
- Error paths: missing executable, spawn error, non-zero exit, prompt-too-long for argv-only providers, cancellation.

##### src/providers/types.ts / src/providers/registry.ts
- What changes: add provider status/health to prevent explicit provider-qualified CLI models from resolving when the executable is missing.
- Function(s): `ModelProvider.getStatus?(): Promise<ProviderStatus>`, registry explicit-provider resolution path.
- Data shapes: `ProviderStatus = { available: boolean; reason?: string; code?: string }` or equivalent.
- Integration points: explicit `codex:anything` with a missing Codex command must throw `ProviderError('codex', 'command-not-found', ...)` before arbitrary-model synthesis.
- Error paths: missing health method means existing providers are treated according to `capability` and `listModels()`.

##### src/providers/claude-code.ts / src/providers/codex-cli.ts / src/providers/opencode-cli.ts
- What changes: pass `command` and `defaultModel` into `createCliProvider()`.
- Function(s): `createClaudeCodeProvider(config?: { apiKey?: string; model?: string; command?: string })`, equivalent Codex/OpenCode signatures.
- Data shapes: wrapper config now includes command and default model.
- Integration points: activation passes `cfg.command` and `cfg.defaultModel`.
- Error paths: invalid command path yields unavailable provider.

##### extension.ts / src/providers/config.ts
- What changes: activation forwards `cfg.command` to CLI wrappers; config loader should keep using VS Code configuration defaults.
- Function(s): `activate(context)`, `loadProviderConfigs(context)`.
- Data shapes: `ProviderConfig.command` and `ProviderConfig.defaultModel` are no longer dead fields.
- Integration points: `/models` status should show no models for missing CLI command.
- Error paths: provider-specific errors render as model errors in chat.

#### Provider-specific invocation policy
- Claude Code: use stdin transport: `claude --print --input-format text --model <model>` when a model is selected; omit `--model` only if using provider default. Write prompt to stdin. Do not include prompt argv.
- Codex CLI: use stdin transport: `codex exec --model <model> -`. Write prompt to stdin.
- OpenCode CLI: use argv transport: `opencode run --model <model> <prompt>` or `opencode run <prompt>`. Do not write stdin. Keep Windows prompt length guard for argv transport.
- CLI `defaultModel` behavior: provider config default model is inserted as the first listed model for that CLI. Explicit `<provider>:default` resolves to the configured default model id, not to a literal `default` model. If no configured default exists, use the provider definition default (`sonnet`, `gpt-5.3-codex`, `default`) as the first listed model.
- Command resolution behavior: support absolute paths with spaces, quoted absolute paths, bare commands on PATH, and Windows `.exe` / `.cmd` / `.bat` resolution without invoking a shell.

#### Edge cases
- Command setting is an absolute path with spaces.
- Command setting is a bare executable found on PATH.
- Provider enabled but command missing.
- `defaultModel` configured and no model override is supplied.
- Explicit `codex:anything` or `opencode:anything` with a missing executable.
- Arbitrary provider-qualified model override such as `opencode:anthropic/claude-sonnet-4-5`.

#### Verification
- Run: `npm run compile`.
- Manual: set `raptor.provider.codex.command` to a bogus path and confirm `/models` shows Codex unavailable.
- Manual: set `raptor.provider.codex.defaultModel` and run an agent with `model: "codex:default"`; verify invocation uses configured default.
- Manual: send a prompt containing shell metacharacters to CLI providers and verify it is passed as literal text.

### Inc 4 - Provider Message Normalization (L)
**Depends on:** none  
**Unblocks:** 6  
**Done criteria:** VS Code, OpenAI/OpenRouter, Anthropic, Ollama, and CLI providers receive message shapes compatible with their API/transport expectations.

#### Files to touch

##### src/providers/types.ts
- What changes: add `system` as an internal provider-neutral role.
- Function(s): no functions; update `RaptorMessage['role']` to `'system' | 'user' | 'assistant'`.
- Data shapes: `RaptorMessage` content unchanged.
- Integration points: all provider converters must handle `system`.
- Error paths: compile catches unhandled role switches.

##### extension.ts / src/chat/message-adapter.ts
- What changes: build the Raptor system prompt as `role: 'system'` and remove the synthetic assistant "Ready" message from normal runtime messages.
- Function(s): `buildMessages(...)`, `fullCompactMessages(...)`, `generateSessionSummary(...)`, `saveConversationHistory(...)`, `compactRuntimeMessages(...)`, `toRaptorMessages(...)`, `fromRaptorMessages(...)`.
- Data shapes: system prompt no longer masquerades as a user turn.
- Integration points: VS Code provider can map `system` to a first user message if the VS Code API lacks a system role; compaction and summaries must identify system messages by `role === 'system'`, never by fixed indexes such as `slice(0, 2)` or `slice(2)`.
- Error paths: history imported from VS Code remains user/assistant only.

##### src/providers/anthropic.ts
- What changes: map all `system` messages to top-level `system`, then ensure `messages` starts with a user message.
- Function(s): `buildRequestBody(model, messages, tools)`.
- Data shapes: Anthropic message list contains only user/assistant roles; no assistant-first history.
- Integration points: tool use blocks remain in assistant messages; tool results remain in user messages.
- Error paths: if normalization would produce an empty message list, add a non-empty user message such as the latest request text when available, otherwise `Continue.`; never send an empty Anthropic text block.

##### src/providers/openai.ts / src/providers/openrouter.ts / src/providers/ollama.ts / src/providers/vscode.ts / src/providers/cli.ts
- What changes: handle `system` explicitly.
- Function(s): provider-specific request-body builders and VS Code conversion helpers.
- Data shapes: OpenAI/OpenRouter use `role: 'system'`; Ollama uses `role: 'system'` if supported; CLI prompt assembly includes system text before the latest user request when delegated providers only receive a single prompt.
- Integration points: delegated CLI providers should receive enough context after the first turn, not only the last user message.
- Error paths: unsupported provider role conversion falls back to text prefix rather than dropping instructions.

#### Edge cases
- Existing history begins with an assistant response from prior VS Code chat.
- Compaction injects a summary system/user turn.
- Compaction and session summary code no longer assumes the first two messages are system/setup turns.
- Sub-agent prompts use system role and still get tools.
- Delegated CLI providers need full context, not just the latest user message.

#### Verification
- Run: `npm run compile`.
- Manual: request Anthropic native provider and verify first API message is not assistant-first by logging sanitized request shape.
- Manual: VS Code provider still completes a basic tool call.

### Inc 5 - Native Provider Tool Shapes (M)
**Depends on:** 4  
**Unblocks:** 6  
**Done criteria:** native API provider tool-call loops round-trip correctly for OpenAI/OpenRouter and Anthropic.

#### Files to touch

##### src/providers/openai.ts / src/providers/openrouter.ts
- What changes: normalize tool result messages so each `tool_call_id` becomes a separate `role: 'tool'` message and no text is lost if a Raptor user message contains both text and tool results.
- Function(s): `buildRequestBody(...)`, extracted helper `toOpenAICompatibleMessages(messages)`.
- Data shapes: return type should allow one Raptor message to expand to multiple API messages.
- Integration points: `appendToolResultToMessages()` already appends one result per message; helper should also be robust for imported VS Code history with multiple tool results.
- Error paths: malformed tool arguments still throw `ProviderError(..., 'tool-parse-error', ...)`.

##### src/providers/openrouter.ts
- What changes: keep OpenRouter's OpenAI-compatible schema path explicit and verify it separately from OpenAI because OpenRouter model families may vary in tool support.
- Function(s): `buildRequestBody(...)`, `streamResponse(...)`.
- Data shapes: OpenAI-compatible messages and tools, plus existing OpenRouter headers.
- Integration points: `/models` and native tool-loop verification should distinguish OpenRouter from OpenAI.
- Error paths: provider/model tool incompatibility should surface the OpenRouter API error clearly.

##### src/providers/anthropic.ts
- What changes: ensure assistant `tool_use` and user `tool_result` block ordering matches Anthropic expectations after system-role normalization.
- Function(s): `buildRequestBody(...)`, extracted helper `toAnthropicMessages(messages)`.
- Data shapes: top-level `system`, `messages`, `tools`.
- Integration points: `RaptorToolCallPart` and `RaptorToolResultPart` remain provider-neutral.
- Error paths: unknown or empty content becomes a text block only when required to satisfy API shape.

#### Edge cases
- Multiple parallel tool calls and results.
- Tool result content over normal compaction threshold.
- Tool call streamed with fragmented JSON arguments.
- API stream sends `stop` without accumulated tool calls.

#### Verification
- Run: `npm run compile`.
- Manual: force a native provider to call `readFile`; verify Raptor dispatches the tool and provider continues with the result.
- Manual: repeat the tool-loop check separately for OpenAI and OpenRouter.
- Manual: repeat with two tool calls in one assistant turn if the model supports parallel tool use.

### Inc 6 - Cross-provider Verification Polish (M)
**Depends on:** 1, 2, 3, 4, 5  
**Unblocks:** release  
**Done criteria:** compatibility can be verified with documented commands and manual checks for VS Code, Claude Code, Codex, OpenCode, and native providers.

#### Status

All increments 1-5 completed. Inc 6 is optional documentation/polish.

#### Files to touch

##### package.json / README.md
- What changes: document provider setup, command/default model settings, `/build-flow`, and verification checklist.
- Function(s): package scripts may add non-mutating checks only if implementation adds them.
- Data shapes: settings documentation must match actual `raptor.provider.<id>.*` keys.
- Integration points: README examples should include `codex:<model>`, `claude-code:<model>`, `opencode:<provider/model>`, `anthropic:<model>`, and VS Code session-selected model.
- Error paths: document missing executable and missing API key messages.

##### extension.ts
- What changes: improve `/models` output to show provider capability and unavailable reason when available.
- Function(s): `/models` branch in `handleChatRequest`.
- Data shapes: table columns: provider id, capability, status, models/reason.
- Integration points: CLI unavailable should be visible before chat execution.
- Error paths: `listModels()` failure should render the error code/message, not only `(no models)`.

##### optional test/check scripts
- What changes: add a lightweight check script only if it can run without VS Code host.
- Function(s): `scripts/check-package.mjs` or equivalent, verifying `vsce ls` does not include dangling plugin metadata and does include required `dist` files.
- Data shapes: simple Node script output.
- Integration points: optional `npm run check:package`.
- Error paths: script exits non-zero on missing built-in runtime assets or dangling package references.

#### Edge cases
- No workspace open.
- Empty workspace with no `.raptor`.
- Installed VSIX opened in a repo that also has its own root `skills/`.
- Provider enabled but unauthenticated.
- Local model provider unavailable.

#### Verification
- Run: `npm run compile`.
- Run: `npx vsce ls --no-dependencies`.
- Manual: `/build-flow` in a workspace without `skills/`.
- Manual: `/models` with all CLI providers disabled, then enabled with valid commands, then enabled with one invalid command.
- Manual: one text-only request each through VS Code, Claude Code, Codex CLI, OpenCode CLI, Anthropic native, OpenAI native, OpenRouter native, and Ollama when available.

## Cross-cutting verification
- `npm run compile` must pass after every increment.
- `npx vsce ls --no-dependencies` must show no dangling `plugin.json` unless matching `skills/**` and `agents/**` are intentionally included.
- `/build-flow` must start Phase 1/Phase 2 with no visible "Steering injected" message and with `agent-flow-builder` content available.
- Provider precedence remains: flow step model, agent model, session-selected VS Code model, fallback setting.
- Explicit provider-qualified arbitrary CLI models remain exact and never silently downgrade.
- No provider uses `shell: true` for CLI prompts.

## Standards / common-mistakes referenced
- No `.agents/standards` files found.
- No `.agents/common-mistakes` files found.

## Open questions (CONSIDER from review)
- Inc 2 does not depend on Inc 1 and has been made parallel in the DAG; keep it separate unless implementation discovers shared loader conflicts.
- Consider adding provider health/status as a first-class method instead of overloading `listModels()` failures and empty arrays.
- Consider adding small unit tests around extracted pure message-conversion helpers once Inc 4/5 creates them.

## Out of scope
- Adding a full VS Code integration test harness.
- Implementing Ollama tool calling.
- Supporting streamed structured events from CLI providers beyond plain text.
- Changing the public extension command surface beyond `/models` status details.
