import {
  DEFAULT_ORCHESTRATION_TOOL_NAMES,
  SUB_AGENT_DEFAULT_TOOL_NAMES,
} from './registry'

export interface ToolCatalogEntry {
  readonly name: string
  readonly help: string
  readonly isCore?: boolean
  readonly isInternal?: boolean
  readonly includeInSubAgentDefault?: boolean
}

export const LOCAL_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { name: 'readFile', help: 'Read file (optional line range)', isCore: true, includeInSubAgentDefault: true },
  { name: 'writeFile', help: 'Create or overwrite a file', includeInSubAgentDefault: true },
  { name: 'editFile', help: 'Surgical old->new string replacement', includeInSubAgentDefault: true },
  { name: 'multiEdit', help: 'Batch edits across multiple files', includeInSubAgentDefault: true },
  { name: 'listDir', help: 'List directory contents', isCore: true, includeInSubAgentDefault: true },
  { name: 'glob', help: 'Find files by glob pattern', isCore: true, includeInSubAgentDefault: true },
  { name: 'searchCode', help: 'Search text or regex across files', isCore: true, includeInSubAgentDefault: true },
  { name: 'runTerminal', help: 'Run shell commands when a specialist agent needs them', includeInSubAgentDefault: true },
  { name: 'webFetch', help: 'Fetch a URL' },
  { name: 'getDiagnostics', help: 'VS Code errors/warnings', isCore: true, includeInSubAgentDefault: true },
  { name: 'lsp', help: 'Go-to-definition, references, hover, symbols', isCore: true, includeInSubAgentDefault: true },
  { name: 'spawnAgent', help: 'Spawn a sub-agent with a scoped task', isInternal: true },
] as const

export const LOCAL_TOOL_NAMES = LOCAL_TOOL_CATALOG.map(tool => tool.name)
export const ALL_TOOL_NAMES = [...LOCAL_TOOL_NAMES]

export const SUB_AGENT_DEFAULT_TOOLS = LOCAL_TOOL_CATALOG
  .filter(tool => tool.includeInSubAgentDefault)
  .map(tool => tool.name)

export const SUB_AGENT_DEFAULT_TOOLS_NOTE = [
  'Sub-agents get the code navigation, edit, terminal, and verification tools by default.',
  'Web fetches stay in the parent agent unless explicitly allowed.',
  'Nested agent spawning is reserved for internal orchestration workflows or explicit agent/tool allowlists.',
].join(' ')

export function buildHelpMarkdown(): string {
  const coreRows = LOCAL_TOOL_CATALOG
    .filter(tool => tool.isCore)
    .map(tool => `| \`${tool.name}\` | ${tool.help} |`)

  const specialistRows = LOCAL_TOOL_CATALOG
    .filter(tool => !tool.isCore && !tool.isInternal)
    .map(tool => `| \`${tool.name}\` | ${tool.help} |`)

  return [
    '## @raptor slash commands',
    '',
    '| Command | Description |',
    '|---|---|',
    '| `/help` | Show this reference |',
    '| `/skills` | List loaded skills |',
    '| `/agents` | List loaded agents |',
    '| `/agent <id>` | Inspect a loaded agent |',
    '| `/agent <id> <task...>` | Run a request-scoped task with that agent |',
    '| `/flows` | List loaded flows |',
    '| `/flow <id>` | Run a specific flow |',
    '| `/models` | List providers, capability, and available models |',
    '| `/build-flow` | Design and build an agent flow (defaults inferred when omitted) |',
    '',
    '## Core tools',
    '',
    '| Tool | What it does |',
    '|---|---|',
    ...coreRows,
    '',
    '## Specialist tools',
    '',
    '| Tool | What it does |',
    '|---|---|',
    ...specialistRows,
    '',
    'Internal orchestration tools are available only to explicit specialist agents and internal workflows.',
    '',
    `Default orchestration tools: ${DEFAULT_ORCHESTRATION_TOOL_NAMES.map(t => `\`${t}\``).join(', ')}`,
    `Default sub-agent tools: ${SUB_AGENT_DEFAULT_TOOL_NAMES.map(t => `\`${t}\``).join(', ')}`,
  ].join('\n')
}
