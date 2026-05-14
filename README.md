# Raptor

Agent orchestrator that routes tasks to specialist skills, builds custom agent flows, and runs multi-step automations.

Works as a **VS Code extension**, a **Claude Code plugin**, and a **skill pack** for Codex CLI, OpenCode, and any AI coding tool that accepts a system prompt or instructions file.

## Features

- **Chat Participant**: Interact with `@raptor` directly in VS Code's chat panel
- **Skill Router**: Built-in skills for fix-bug, plan, code-audit, refactor, review, and more
- **Agent Flows**: Run multi-step flows that sequence different agents and models (VS Code only — see note below)
- **Provider Switching**: Route to VS Code models, Anthropic, OpenAI, OpenRouter, Ollama, or CLI tools per agent or flow step
- **Memory System**: Persistent project-scoped memory by default, with explicit global memory when requested
- **LSP Integration**: Go-to-definition, find references, and diagnostics
- **Config Importers**: Reads `.claude`, `.codex`, and `.opencode` configs automatically

---

## Installation

All non-VS-Code targets share a single source directory. Get it once:

```bash
git clone https://github.com/samuelishida/raptor.git
# or
npm install -g @samuelishida/raptor    # exposes $(npm root -g)/@samuelishida/raptor
```

Set `RAPTOR_DIR` to that path so the snippets below stay copy-paste safe:

```bash
export RAPTOR_DIR="/path/to/raptor"           # if cloned
# or
export RAPTOR_DIR="$(npm root -g)/@samuelishida/raptor"
```

---

### VS Code extension

**Marketplace (once published):**

Open the Extensions panel → search `Raptor` by Samuel Ishida → Install.

Or from the command line:

```bash
code --install-extension samuelishida.raptor
```

**Install from VSIX (local build):**

```bash
git clone https://github.com/samuelishida/raptor.git
cd raptor
npm install
npm run compile
npx vsce package --no-dependencies
code --install-extension raptor-0.2.0.vsix
```

**Dev mode:**

```bash
# Press F5 in VS Code (with the cloned repo open) to launch Extension Development Host.
```

---

### Claude Code plugin

Raptor's `.claude-plugin/plugin.json` plus the `skills/` and `agents/` directories make the repo a self-contained Claude Code plugin. Skills are namespaced as `/raptor:<skill>` (e.g. `/raptor:fix-bug`).

**Load directly from a local path (dev or single-machine use):**

```bash
claude --plugin-dir "$RAPTOR_DIR"
```

**Install via a marketplace (sharing across machines/teams):**

1. Add Raptor's git repo as a marketplace source:
   ```bash
   /plugin marketplace add samuelishida/raptor
   ```
2. Install the plugin:
   ```bash
   /plugin install raptor@samuelishida/raptor
   ```

**Available after install (all namespaced under `/raptor:`):**

| Skill | Description |
|---|---|
| `raptor` | Master router — identifies intent and delegates |
| `agent-flow-builder` | Design and generate `.raptor/agents.json` + `flows.json` |
| `fix-bug` | Hypothesis-first root cause analysis |
| `plan-small` / `plan-large` | Technical planning with increment DAGs |
| `code-audit` | Parallel specialist audit (logic, security, simplification) |
| `refactor` | Behavior-preserving cleanup |
| `review-large-pr` | Chunked PR review for 30+ file changes |
| and more... | See `skills/` directory |

> **Flow runner note:** The `agent-flow-builder` skill generates `.raptor/agents.json` and `flows.json` in any tool. The interactive multi-step flow *runner* (`/flow <id>` with model-per-step switching and between-step confirmations) is VS Code only. In Claude Code and other CLI tools, flows are executed conversationally by the AI following the skill process.

---

### Codex CLI

Codex CLI has no plugin manifest — it loads custom instructions and skills via `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`).

**Option A — point Codex at the Raptor orchestrator as its base instructions:**

```toml
model_instructions_file = "/path/to/raptor/agents/raptor.md"
```

`model_instructions_file` replaces Codex's built-in base instructions. Use an absolute path, or a path relative to the `.codex/` folder.

**Option B — register Raptor skills individually:**

```toml
[[skills.config]]
path = "/path/to/raptor/skills/raptor"
enabled = true

[[skills.config]]
path = "/path/to/raptor/skills/fix-bug"
enabled = true

[[skills.config]]
path = "/path/to/raptor/skills/plan-small"
enabled = true

# ...repeat for every skill in skills/ you want available
```

Codex's `[[skills.config]]` exposes each `SKILL.md` to its native skill tool.

**Option C — drop a project-level `AGENTS.md`:**

```bash
cp "$RAPTOR_DIR/agents/raptor.md" ./AGENTS.md
```

Codex auto-loads `AGENTS.md` from the project root.

---

### OpenCode

OpenCode reads skills from several locations, including `.claude/skills/` — so the Claude Code layout works without any conversion.

**Option A — workspace install (clone or symlink):**

```bash
# Either copy:
mkdir -p .opencode
cp -r "$RAPTOR_DIR/skills" .opencode/skills
cp -r "$RAPTOR_DIR/agents" .opencode/agents

# Or symlink:
ln -s "$RAPTOR_DIR/skills" .opencode/skills
ln -s "$RAPTOR_DIR/agents" .opencode/agents
```

**Option B — global install:**

```bash
mkdir -p ~/.config/opencode
ln -s "$RAPTOR_DIR/skills" ~/.config/opencode/skills
ln -s "$RAPTOR_DIR/agents" ~/.config/opencode/agents
```

**Option C — reuse a Claude layout you already have:**

If the workspace already has `.claude/skills/`, OpenCode will pick it up automatically. Drop Raptor's `skills/` and `agents/` there once and both tools share the same source.

OpenCode invokes agents via `@<name>` and exposes skills through its native skill tool. Slash commands can be added by copying any `SKILL.md` whose name should be a command into `.opencode/commands/`.

---

### Generic — any tool that accepts a system prompt or instructions file

If your tool (Cursor, Windsurf, Cline/Roo, Continue.dev, Aider, Gemini CLI, etc.) supports a custom system prompt, instructions file, or rules file, point it at:

```bash
"$RAPTOR_DIR/agents/raptor.md"          # full orchestrator
"$RAPTOR_DIR/skills/<name>/SKILL.md"    # one specific skill
```

Examples:

- **Cursor** — `.cursor/rules/raptor.mdc` with the contents of `agents/raptor.md`
- **Windsurf** — `.windsurf/rules/raptor.md` with the contents of `agents/raptor.md`
- **Cline / Roo Code** — `.clinerules` (workspace) or custom mode with `agents/raptor.md` as system prompt
- **Continue.dev** — `systemMessage` in `~/.continue/config.json` pointing at `agents/raptor.md`
- **Aider** — `--system-prompt "$(cat $RAPTOR_DIR/agents/raptor.md)"` or `system-prompt:` in `.aider.conf.yml`
- **Gemini CLI** — `--system-instruction "$(cat $RAPTOR_DIR/agents/raptor.md)"` or `GEMINI_SYSTEM_INSTRUCTION` env var

These integrations only need the markdown content — no plugin runtime, no npm package required.

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
| `/memory` | Show workspace project memory (`--global` includes user-wide memory) |
| `/resume` | Load last workspace session summary and continue |
| `/todos` | Show current workspace todo list |
| `/clearmemory` | Clear workspace project memory (`--global` also clears user-wide memory) |
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
| `ollama` | `native-tools` | ✓ | Local models — requires running Ollama server |
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

### Workspace state

Runtime state is workspace-scoped by default:

- Project memory: `<workspace>/.raptor/MEMORY.md`
- Session resume summary: `<workspace>/.raptor/last-session-summary.md`
- Conversation history: `<workspace>/.raptor/history/`
- Flow checkpoints: `<workspace>/.raptor/flow-state/`
- Todos: `<workspace>/.raptor/todos.json`
- Plans: `<workspace>/.plans/<slug>/plan.md`

Global memory under `~/.raptor/memory/MEMORY.md` is only used when explicitly requested with `scope="global"` or `/memory --global`.

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
- Flow *execution* (`/flow <id>`) is VS Code only; other tools use `flows.json` as design reference

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
skills/               Skill pack (Claude/OpenCode plugin assets, also in npm package)
agents/               Agent definitions (orchestrator + audit specialists)
.claude-plugin/
  plugin.json         Claude Code plugin manifest
dist/                 Compiled JS output (VS Code extension runtime)
```

## Build

```bash
npm install          # install dev dependencies
npm run compile      # compile TypeScript → dist/
npm run watch        # watch mode for development
npx vsce package --no-dependencies   # build VSIX
```
