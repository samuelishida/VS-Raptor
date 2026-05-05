import * as vscode from 'vscode'
import { shortenPath } from '../utils/paths'

export function renderToolResultDropdown(
  stream: vscode.ChatResponseStream,
  toolCall: vscode.LanguageModelToolCallPart,
  result: string,
): void {
  const input = toolCall.input as Record<string, unknown>
  const name = toolCall.name
  const label = toolCallLabel(name, input)
  const isError = result.startsWith('Error') || result.startsWith('✗')
  const isOk = result.startsWith('✓') || result.startsWith('✅')
  const icon = isError ? '❌' : isOk ? '✅' : '📄'
  const preview = compactPreview(name, result)

  stream.markdown(`\n${icon} **${shortToolName(name)}** ${label}: ${preview}\n`)
}

function compactPreview(toolName: string, result: string): string {
  if (result.length < 120 && !result.includes('\n')) {
    return result
  }

  const lines = result.split('\n').filter(line => line.trim().length > 0)
  const lineCount = lines.length

  switch (toolName) {
    case 'readFile':
      return `${lineCount} lines read`
    case 'writeFile':
    case 'editFile':
    case 'multiEdit':
      return lines[0].length > 100 ? lines[0].slice(0, 97) + '…' : lines[0]
    case 'runTerminal': {
      const firstLine = lines[0] ?? '(no output)'
      const trimmed = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine
      return lineCount <= 1 ? trimmed : `${trimmed} (${lineCount} lines)`
    }
    case 'searchCode': {
      const matchCount = lines.filter(line => line.includes(':')).length
      return matchCount > 0 ? `${matchCount} matches found` : 'No matches found.'
    }
    case 'listDir': {
      const dirs = lines.filter(line => line.endsWith('/')).length
      const files = lineCount - dirs
      return `${dirs} dirs, ${files} files`
    }
    case 'glob':
      return result === 'No files matched.' ? result : `${lineCount} files matched`
    case 'getDiagnostics':
      return result.startsWith('✓') ? result : `${lineCount} diagnostic(s)`
    case 'memoryRead':
      return result === '(no memories stored yet)' ? result : `${lineCount} memory line(s)`
    case 'memoryWrite':
    case 'lsp':
    case 'spawnAgent':
      return lines[0] ?? 'ok'
    case 'webFetch':
      return `${result.length.toLocaleString()} chars fetched`
    case 'todoWrite':
      return lines[0] ?? 'saved'
    default: {
      const first = lines[0] ?? ''
      return first.length > 100 ? first.slice(0, 97) + '…' : first
    }
  }
}

function toolCallLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'readFile':
    case 'writeFile':
    case 'editFile':
    case 'getDiagnostics': {
      const filePath = input['path'] as string | undefined
      return filePath ? `\`${shortenPath(filePath)}\`` : ''
    }
    case 'multiEdit': {
      const edits = input['edits'] as Array<{path: string}> | undefined
      if (!edits?.length) return ''
      const paths = [...new Set(edits.map(edit => shortenPath(edit.path)))]
      return paths.length <= 3 ? paths.map(filePath => `\`${filePath}\``).join(', ') : `${paths.length} files`
    }
    case 'listDir':
      return `\`${input['path'] ?? '.'}\``
    case 'glob':
      return `\`${input['pattern'] ?? ''}\``
    case 'searchCode':
      return `\`${input['query'] ?? ''}\``
    case 'runTerminal': {
      const command = input['command'] as string | undefined
      return command ? `\`${command.length > 60 ? command.slice(0, 57) + '…' : command}\`` : ''
    }
    case 'webFetch':
      return `\`${input['url'] ?? ''}\``
    case 'memoryRead':
    case 'memoryWrite': {
      const scope = input['scope'] as string | undefined
      return scope ? `\`${scope}\`` : ''
    }
    case 'lsp': {
      const action = input['action'] as string | undefined
      const target = input['path'] as string | undefined
      const parts = [action, target ? shortenPath(target) : undefined].filter(Boolean)
      return parts.length ? `\`${parts.join(': ')}\`` : ''
    }
    case 'spawnAgent': {
      const task = input['task'] as string | undefined
      if (!task) return ''
      return `\`${task.length > 60 ? task.slice(0, 57) + '…' : task}\``
    }
    case 'todoWrite':
      return ''
    default:
      return ''
  }
}

function shortToolName(name: string): string {
  return name
}