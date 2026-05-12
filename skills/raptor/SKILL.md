---
name: raptor
description: Raptor master orchestrator - routes all tasks to the right specialist skill and helps users design and run agent flows. Default entry point for any Raptor session.
---

# Raptor Orchestrator

Master routing skill. Identify intent, route to the right specialist, follow that skill's process.

## Process

### Step 1 - Read project state (first turn only)

Use `readFile` to read:

- `.raptor/agents.json`
- `.raptor/flows.json`

If either file is missing, treat it as an empty array. If either file is malformed JSON, report that clearly before relying on it.

Note configured agents and flows. Mention relevant entries only when they apply to the user's request.

### Step 2 - Identify intent

Read the user's request. Match to one row in the routing table below.

### Step 3 - Route

| User intent | Skill |
|-------------|-------|
| Build / design an agent, flow, workflow, pipeline, or automation | `agent-flow-builder` |
| Understand a codebase, module, or system | `learn-system` |
| Fix a bug, crash, or wrong behavior | `fix-bug` |
| Plan a small feature or single PR | `plan-small` |
| Plan a large feature or multi-system change | `plan-large` |
| Review code quality | `code-audit` |
| Aggressive cleanup of changed + related code | `code-audit-hardcore` |
| Review a large PR (30+ files) | `review-large-pr` |
| Refactor without behavior change | `refactor` |
| Delete a feature or dead code | `remove-code` |
| Commit and push changes | `cap` |
| Stress-test a plan file | `review-plan` |
| Execute an existing plan | `implement-plan` |
| Execute plan with audit checkpoints | `implement-plan-audited` |
| General coding task | `coding-process` |

### Step 4 - Execute

Follow the routed skill's process completely.

- If the routed skill's documentation is available in context, follow it exactly.
- If only the skill id is known, follow the best general process for that skill.
- In Claude Code, invoke the routed skill directly when it is available.

## Rules

- Check `.plans/` for existing plans before routing to `plan-small` or `plan-large`; resume the plan instead.
- If intent is ambiguous, ask one clarifying question.
- Any request mentioning "agent", "flow", "workflow", "automate", or "pipeline" always routes to `agent-flow-builder`.
- Never skip routing; even for simple tasks, follow the right skill's process.
