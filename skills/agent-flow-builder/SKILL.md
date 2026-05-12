---
name: agent-flow-builder
description: Interactive flow designer - interviews the user about what they want to automate, then generates agents.json and flows.json config for Raptor. Use when the user wants to build a custom agent, define a multi-step workflow, or chain skills together.
---

# Agent Flow Builder

Conversational flow designer. Interview, design, generate, confirm.

## Raptor Config Reference

### agents.json shape

```json
[
  {
    "id": "my-agent",
    "name": "Human-readable name",
    "description": "One line - shown in /agents list",
    "prompt": "System prompt. 1-3 sentences for focused agents.",
    "skills": ["fix-bug", "code-audit"],
    "tools": ["readFile", "searchCode", "runTerminal"],
    "model": "claude-sonnet-4.6"
  }
]
```

- `tools: null` means the agent gets all tools.
- `skills` is the list of skill IDs appended to the system prompt.
- `model` is optional per-agent override; defaults to workspace setting.

**Available tool names:** `readFile`, `writeFile`, `editFile`, `multiEdit`, `listDir`, `glob`, `searchCode`, `runTerminal`, `webFetch`, `getDiagnostics`, `todoWrite`, `memoryRead`, `memoryWrite`, `lsp`, `spawnAgent`

**Model values:** `claude-sonnet-4.6`, `claude-opus-4`, `claude-code:sonnet`, `claude-code:opus`, `codex:default`, `codex:gpt-5.3-codex`, `opencode:default`, `opencode:anthropic/claude-sonnet-4-5`, `anthropic:claude-sonnet-4-20250514`, `openai:gpt-4o`, `ollama:llama3.1`

### flows.json shape

```json
[
  {
    "id": "my-flow",
    "name": "Human-readable name",
    "description": "One line - shown in /flows list",
    "steps": [
      {
        "agent": "agent-id",
        "instruction": "Concrete, specific task for this step",
        "model": "claude-sonnet-4.6",
        "skills": ["skill-id"],
        "tools": ["readFile", "searchCode"],
        "summaryBudget": 2000
      }
    ]
  }
]
```

- `agent` references an agent id; use `"_default"` for the default agent.
- `summaryBudget` is the max characters of step output passed to the next step.
- Step `model`/`skills`/`tools` override the agent's own settings for that step only.

### Built-in skills available to reference

`raptor`, `coding-process`, `fix-bug`, `plan-small`, `plan-large`, `code-audit`, `code-audit-hardcore`, `review-large-pr`, `refactor`, `remove-code`, `cap`, `review-plan`, `implement-plan`, `implement-plan-audited`, `learn-system`, `design-master`, `agent-flow-builder`

## Process

### Phase 1 - Read current config

Use `readFile` to read:

- `.raptor/agents.json`
- `.raptor/flows.json`

If a file is missing, treat it as `[]`. If a file exists but is malformed JSON, stop and tell the user which file must be fixed before writing. Accept either a top-level array or an object with an `agents` / `flows` array.

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

Shall I write this to .raptor/agents.json and .raptor/flows.json?
```

Wait for confirmation. Adjust if the user requests changes.

### Phase 4 - Generate

Read existing config, merge new entries, write back. Never drop existing entries.

For each target file:

1. Read existing JSON with `readFile`.
2. Parse it as a top-level array or as `{ "agents": [...] }` / `{ "flows": [...] }`.
3. If an existing entry has the same `id`, tell the user it will be replaced.
4. Remove entries with the same `id`.
5. Append the new or updated entry.
6. Write pretty JSON with two-space indentation.

Write `.raptor/agents.json` and, if creating a flow, `.raptor/flows.json`.

### Phase 5 - Confirm

Show the user:

1. The written JSON blocks.
2. How to invoke: `/agent <id>` to switch to the agent, `/flow <id>` to run the flow.
3. Config path: `.raptor/agents.json` / `.raptor/flows.json`.

## Rules

- Never overwrite an existing agent/flow with the same id without noting it explicitly.
- Prefer `"tools": null` for general-purpose agents; restrict tools for narrow/safe ones.
- Keep system prompts short: 1-3 sentences for focused agents.
- For flows with more than 3 steps, confirm step order before generating.
- If the user's request maps to a built-in skill, say so and suggest using the skill directly rather than creating a redundant agent.
- If the user wants a skill workflow rather than an agent persona, explain the difference and offer both if appropriate.
