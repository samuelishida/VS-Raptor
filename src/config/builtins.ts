// ─── Built-in skill data for VS Code runtime ──────────────────────────────────────

import { Skill } from './loader'

/**
 * Built-in skills included with the VS Code extension.
 * These are compiled TypeScript data that ship in dist/src/ and are merged
 * at the lowest precedence so workspace/user config can override them.
 *
 * Content sourced from skills/raptor/SKILL.md and skills/agent-flow-builder/SKILL.md
 */

export const builtinSkills: Skill[] = [
  {
    id: 'raptor',
    content: `# Raptor Orchestrator

Master routing skill. Identify intent, route to the right specialist, follow that skill's process.

## Process

### Step 1 - Read project state (first turn only)

Use \`readFile\` to read:

- \`.raptor/agents.json\`
- \`.raptor/flows.json\`

If either file is missing, treat it as an empty array. If either file is malformed JSON, report that clearly before relying on it.

Note configured agents and flows. Mention relevant entries only when they apply to the user's request.

### Step 2 - Identify intent

Read the user's request. Match to one row in the routing table below.

### Step 3 - Route

| User intent | Skill |
|-------------|-------|
| Build / design an agent, flow, workflow, pipeline, or automation | \`agent-flow-builder\` |
| Understand a codebase, module, or system | \`learn-system\` |
| Fix a bug, crash, or wrong behavior | \`fix-bug\` |
| Plan a small feature or single PR | \`plan-small\` |
| Plan a large feature or multi-system change | \`plan-large\` |
| Review code quality | \`code-audit\` |
| Aggressive cleanup of changed + related code | \`code-audit-hardcore\` |
| Review a large PR (30+ files) | \`review-large-pr\` |
| Refactor without behavior change | \`refactor\` |
| Delete a feature or dead code | \`remove-code\` |
| Commit and push changes | \`cap\` |
| Stress-test a plan file | \`review-plan\` |
| Execute an existing plan | \`implement-plan\` |
| Execute plan with audit checkpoints | \`implement-plan-audited\` |
| General coding task | \`coding-process\` |

### Step 4 - Execute

Follow the routed skill's process completely.

- If the routed skill's documentation is available in context, follow it exactly.
- If only the skill id is known, follow the best general process for that skill.
- In Claude Code, invoke the routed skill directly when it is available.

## Rules

- Check \`.plans/\` for existing plans before routing to \`plan-small\` or \`plan-large\`; resume the plan instead.
- If intent is ambiguous, ask one clarifying question.
- Any request mentioning "agent", "flow", "workflow", "automate", or "pipeline" always routes to \`agent-flow-builder\`.
- Never skip routing; even for simple tasks, follow the right skill's process.
`,
    source: 'builtin:raptor',
  },
  {
    id: 'agent-flow-builder',
    content: `# Agent Flow Builder

Conversational flow designer. Interview, design, generate, confirm.

## Raptor Config Reference

### agents.json shape

\`\`\`json
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
\`\`\`

- \`tools: null\` means the agent gets all tools.
- \`skills\` is the list of skill IDs appended to the system prompt.
- \`model\` is optional per-agent override; defaults to workspace setting.

**Available tool names:** \`readFile\`, \`writeFile\`, \`editFile\`, \`multiEdit\`, \`listDir\`, \`glob\`, \`searchCode\`, \`runTerminal\`, \`webFetch\`, \`getDiagnostics\`, \`todoWrite\`, \`memoryRead\`, \`memoryWrite\`, \`lsp\`, \`spawnAgent\`

**Model values:** \`claude-sonnet-4.6\`, \`claude-opus-4\`, \`claude-code:sonnet\`, \`claude-code:opus\`, \`codex:default\`, \`codex:gpt-5.3-codex\`, \`opencode:default\`, \`opencode:anthropic/claude-sonnet-4-5\`, \`anthropic:claude-sonnet-4-20250514\`, \`openai:gpt-4o\`, \`ollama:llama3.1\`

### flows.json shape

\`\`\`json
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
\`\`\`

- \`agent\` references an agent id; use \`"_default"\` for the default agent.
- \`summaryBudget\` is the max characters of step output passed to the next step.
- Step \`model\`/\`skills\`/\`tools\` override the agent's own settings for that step only.

### Built-in skills available to reference

\`raptor\`, \`coding-process\`, \`fix-bug\`, \`plan-small\`, \`plan-large\`, \`code-audit\`, \`code-audit-hardcore\`, \`review-large-pr\`, \`refactor\`, \`remove-code\`, \`cap\`, \`review-plan\`, \`implement-plan\`, \`implement-plan-audited\`, \`learn-system\`, \`design-master\`, \`agent-flow-builder\`

## Process

### Phase 1 - Read current config

Use \`readFile\` to read:

- \`.raptor/agents.json\`
- \`.raptor/flows.json\`

If a file is missing, treat it as \`[]\`. If a file exists but is malformed JSON, stop and tell the user which file must be fixed before writing. Accept either a top-level array or an object with an \`agents\` / \`flows\` array.

Report either \`Found N agents and M flows.\` or \`No config yet - starting fresh.\`

### Phase 2 - Interview

Send the user one message with these numbered questions. Wait for their answer.

\`\`\`text
To design your flow, I need a few details:

1. What do you want to automate? Describe the workflow in plain language.
2. Single agent or multi-step flow?
3. What does it need to do? read files / write files / run terminal / search code / fetch web / all
4. Should it use a specific model? default: claude-sonnet-4.6; CLI examples: claude-code:sonnet, codex:default, opencode:default
5. Which built-in skills should it use, if any? or "none"
\`\`\`

### Phase 3 - Design

Based on answers, draft the config. Show it to the user before writing.

\`\`\`text
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
\`\`\`

Wait for confirmation. Adjust if the user requests changes.

### Phase 4 - Generate

Read existing config, merge new entries, write back. Never drop existing entries.

For each target file:

1. Read existing JSON with \`readFile\`.
2. Parse it as a top-level array or as \`{ "agents": [...] }\` / \`{ "flows": [...] }\`.
3. If an existing entry has the same \`id\`, tell the user it will be replaced.
4. Remove entries with the same \`id\`.
5. Append the new or updated entry.
6. Write pretty JSON with two-space indentation.

Write \`.raptor/agents.json\` and, if creating a flow, \`.raptor/flows.json\`.

### Phase 5 - Confirm

Show the user:

1. The written JSON blocks.
2. How to invoke: \`/agent <id>\` to switch to the agent, \`/flow <id>\` to run the flow.
3. Config path: \`.raptor/agents.json\` / \`.raptor/flows.json\`.

## Rules

- Never overwrite an existing agent/flow with the same id without noting it explicitly.
- Prefer \`"tools": null\` for general-purpose agents; restrict tools for narrow/safe ones.
- Keep system prompts short: 1-3 sentences for focused agents.
- For flows with more than 3 steps, confirm step order before generating.
- If the user's request maps to a built-in skill, say so and suggest using the skill directly rather than creating a redundant agent.
- If the user wants a skill workflow rather than an agent persona, explain the difference and offer both if appropriate.
`,
    source: 'builtin:agent-flow-builder',
  },
]

/**
 * Loaded in-load built-in config for integration.
 * Merged at lowest precedence before discoverConfigRoots() results.
 */
export function getBuiltinConfig(): {
  skills: Map<string, Skill>
  agents: Map<string, any>
  flows: Map<string, any>
  warnings: string[]
  sources: string[]
} {
  const skills = new Map<string, Skill>()
  const warnings: string[] = []
  const sources: string[] = []

  for (const skill of builtinSkills) {
    if (!skills.has(skill.id)) {
      skills.set(skill.id, skill)
      sources.push(skill.source)
    } else {
      warnings.push(`Built-in skill "${skill.id}" will be overridden by existing entry.`)
    }
  }

  return {
    skills,
    agents: new Map(),
    flows: new Map(),
    warnings,
    sources,
  }
}
