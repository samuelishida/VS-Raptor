import * as vscode from 'vscode'

export function getToolDefs(): vscode.LanguageModelChatTool[] {
  return [
    {
      name: 'readFile',
      description: 'Read the contents of a file. Optionally specify startLine/endLine (1-based).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path:      { type: 'string', description: 'Workspace-relative path. Absolute paths outside the workspace are rejected.' },
          startLine: { type: 'number', description: 'First line to read (1-based)' },
          endLine:   { type: 'number', description: 'Last line to read (1-based)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'writeFile',
      description: 'Create or overwrite a file with complete content. Use editFile for targeted edits.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path:    { type: 'string', description: 'Workspace-relative path. Absolute paths outside the workspace are rejected.' },
          content: { type: 'string', description: 'Complete file content to write' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'editFile',
      description:
        'Replace the FIRST occurrence of oldString with newString in a file. ' +
        'Include 3-5 lines of surrounding context in oldString to uniquely identify the location. ' +
        'Must read the file first. Fails if oldString appears 0 times. ' +
        'Pass replaceAll:true to replace ALL occurrences (e.g. variable rename within a file).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path:       { type: 'string',  description: 'Workspace-relative path. Absolute paths outside the workspace are rejected.' },
          oldString:  { type: 'string',  description: 'Exact string to replace (include context lines)' },
          newString:  { type: 'string',  description: 'Replacement string' },
          replaceAll: { type: 'boolean', description: 'Replace ALL occurrences instead of just the first' },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
    {
      name: 'multiEdit',
      description:
        'Apply multiple file edits atomically across one or more files. ' +
        'Validates ALL edits before writing any — if any oldString is not found the batch is aborted. ' +
        'Ideal for cross-file renames, adding imports + implementation together, or feature-flag changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          edits: {
            type: 'array',
            description: 'Array of edit operations to apply',
            items: {
              type: 'object',
              properties: {
                path:       { type: 'string',  description: 'Workspace-relative path. Absolute paths outside the workspace are rejected.' },
                oldString:  { type: 'string',  description: 'Exact string to replace (include context lines)' },
                newString:  { type: 'string',  description: 'Replacement string' },
                replaceAll: { type: 'boolean', description: 'Replace ALL occurrences in this file' },
              },
              required: ['path', 'oldString', 'newString'],
            },
          },
        },
        required: ['edits'],
      },
    },
    {
      name: 'listDir',
      description: 'List files and subdirectories. Directories end with /.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Directory path (use "." for workspace root)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'glob',
      description: 'Find files matching a glob pattern across the workspace.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. src/**/*.ts or **/*.json' },
          exclude: { type: 'string', description: 'Glob pattern for paths to exclude' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'searchCode',
      description: 'Search for a string or regex pattern across workspace files. Returns file:line: content.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query:         { type: 'string',  description: 'Search string or regex pattern' },
          glob:          { type: 'string',  description: 'Limit search to files matching this glob (e.g. src/**/*.ts)' },
          isRegex:       { type: 'boolean', description: 'Treat query as a regular expression' },
          caseSensitive: { type: 'boolean', description: 'Case-sensitive match (default: false)' },
          contextLines:  { type: 'number',  description: 'Lines of context before and after each match (0-5, like rg -C)' },
          maxResults:    { type: 'number',  description: 'Maximum number of result lines to return (default 200, max 500)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'runTerminal',
      description: 'Run a shell command and return stdout + stderr. Times out at 60s.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd:     { type: 'string', description: 'Working directory (defaults to workspace root)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'webFetch',
      description: 'Fetch a URL and return its text content (HTML stripped). Times out at 15s.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Full URL to fetch' },
        },
        required: ['url'],
      },
    },
    {
      name: 'getDiagnostics',
      description:
        'Get VS Code language-service diagnostics (errors, warnings, etc.) for a file or the whole workspace. ' +
        'Call this after editing files to verify your changes compiled cleanly.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path:     { type: 'string', description: 'File to check. Omit to check all open files.' },
          severity: { type: 'string', enum: ['error', 'warning', 'all'], description: 'Filter by severity (default: all)' },
        },
      },
    },
    {
      name: 'todoWrite',
      description: 'Persist a structured todo list to the current workspace .raptor/todos.json.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          todos: {
            type: 'array',
            description: 'Array of todo items',
            items: {
              type: 'object',
              properties: {
                id:       { type: 'string' },
                content:  { type: 'string' },
                status:   { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                priority: { type: 'string', enum: ['low', 'medium', 'high'] },
              },
              required: ['id', 'content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
    {
      name: 'memoryRead',
      description: 'Read persistent memory. scope="project" (default) reads workspace-specific facts. scope="global" reads user-wide facts. scope="all" reads both.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          scope: { type: 'string', enum: ['all', 'global', 'project'], description: 'Which memory to read (default: project)' },
        },
      },
    },
    {
      name: 'memoryWrite',
      description:
        'Write or update a memory entry. scope="project" (default) for workspace-specific facts (architecture, build commands, known issues). ' +
        'scope="global" for explicitly user-wide facts (preferences, patterns). ' +
        'Memories persist across sessions and are auto-injected into context.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic:   { type: 'string', description: 'Topic heading (e.g. "project-structure", "user-preferences", "build-commands")' },
          content: { type: 'string', description: 'The memory content to save' },
          replace: { type: 'boolean', description: 'Replace existing section with same topic (default: false = append)' },
          scope:   { type: 'string', enum: ['global', 'project'], description: 'Where to save: project (<workspace>/.raptor/) or global (~/.raptor/). Default: project' },
        },
        required: ['content'],
      },
    },
    {
      name: 'lsp',
      description:
        'VS Code LSP semantic navigation: go-to-definition, find-references, hover info, document/workspace symbols, ' +
        'implementations, type definitions. Use for precise code navigation instead of grep.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['definition', 'references', 'hover', 'symbols', 'workspaceSymbols', 'implementations', 'typeDefinition'], description: 'LSP action to perform' },
          path:   { type: 'string', description: 'File path (required for most actions except workspaceSymbols)' },
          line:   { type: 'number', description: 'Line number (1-based)' },
          col:    { type: 'number', description: 'Column number (1-based)' },
          query:  { type: 'string', description: 'Search query (for workspaceSymbols)' },
        },
        required: ['action'],
      },
    },
    {
      name: 'spawnAgent',
      description:
        'Spawn a sub-agent with a scoped task. The sub-agent runs its own LLM loop with file/terminal tools. ' +
        'Use for parallelisable sub-tasks (e.g. "fix linting in all test files"). Returns the sub-agent result.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task:          { type: 'string', description: 'Clear description of the scoped task for the sub-agent' },
          tools:         { type: 'array', items: { type: 'string' }, description: 'Tool names the sub-agent can use (default: file ops + terminal + lsp)' },
          maxIterations: { type: 'number', description: 'Max iterations for the sub-agent (default 20)' },
        },
        required: ['task'],
      },
    },
  ]
}
