---
name: agent-flow-builder
description: Interactive flow designer - interviews the user about what they want to automate, then generates agent markdown files plus flows.yaml config for Raptor. Use when the user wants to build a custom agent, define a multi-step workflow, or chain skills together.
---

# Agent Flow Builder

Conversational flow designer. Interview, design, generate, confirm.

## Raptor Config Reference

### agents folder shape

Create one markdown file per agent at `.raptor/agents/<id>.md`:

```md
---
name: my-agent
description: One line - shown in /agents list
skills: fix-bug, code-audit
tools: readFile, searchCode, runTerminal
model: claude-sonnet-4.6
---

System prompt. 1-3 sentences for focused agents.
```

- Omitting `tools` means the agent gets all tools.
- `skills` is a comma-separated list of skill IDs appended to the system prompt.
- `model` is optional per-agent override; omit it to use the default model selected by the host tool.

**Available tool names:** `readFile`, `writeFile`, `editFile`, `multiEdit`, `listDir`, `glob`, `searchCode`, `runTerminal`, `webFetch`, `getDiagnostics`, `lsp`, `spawnAgent`

**Model values:** use the host tool's default selection when omitted; otherwise prefer the provider-qualified model syntax the host tool supports.

### flows.yaml shape

```yaml
- id: my-flow
  name: Human-readable name
  description: One line - shown in /flows list
  steps:
    - agent: agent-id
      instruction: Concrete, specific task for this step
      model: claude-sonnet-4.6
      skills:
        - skill-id
      tools:
        - readFile
        - searchCode
      summaryBudget: 2000
```

- `agent` references an agent id; use `"_default"` for the default agent.
- `summaryBudget` is the max characters of step output passed to the next step.
- Step `model`/`skills`/`tools` override the agent's own settings for that step only.

### Built-in skills available to reference

Any skill in this repo's `skills/` directory, for example `coding-process`, `fix-bug`, `plan-small`, `plan-large`, `code-audit`, `code-audit-hardcore`, `review-large-pr`, `refactor`, `remove-code`, `cap`, `review-plan`, `implement-plan`, `implement-plan-audited`, `learn-system`, `design-master`, `agent-flow-builder`, `init-phoenix`.

## Process

### Phase 1 - Read current config

Use `glob` and `readFile` to inspect, in this order:

- workspace `.raptor/agents/*.md`
- workspace `.raptor/flows.yaml`
- global `~/.raptor/agents/*.md`
- global `~/.raptor/flows.yaml`

If the workspace files are absent, fall back to the global `~/.raptor` files. If YAML/Markdown is absent, you may read legacy `.json` only for migration. If a YAML or JSON file exists but is malformed, stop and tell the user which file must be fixed before writing.

Report either `Found N agents and M flows.` or `No config yet - starting fresh.`

### Phase 2 - Interview

Send the user one message with these numbered questions. Wait for their answer.

```text
To design your flow, I need a few details:

1. What do you want to automate? Describe the workflow in plain language.
2. Single agent or multi-step flow?
3. What does it need to do? read files / write files / run terminal / search code / fetch web / all
4. Should it use a specific model? default: claude-sonnet-4.6; CLI examples: claude-code:sonnet, codex:default, opencode:default
5. Which built-in skills should it use, if any? or "none"
```

If the user leaves a field unspecified, choose a sensible default and say what you chose in the draft instead of asking for extra flags.

### Phase 3 - Design

Based on answers, draft the config. Show it to the user before writing.

```text
Here's what I'll create:

Agent: <id>
  Purpose: <description>
  Prompt: "<system prompt>"
  Skills: <list or none>
  Tools: <list or "all">
  Model: <model>

Flow: <id> (if multi-step)
  Step 1 - <agent>: <instruction>
  Step 2 - <agent>: <instruction>

Shall I write this to `.raptor/agents/<id>.md` and `.raptor/flows.yaml`?
```

Wait for confirmation. Adjust if the user requests changes.

### Phase 4 - Generate

Read existing config, merge new entries, write back. Never drop existing entries.

For agents:

1. Read `.raptor/agents/<id>.md` if it exists.
2. If it exists, tell the user it will be replaced.
3. Write one markdown file per agent with YAML frontmatter and the prompt body.

For flows:

1. Read existing YAML with `readFile`.
2. Parse it as a top-level array or as `{ flows: [...] }`.
3. If an existing flow has the same `id`, tell the user it will be replaced.
4. Remove entries with the same `id`.
5. Append the new or updated flow.
6. Write pretty YAML with two-space indentation.

Write `.raptor/agents/<id>.md` and, if creating a flow, `.raptor/flows.yaml`.

### Phase 5 - Confirm

Show the user:

1. The written YAML blocks.
2. How to invoke: `/agent <id>` to inspect the agent, `/agent <id> <task...>` to run one request with that agent, `/flow <id>` to run the flow.
3. Config path: `.raptor/agents/<id>.md` / `.raptor/flows.yaml`.

## Rules

- Never overwrite an existing agent/flow with the same id without noting it explicitly.
- Prefer `"tools": null` for general-purpose agents; restrict tools for narrow/safe ones.
- Keep system prompts short: 1-3 sentences for focused agents.
- For flows with more than 3 steps, confirm step order before generating.
- If the user's request maps to a built-in skill, say so and suggest using the skill directly rather than creating a redundant agent.
- If the user wants a skill workflow rather than an agent persona, explain the difference and offer both if appropriate.
