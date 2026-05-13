# Raptor

Agent orchestrator that routes tasks to specialist skills, builds custom agent flows, and runs multi-step automations.

Works as a **VS Code extension**, a **Claude Code plugin**, and an **npm-installable skill pack** for any AI coding tool.

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
claude plugin install /path/to/raptor
```

This loads `skills/` and `agents/` into Claude Code's skill/agent system, making all Raptor skills available as `/` slash commands.

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

> **Note:** The `agent-flow-builder` skill generates `.raptor/agents.json` and `flows.json` config files in any tool. The multi-step flow *runner* (`/flow <id>` with model-per-step switching and between-step confirmations) is VS Code only. In Claude Code and other CLI tools, flows are executed conversationally by the AI following the skill process.

---

### Cursor

Cursor supports custom rules and system prompt injection via `.cursor/rules/`.

```bash
npm install -g raptor
```

Create `.cursor/rules/raptor.mdc`:

```markdown
---
description: Raptor orchestrator — route all coding tasks through the right specialist skill
alwaysApply: true
---

{{{ file NODE_MODULES_PATH/raptor/agents/raptor.md }}}
```

Or copy the skill files directly:

```bash
mkdir -p .cursor/rules
cp "$(npm root -g)/raptor/agents/raptor.md" .cursor/rules/raptor.mdc
```

For individual skills, copy specific `skills/<name>/SKILL.md` files as additional rule files.

---

### Windsurf

Windsurf uses `.windsurf/rules/` for global and workspace rules.

```bash
npm install -g raptor
```

Copy the orchestrator into your workspace rules:

```bash
mkdir -p .windsurf/rules
cp "$(npm root -g)/raptor/agents/raptor.md" .windsurf/rules/raptor.md
```

Or reference individual skills:

```bash
cp "$(npm root -g)/raptor/skills/fix-bug/SKILL.md" .windsurf/rules/fix-bug.md
cp "$(npm root -g)/raptor/skills/code-audit/SKILL.md" .windsurf/rules/code-audit.md
```

---

### Cline / Roo Code

Cline and Roo Code support custom instructions via `.clinerules` (workspace) or global settings.

```bash
npm install -g raptor
```

**Workspace rules** — create `.clinerules`:

```bash
cat "$(npm root -g)/raptor/agents/raptor.md" > .clinerules
```

**Custom modes (Roo Code)** — add a `raptor` mode in Roo Code settings, pasting the contents of `agents/raptor.md` as the system prompt.

---

### Continue.dev

Continue supports context providers and system prompt injection via `~/.continue/config.json`.

```bash
npm install -g raptor
```

Add to `~/.continue/config.json`:

```json
{
  "systemMessage": "$(cat $(npm root -g)/raptor/agents/raptor.md)"
}
```

Or statically paste the contents of `agents/raptor.md` into the `systemMessage` field.

For skill-specific contexts, use Continue's `@file` context provider pointing at individual skill files:

```
@file ~/.../node_modules/raptor/skills/fix-bug/SKILL.md Fix this bug.
```

---

### Aider

Aider supports custom instructions via `--system-prompt` or `.aider.conf.yml`.

```bash
npm install -g raptor
```

**One-off:**

```bash
aider --system-prompt "$(cat $(npm root -g)/raptor/agents/raptor.md)"
```

**Persistent** — add to `.aider.conf.yml` in your project or `~/.aider.conf.yml`:

```yaml
system-prompt: /path/to/node_modules/raptor/agents/raptor.md
```

For skill-specific workflows:

```bash
aider --system-prompt "$(cat $(npm root -g)/raptor/skills/fix-bug/SKILL.md)"
```

---

### Gemini CLI

Gemini CLI supports system instructions via `--system-instruction` or a `GEMINI_SYSTEM_INSTRUCTION` env var.

```bash
npm install -g raptor
```

**Per-session:**

```bash
gemini --system-instruction "$(cat $(npm root -g)/raptor/agents/raptor.md)"
```

**Persistent** — set in your shell profile:

```bash
export GEMINI_SYSTEM_INSTRUCTION="$(cat $(npm root -g)/raptor/agents/raptor.md)"
```

---

### Codex CLI

```bash
npm install -g raptor
```

In `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`):

```toml
instructions = """
Follow the Raptor orchestration process. Route tasks to the appropriate workflow:
- Bugs → fix-bug skill
- Planning → plan-small or plan-large skill
- Audits → code-audit skill
"""
```

Or point Codex at the orchestrator agent directly:

```toml
instructions-file = "/path/to/node_modules/raptor/agents/raptor.md"
```

---

### OpenCode

```bash
npm install -g raptor
```

In `.opencode/config.json` (workspace) or `~/.opencode/config.json` (global):

```json
{
  "instructions": "/path/to/node_modules/raptor/agents/raptor.md"
}
```

Use `npm root -g` to get the global node_modules path.

---

### Any other AI tool

If your tool accepts a system prompt, instructions file, or rules file, paste the contents of:

```bash
cat "$(npm root -g)/raptor/agents/raptor.md"
```

For specific skills instead of full orchestration:

```bash
# List available skills
ls "$(npm root -g)/raptor/skills/"

# Get a skill's content
cat "$(npm root -g)/raptor/skills/fix-bug/SKILL.md"
```

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
