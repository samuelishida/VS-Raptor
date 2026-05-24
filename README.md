# Raptor

Deterministic agent orchestrator that helps you load skills, coordinate specialist agents, and run multi-step flows.

Works as a **VS Code extension**, a **Claude Code plugin**, and a **skill pack** for Codex CLI, OpenCode, Cursor, and any AI coding tool that accepts a system prompt or instructions file.

## Features

- **Chat Participant**: Interact with `@raptor` directly in VS Code's chat panel
- **Skills**: Load normal markdown skills and attach them to specialist agents
- **Agent Flows**: Run multi-step flows with explicit preflight, checkpoints, and resume support (VS Code only — see note below)
- **Provider Switching**: Route to VS Code models or delegated CLI tools per agent or flow step
- **LSP Integration**: Go-to-definition, find references, and diagnostics
- **Config Importers**: Reads `.claude`, `.codex`, and `.opencode` configs automatically

---

## Installation

All non-VS-Code targets share a single source directory. Get it once:

```bash
git clone https://github.com/samuelishida/raptor.git
# or
npm install -g raptor
```

Then run the shared installer:

```bash
./install.sh
# or, if installed from npm:
raptor-install
```

By default it installs only the orchestrator-core skills into `~/.claude/skills`, `~/.codex/skills`, `~/.opencode/skills`, and `~/.cursor/skills`. Pass `--profile all` if you want the optional skills and packaged agent files as well. Re-run it any time to refresh.

Set `RAPTOR_DIR` to that path if you want to use the manual snippets below:

```bash
export RAPTOR_DIR="/path/to/raptor"           # if cloned
# or
export RAPTOR_DIR="$(npm root -g)/raptor"
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
| `agent-flow-builder` | Design and generate `.raptor/agents/*.md` + `flows.yaml` |
| `fix-bug` | Hypothesis-first root cause analysis |
| `plan-small` / `plan-large` | Technical planning with increment DAGs |
| `code-audit` | Parallel specialist audit (logic, security, simplification) |
| `refactor` | Behavior-preserving cleanup |
| `review-large-pr` | Chunked PR review for 30+ file changes |
| and more... | See `skills/` directory |

> **Flow runner note:** The `agent-flow-builder` skill generates `.raptor/agents/*.md` and `.raptor/flows.yaml` in any tool. The interactive multi-step flow *runner* (`/flow <id>` with deterministic preflight, checkpoints, and resume) is VS Code only. In Claude Code and other CLI tools, flows are executed conversationally by the AI following the skill process.

---

### Codex CLI

The fastest path is `./install.sh` or `raptor-install`, which installs the default orchestrator-core skills into all supported targets automatically.

**Option A — point Codex at a custom instructions file:**

```toml
model_instructions_file = "/path/to/custom-instructions.md"
```

`model_instructions_file` replaces Codex's built-in base instructions. Use an absolute path, or a path relative to the `.codex/` folder. Start from any markdown instructions file you assemble from the skills you want.

**Option B — register Raptor skills individually:**

```toml
[[skills.config]]
path = "/path/to/raptor/skills/fix-bug"
enabled = true

[[skills.config]]
path = "/path/to/raptor/skills/plan-small"
enabled = true

# ...repeat for every skill in skills/ you want available
```

Codex's `[[skills.config]]` exposes each `SKILL.md` to its native skill tool. If you used `install.sh`, you can point these entries at `~/.codex/skills/<name>` instead of the repo checkout.

**Option C — drop a project-level `AGENTS.md`:**

```bash
cp /path/to/your/instructions.md ./AGENTS.md
```

Codex auto-loads `AGENTS.md` from the project root.

---

### OpenCode

OpenCode reads skills from several locations, including `.claude/skills/` — so the installer output works without any conversion.

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

OpenCode invokes agents via `@<name>` and exposes skills through its native skill tool. Slash commands can be added by copying any `SKILL.md` whose name should be a command into `.opencode/commands/`. Skills installed for OpenCode now use the tool's default model selection unless a specific model is intentionally configured.

---

### Generic — any tool that accepts a system prompt or instructions file

If your tool (Cursor, Windsurf, Cline/Roo, Continue.dev, Aider, Gemini CLI, etc.) supports a custom system prompt, instructions file, or rules file, point it at:

```bash
"$RAPTOR_DIR/skills/<name>/SKILL.md"    # one specific skill
```

Examples:

- **Cursor** — `.cursor/rules/raptor.mdc` with the instructions you want
- **Windsurf** — `.windsurf/rules/raptor.md` with the instructions you want
- **Cline / Roo Code** — `.clinerules` (workspace) or custom mode with your instructions file as the system prompt
- **Continue.dev** — `systemMessage` in `~/.continue/config.json` pointing at your instructions file
- **Aider** — `--system-prompt "$(cat /path/to/instructions.md)"` or `system-prompt:` in `.aider.conf.yml`
- **Gemini CLI** — `--system-instruction "$(cat /path/to/instructions.md)"` or `GEMINI_SYSTEM_INSTRUCTION` env var

These integrations only need the markdown content — no plugin runtime, no npm package required.

---

## Usage (VS Code)

- Open chat panel: `Ctrl+Alt+I` / `Cmd+Option+I`
- Type `@raptor` to invoke the agent
- Use `/help` to see all commands
- Use `/skills` to list loaded skills

### Slash commands

| Command | Description |
|---|---|
| `/help` | Show this reference |
| `/skills` | List loaded skills |
| `/agents` | List loaded agents |
| `/agent <id>` | Inspect a loaded agent |
| `/agent <id> <task...>` | Run a request-scoped task with that agent |
| `/flows` | List loaded flows |
| `/flow <id>` | Run a multi-step flow |
| `/models` | List providers, capability, and available models |
| `/build-flow` | Design and generate an agent flow (defaults inferred when omitted) |

---

## Providers

Raptor can route requests to VS Code models or delegated CLI providers. Configure via VS Code settings (`Ctrl+,` → search `raptor`).

### Provider compatibility matrix

| Provider ID | Capability | Tools | Notes |
|---|---|---|---|
| `vscode` | `native-tools` | ✓ | Default - uses VS Code Language Model API (Copilot, etc.) |
| `claude-code` | `delegated` | ✗ | Claude Code CLI subprocess |
| `codex` | `delegated` | ✗ | Codex CLI subprocess |
| `opencode` | `delegated` | ✗ | OpenCode CLI subprocess |

`delegated` providers run as subprocesses and do not participate in Raptor's tool loop.

### Model spec syntax

```
vscode:copilot-gpt-4          # VS Code provider, explicit model
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

### CLI provider settings

Set CLI command paths in user or machine scope. Workspace overrides are ignored with a warning.

```json
"raptor.provider.claude-code.command": "claude",
"raptor.provider.claude-code.defaultModel": "sonnet",
"raptor.provider.codex.command": "codex",
"raptor.provider.codex.defaultModel": "gpt-5.3-codex",
"raptor.provider.opencode.command": "opencode"
```

### Enabling providers

`vscode` is always available. Enable the delegated CLI providers in settings:

```json
"raptor.providers.enabled": {
  "claude-code": true,
  "codex": false,
  "opencode": false
}
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

- Flow checkpoints: `<workspace>/.raptor/flow-state/`
- Plans: `<workspace>/.plans/<slug>/plan.md`

### Skills (`skills.md`)

```markdown
## code-review
When reviewing code, focus on:
- Security issues (OWASP top 10)
- Performance bottlenecks

## commit-message
Write commit messages in Conventional Commits format.
```

Also supports `skills/<name>/SKILL.md` format for normal installed skills.

### Agents (`agents/*.md`)

```md
---
name: reviewer
description: Security and quality focused reviewer
skills: code-audit
tools: readFile, searchCode, getDiagnostics
model: claude-code:sonnet
---

You are a senior code reviewer. Be thorough but kind.
```

- Omit `tools` — all tools allowed (default)
- `model` — provider-qualified spec or plain model name

### Flows (`flows.yaml`)

```yaml
- id: plan-and-implement
  name: Plan and Implement
  steps:
    - agent: planner
      instruction: Break the request into a detailed implementation plan.
      model: codex:gpt-5.3-codex
      summaryBudget: 1500
    - agent: coder
      instruction: Implement the plan from the previous step.
      model: vscode:copilot-gpt-4
```

- `summaryBudget` — max characters of previous step output passed to next step
- Step `model`/`skills`/`tools` override the agent's own settings for that step only
- Flow *execution* (`/flow <id>`) is VS Code only; other tools use `flows.yaml` as design reference
- Imported `.claude`, `.codex`, and `.opencode` config is treated as migration input, not authoritative runtime state

---

## Project Structure

```
extension.ts          VS Code extension entry point
src/
  chat/               Chat participant, message adapter, system prompt
  commands/           VS Code command registration
  config/             Loader, model parsing, config importers, built-in skills
    importers/        .claude, .codex, .opencode config importers
  providers/          Provider registry, types, and adapters
    vscode.ts         VS Code Language Model API
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
