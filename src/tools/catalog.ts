export interface ToolCatalogEntry {
  readonly name: string
  readonly help: string
  readonly includeInSubAgentDefault?: boolean
}

export const LOCAL_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { name: 'readFile', help: 'Read file (optional line range)', includeInSubAgentDefault: true },
  { name: 'writeFile', help: 'Create or overwrite a file', includeInSubAgentDefault: true },
  { name: 'editFile', help: 'Surgical old->new string replacement', includeInSubAgentDefault: true },
  { name: 'multiEdit', help: 'Batch edits across multiple files', includeInSubAgentDefault: true },
  { name: 'listDir', help: 'List directory contents', includeInSubAgentDefault: true },
  { name: 'glob', help: 'Find files by glob pattern', includeInSubAgentDefault: true },
  { name: 'searchCode', help: 'Grep -- string/regex search across files', includeInSubAgentDefault: true },
  { name: 'runTerminal', help: 'Run shell commands, capture output', includeInSubAgentDefault: true },
  { name: 'webFetch', help: 'Fetch a URL' },
  { name: 'getDiagnostics', help: 'VS Code errors/warnings', includeInSubAgentDefault: true },
  { name: 'todoWrite', help: 'Persist todo list' },
  { name: 'memoryRead', help: 'Read persistent memory' },
  { name: 'memoryWrite', help: 'Write/update memory entry' },
  { name: 'lsp', help: 'Go-to-definition, references, hover, symbols', includeInSubAgentDefault: true },
  { name: 'spawnAgent', help: 'Spawn a sub-agent with a scoped task' },
] as const

export const LOCAL_TOOL_NAMES = LOCAL_TOOL_CATALOG.map(tool => tool.name)
export const ALL_TOOL_NAMES = [...LOCAL_TOOL_NAMES]

export const SUB_AGENT_DEFAULT_TOOLS = LOCAL_TOOL_CATALOG
  .filter(tool => tool.includeInSubAgentDefault)
  .map(tool => tool.name)

export const SUB_AGENT_DEFAULT_TOOLS_NOTE = 'Sub-agents intentionally get only code navigation, edit, terminal, and verification tools. Memory persistence, todo persistence, web fetches, and nested agent spawning stay in the parent agent unless explicitly allowed.'

export function buildHelpMarkdown(): string {
  const localRows = LOCAL_TOOL_CATALOG
    .map(tool => `| \`${tool.name}\` | ${tool.help} |`)

  return [
    '## @raptor slash commands',
    '',
    '| Command | Description |',
    '|---|---|',
    '| `/help` | Show this reference |',
    '| `/memory` | Show persistent memory |',
    '| `/resume` | Load last session summary and continue |',
    '| `/todos` | Show current todo list |',
    '| `/clearmemory` | Wipe all persistent memory |',
    '| `/steer <msg>` | Inject guidance into running agent (picked up next iteration) |',
    '',
    '## Tools',
    '',
    '| Tool | What it does |',
    '|---|---|',
    ...localRows,
  ].join('\n')
}