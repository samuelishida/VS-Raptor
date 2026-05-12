# Raptor

Agent orchestrator that routes tasks to specialist skills, builds custom agent flows, and runs multi-step automations.

Works as a **VS Code extension**, a **Claude Code plugin**, and an **npm-installable skill pack** for Codex and OpenCode.

## Features

- **Chat Participant**: Interact with `@raptor` directly in VS Code's chat panel
- **Skill Router**: Built-in skills for fix-bug, plan, code-audit, refactor, review, and more
- **Agent Flows**: Run multi-step flows that sequence different agents and models
- **Provider Switching**: Route to VS Code models, Anthropic, OpenAI, OpenRouter, Ollama, or CLI tools per agent or flow step
- **Memory System**: Persistent global and project-scoped memory across sessions
- **LSP Integration**: Go-to-definition, find references, and diagnostics
- **Config Importers**: Reads `.claude`, `.codex`, and `.opencode` configs automatically

---

## Installation

### VS Code extension

**Option A — install from VSIX:**

```bash
# Build the VSIX first
npm install
npm run compile
npx vsce package --no-dependencies

# Install
code --install-extension raptor-0.2.0.vsix
```

Or manually: Extensions panel → `...` → Install from VSIX → select the `.vsix` file.

**Option B — install from source (dev mode):**

```bash
git clone <repo>
cd raptor
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

---

### Claude Code plugin

Raptor ships a `plugin.json` that Claude Code recognizes as a plugin.

**Install from npm (once published):**

```bash
npm install -g raptor
```

Claude Code discovers plugins in global `node_modules` by scanning for `plugin.json` with `engines.claude-code`.

**Install from local path (development):**

```bash
# In your project or globally
claude plugin install /path/to/raptor
```

This loads the `skills/` and `agents/` directories into Claude Code's skill/agent system, making all Raptor skills available as `/` slash commands.

**Available after install:**

| Skill | Trigger |
|---|---|
| `raptor` | Master router — identifies intent and delegates |
| `agent-flow-builder` | Design and generate `.raptor/agents.json` + `flows.json` |
| `fix-bug` | Hypothesis-first root cause analysis |
| `plan-small` / `plan-large` | Technical planning with increment DAGs |
| `code-audit` | Parallel specialist audit (logic, security, simplification) |
| `refactor` | Behavior-preserving cleanup |
| `review-large-pr` | Chunked PR review for 30+ file changes |
| and more... | See `skills/` directory |

---

### Codex CLI

Codex does not have a native plugin format, but you can reference Raptor's skill instructions from your Codex config:

```bash
npm install -g raptor
```

Then in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), add instructions referencing the installed skill files:

```toml
instructions = """
Follow the Raptor orchestration process. Route tasks to the appropriate workflow:
- Bugs → fix-bug skill
- Planning → plan-small or plan-large skill
- Audits → code-audit skill
"""
```

Or point Codex at the `agents/raptor.md` file directly as an instructions source.

---

### OpenCode

```bash
npm install -g raptor
```

In your `.opencode/config.json` (workspace) or `~/.opencode/config.json` (global):

```json
{
  "instructions": "path/to/node_modules/raptor/agents/raptor.md"
}
```

Or use the Raptor config importer — if you have a `.raptor/agents.json` in your workspace, Raptor's VS Code extension will pick it up automatically alongside `.opencode` configs.

---

## Usage (VS Code)

- Open chat panel: `Ctrl+Alt+I` / `Cmd+Option+I`
- Type `@raptor` to invoke the agent
- Use `/help` to see all commands

### Slash commands

| Command | Description |
|---|---|
| `/help` | Show this reference |
| `/agents` | List loaded agents |
| `/agent <id>` | Switch to a specific agent |
| `/flows` | List loaded flows |
| `/flow <id>` | Run a multi-step flow |
| `/models` | List providers, capability, and available models |
| `/build-flow` | Design and generate an agent flow for this project |
| `/memory` | Show persistent memory |
| `/resume` | Load last session summary and continue |
| `/todos` | Show current todo list |
| `/clearmemory` | Wipe all persistent memory |
| `/steer <msg>` | Inject guidance into a running agent |

---

## Providers

Raptor can route requests to multiple model providers. Configure via VS Code settings (`Ctrl+,` → search `raptor`).

### Provider compatibility matrix

| Provider ID | Capability | Tools | Notes |
|---|---|---|---|
| `vscode` | `native-tools` | ✓ | Default — uses VS Code Language Model API (Copilot, etc.) |
| `anthropic` | `native-tools` | ✓ | Direct Anthropic API — requires API key |
| `openai` | `native-text` | pending | Direct OpenAI API — requires API key |
| `openrouter` | `native-text` | pending | OpenRouter — requires API key |
| `ollama` | `native-text` | ✗ | Local models — requires running Ollama server |
| `claude-code` | `delegated` | ✗ | Claude Code CLI subprocess |
| `codex` | `delegated` | ✗ | Codex CLI subprocess |
| `opencode` | `delegated` | ✗ | OpenCode CLI subprocess |

`delegated` providers run as subprocesses and do not participate in Raptor's tool loop.

### Model spec syntax

```
vscode:copilot-gpt-4          # VS Code provider, explicit model
anthropic:claude-sonnet-4-20250514
openai:gpt-4o
openrouter:anthropic/claude-3.5-sonnet
ollama:llama3.1
claude-code:sonnet
codex:gpt-5.3-codex
opencode:anthropic/claude-sonnet-4-6
```

Plain model names (no `provider:` prefix) search all providers in priority order.

### Model selection order

1. Flow step `model` override
2. Agent `model` override
3. Session-selected model (VS Code chat UI)
4. `raptor.model` fallback setting

### API key setup

**Recommended — SecretStorage (keys never touch settings files):**

Open the Command Palette (`Ctrl+Shift+P`) and run:
- `raptor: Set Provider API Key (SecretStorage)` — enter provider id (`anthropic`, `openai`, `openrouter`) and key

**Fallback — environment variables:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export OPENROUTER_API_KEY=sk-or-...
```

**Deprecated — VS Code settings (not recommended, visible in settings sync):**

```json
"raptor.provider.anthropic.apiKey": "sk-ant-..."
```

### Enabling providers

By default only `vscode` and `ollama` are enabled. Enable others in settings:

```json
"raptor.providers.enabled": {
  "anthropic": true,
  "openai": false,
  "claude-code": true,
  "codex": false,
  "opencode": false
}
```

### CLI provider paths

```json
"raptor.provider.claude-code.command": "claude",
"raptor.provider.claude-code.defaultModel": "sonnet",
"raptor.provider.codex.command": "codex",
"raptor.provider.codex.defaultModel": "gpt-5.3-codex",
"raptor.provider.opencode.command": "opencode"
```

---

## Agents, Skills, and Flows

### Config locations (highest precedence last)

1. `~/.raptor/` (global)
2. `<workspace>/.github/`
3. `<workspace>/.claude/`
4. `<workspace>/.opencode/`
5. `<workspace>/.raptor/` ← workspace-local, highest precedence

### Skills (`skills.md`)

```markdown
## code-review
When reviewing code, focus on:
- Security issues (OWASP top 10)
- Performance bottlenecks

## commit-message
Write commit messages in Conventional Commits format.
```

Also supports `skills/<name>/SKILL.md` format (used by Raptor's own built-in skills).

### Agents (`agents.json`)

```json
[
  {
    "id": "reviewer",
    "name": "Code Reviewer",
    "description": "Security and quality focused reviewer",
    "prompt": "You are a senior code reviewer. Be thorough but kind.",
    "skills": ["code-review"],
    "tools": ["readFile", "searchCode", "getDiagnostics"],
    "model": "anthropic:claude-sonnet-4-20250514"
  }
]
```

- `tools: null` — all tools allowed (default)
- `model` — provider-qualified spec or plain model name

### Flows (`flows.json`)

```json
[
  {
    "id": "plan-and-implement",
    "name": "Plan and Implement",
    "steps": [
      {
        "agent": "planner",
        "instruction": "Break the request into a detailed implementation plan.",
        "model": "anthropic:claude-sonnet-4-20250514",
        "summaryBudget": 1500
      },
      {
        "agent": "coder",
        "instruction": "Implement the plan from the previous step.",
        "model": "vscode:copilot-gpt-4"
      }
    ]
  }
]
```

- `summaryBudget` — max characters of previous step output passed to next step
- Step `model`/`skills`/`tools` override the agent's own settings for that step only

---

## Project Structure

```
extension.ts          VS Code extension entry point
src/
  chat/               Chat participant, message adapter, system prompt
  commands/           VS Code command registration (including API key commands)
  config/             Loader, model parsing, config importers, built-in skills
    importers/        .claude, .codex, .opencode config importers
  providers/          Provider registry, types, and adapters
    vscode.ts         VS Code Language Model API
    anthropic.ts      Direct Anthropic API
    openai.ts         Direct OpenAI API
    openrouter.ts     OpenRouter
    ollama.ts         Local Ollama
    cli.ts            Shared CLI subprocess runner
    claude-code.ts    Claude Code CLI provider
    codex-cli.ts      Codex CLI provider
    opencode-cli.ts   OpenCode CLI provider
  tools/              Tool catalog and registry
  utils/              Path helpers, logging
skills/               Built-in Raptor skills (also exported in npm package)
agents/               Built-in agent definitions
plugin.json           Claude Code marketplace manifest
dist/                 Compiled JS output (not in npm package)
```

## Build

```bash
npm install          # install dev dependencies
npm run compile      # compile TypeScript → dist/
npm run watch        # watch mode for development
npx vsce package --no-dependencies   # build VSIX
```
