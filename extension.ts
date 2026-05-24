import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { getConfig } from './src/config/model'
import {
  getConfig as getLoadedConfig,
  filterToolsByAgent,
  getSkillContent,
  type Agent,
  type Flow,
  type LoadedConfig,
} from './src/config/loader'
import { registerChatParticipant as registerChatParticipantModule } from './src/chat/participant'
import { renderToolResultDropdown } from './src/chat/tool-result-render'
import { buildSystemPrompt } from './src/chat/system-prompt'
import { registerCommands as registerCommandsModule } from './src/commands/register'
import {
  buildHelpMarkdown,
  SUB_AGENT_DEFAULT_TOOLS,
} from './src/tools/catalog'
import { getToolDefs } from './src/tools/registry'
import {
  logToOutput as writeOutputLines,
  logToolCallToOutput as writeToolCallLog,
  summariseInput,
} from './src/utils/logging'
import {
  resolvePath,
  shortenPath,
  workspaceRoot,
} from './src/utils/paths'
import {
  createProviderRegistry,
  type ProviderRegistry,
} from './src/providers/registry'
import { createVSCodeProvider, setVSCodeSessionModel } from './src/providers/vscode'
import { createClaudeCodeProvider } from './src/providers/claude-code'
import { createCodexProvider } from './src/providers/codex-cli'
import { createOpenCodeProvider } from './src/providers/opencode-cli'
import {
  type RaptorMessage,
  type RaptorTextPart,
  type RaptorToolCallPart,
  type RaptorToolResultPart,
  type RaptorResponseEvent,
  type RaptorModel,
  type ResolvedModel,
  ProviderError,
} from './src/providers/types'
import {
  buildRuntimeMessages,
  appendToolResult,
  appendToolResultToMessages,
  compactRuntimeMessages,
  toRaptorMessages,
  fromRaptorMessages,
} from './src/chat/message-adapter'
import { loadProviderConfigs, logProviderStatus } from './src/providers/config'

// ─── Module-level singletons ───────────────────────────────────────────────────

let outputChannel: vscode.OutputChannel | undefined
let extContext: vscode.ExtensionContext | undefined
let providerRegistry: ProviderRegistry | undefined

function getRegistry(): ProviderRegistry {
  if (!providerRegistry) {
    throw new Error('Provider registry not initialized')
  }
  return providerRegistry
}

interface RequestScope {
  agentId: string
  task?: string
  isExplicitAgentRequest: boolean
}

function getConfiguredFallbackModel(): string {
  return vscode.workspace.getConfiguration('raptor').get<string>('model', 'claude-sonnet-4.6')
}

function getCommandArgs(prompt: string, commandName: string): string {
  const trimmed = prompt.trim()
  const slash = new RegExp(`^/${commandName}\\b\\s*`)
  return trimmed.replace(slash, '').trim()
}

/** Persistent data directory (~/.raptor by default). */
function raptorDataDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
  if (home?.trim()) return path.join(home, '.raptor')

  // Fallback if home cannot be resolved in restricted environments.
  const storage = extContext?.globalStorageUri?.fsPath
  if (storage) return path.join(storage, 'raptor')
  return path.join(os.tmpdir(), 'raptor')
}

/** Temp workspace for transient files and redirected shell output. */
function extensionTempDir(): string {
  const base = (process.env.TEMP || process.env.TMP || os.tmpdir()).trim()
  return path.join(base, 'raptor-temp')
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CONTEXT COMPACTION ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// Two tiers:
//   1. Micro-compact  — truncate tool results >2KB in old turns when >60K tokens
//   2. Full compact   — LLM-summarise everything when >85K tokens

const TOKEN_ESTIMATE_RATIO = 3.5
const MICRO_COMPACT_THRESHOLD  = 60_000
const FULL_COMPACT_THRESHOLD   = 85_000
const MICRO_COMPACT_TOOL_LIMIT = 2_048

interface CompactThresholds {
  micro: number
  full: number
}

function compactThresholdsForModel(model: RaptorModel): CompactThresholds {
  const maxInput = model.maxInputTokens
  if (!maxInput || maxInput <= 0) {
    return { micro: MICRO_COMPACT_THRESHOLD, full: FULL_COMPACT_THRESHOLD }
  }

  return {
    micro: Math.max(1_500, Math.floor(maxInput * 0.65)),
    full: Math.max(2_000, Math.floor(maxInput * 0.82)),
  }
}

function contextWindowNote(model: RaptorModel): string {
  return model.maxInputTokens ? `; context ${model.maxInputTokens.toLocaleString()}` : ''
}

function estimateTokens(messages: RaptorMessage[]): number {
  let total = 0
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part.type === 'text') {
        total += part.value.length / TOKEN_ESTIMATE_RATIO
      } else if (part.type === 'tool_result') {
        for (const c of part.content) {
          if (c.type === 'text') {
            total += c.value.length / TOKEN_ESTIMATE_RATIO
          }
        }
      } else if (part.type === 'tool_call') {
        total += JSON.stringify(part.input).length / TOKEN_ESTIMATE_RATIO
      }
    }
  }
  return Math.round(total)
}

function microCompactMessages(
  messages: RaptorMessage[],
  keepRecentTurns = 4,
): RaptorMessage[] {
  const cutoff = Math.max(2, messages.length - keepRecentTurns * 2)
  return messages.map((msg, idx) => {
    if (idx >= cutoff) return msg
    let changed = false
    const newParts = msg.content.map(part => {
      if (part.type !== 'tool_result') return part
      const newContent = part.content.map(c => {
        if (c.type !== 'text') return c
        if (c.value.length <= MICRO_COMPACT_TOOL_LIMIT) return c
        changed = true
        const preview = c.value.slice(0, MICRO_COMPACT_TOOL_LIMIT)
        return { type: 'text' as const, value: preview + `\n...[compacted: ${c.value.length} chars -> ${MICRO_COMPACT_TOOL_LIMIT}]` }
      })
      return { type: 'tool_result' as const, callId: part.callId, content: newContent }
    })
    if (!changed) return msg
    return { role: msg.role, content: newParts }
  })
}

async function fullCompactMessages(
  messages: RaptorMessage[],
  resolved: ResolvedModel,
  token: vscode.CancellationToken,
): Promise<RaptorMessage[]> {
  const convoText = messages
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant'
      const text = m.content
        .filter((p): p is RaptorTextPart => p.type === 'text')
        .map(p => p.value).join(' ')
      return `${role}: ${text.slice(0, 2000)}`
    }).join('\n\n').slice(0, 40_000)

  const summaryPrompt = [
    'Create a concise but complete summary of this coding conversation.',
    'Include: what was asked, what files were modified, key decisions, current state.',
    'Format as structured markdown with sections. Max 800 words.',
    '', convoText,
  ].join('\n')

  try {
    const stream = await resolved.provider.sendRequest(
      resolved.model,
      [{ role: 'user', content: [{ type: 'text', value: summaryPrompt }] }],
      {},
      token,
    )
    let summary = ''
    for await (const part of stream) {
      if (part.type === 'text') summary += part.value
    }
    const systemMessages = messages.filter(m => m.role === 'system')
    const recentMessages = messages.slice(-4)
    return compactRuntimeMessages(messages, systemMessages, summary, recentMessages)
  } catch {
    return microCompactMessages(messages, 6)
  }
}
// ─── Activation ───────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extContext = context
  outputChannel = vscode.window.createOutputChannel('raptor')
  context.subscriptions.push(outputChannel)

  providerRegistry = createProviderRegistry(context)
  providerRegistry.register(createVSCodeProvider())

  const providerConfigResult = await loadProviderConfigs(context)
  for (const warning of providerConfigResult.warnings) {
    logToOutput(warning)
  }

  const configs = providerConfigResult.configs
  for (const [id, cfg] of Object.entries(configs)) {
    if (!cfg.enabled) {
      logProviderStatus(id, 'disabled', logToOutput)
      continue
    }

    switch (id) {
      case 'vscode': continue
      case 'claude-code': {
        getRegistry().register(createClaudeCodeProvider({ model: cfg.defaultModel, command: cfg.command }))
        break
      }
      case 'codex': {
        getRegistry().register(createCodexProvider({ model: cfg.defaultModel, command: cfg.command }))
        break
      }
      case 'opencode': {
        getRegistry().register(createOpenCodeProvider({ model: cfg.defaultModel, command: cfg.command }))
        break
      }
    }
  }

  registerChatParticipant(context)
  registerCommands(context)
  // Ensure persistent + temp dirs exist early.
  void fs.mkdir(raptorDataDir(), { recursive: true }).catch(() => {})
  void fs.mkdir(extensionTempDir(), { recursive: true }).catch(() => {})
  console.log('[raptor] extension activated')
}

export function deactivate(): void {}

// ─── Tool dispatch ─────────────────────────────────────────────────────────────

type ToolInput = Record<string, unknown>

async function dispatchTool(name: string, input: ToolInput, token?: vscode.CancellationToken): Promise<string> {
  switch (name) {
    case 'readFile':       return toolReadFile(input)
    case 'writeFile':      return toolWriteFile(input)
    case 'editFile':       return toolEditFile(input)
    case 'multiEdit':      return toolMultiEdit(input)
    case 'listDir':        return toolListDir(input)
    case 'glob':           return toolGlob(input)
    case 'searchCode':     return toolSearchCode(input)
    case 'runTerminal':    return toolRunTerminal(input)
    case 'webFetch':       return toolWebFetch(input)
    case 'getDiagnostics': return toolGetDiagnostics(input)
    case 'lsp':            return toolLsp(input)
    case 'spawnAgent':     return toolSpawnAgent(input)
    default: return `Unknown tool: ${name}`
  }
}

async function executeToolCallsInOrder(
  toolCalls: RaptorToolCallPart[],
  token?: vscode.CancellationToken,
): Promise<Array<{ toolCall: RaptorToolCallPart; result: string }>> {
  if (toolCalls.length > 1) {
    console.warn('[Tool Dispatch] Multiple tools requested; executing sequentially to preserve result order:', toolCalls.map(t => t.name).join(', '))
  }

  const results: Array<{ toolCall: RaptorToolCallPart; result: string }> = []
  for (const toolCall of toolCalls) {
    if (token?.isCancellationRequested) break
    const input = toolCall.input as Record<string, unknown>
    let result: string
    try {
      result = await dispatchTool(toolCall.name, input, token)
    } catch (err) {
      result = `Error: ${String(err)}`
    }
    results.push({ toolCall, result })
  }
  return results
}

// ── readFile ─────────────────────────────────────────────────────────────
async function toolReadFile(input: ToolInput): Promise<string> {
  const absPath = resolvePath(input['path'] as string)
  let content: string
  try {
    content = await fs.readFile(absPath, 'utf-8')
  } catch {
    return `Error: cannot read "${absPath}"`
  }

  // Always normalise to LF so the model's oldString round-trips correctly
  // (CRLF files would otherwise cause editFile to fail on first attempt)
  content = content.replace(/\r\n/g, '\n')

  const startLine = input['startLine'] as number | undefined
  const endLine   = input['endLine']   as number | undefined
  if (startLine !== undefined || endLine !== undefined) {
    const lines = content.split('\n')
    const start = Math.max(0, (startLine ?? 1) - 1)
    const end   = endLine ?? lines.length
    content = lines.slice(start, end).join('\n')
  }
  if (content.length > 100_000) {
    content = content.slice(0, 100_000) + '\n…[truncated]'
  }
  return content
}

// ── writeFile ────────────────────────────────────────────────────────────
async function toolWriteFile(input: ToolInput): Promise<string> {
  const absPath = resolvePath(input['path'] as string)
  const content = input['content'] as string
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, content, 'utf-8')
    void vscode.window.showTextDocument(vscode.Uri.file(absPath), {
      preview: true,
      preserveFocus: true,
    })
    return `✓ Written ${absPath} (${content.length} chars)`
  } catch (err) {
    return `Error writing "${absPath}": ${String(err)}`
  }
}

type EditMatchMode = 'exact' | 'trimmed-boundary' | 'line-rtrim' | 'line-dedent'

interface EditApplyResult {
  ok: boolean
  occurrences: number
  mode?: EditMatchMode
  newContent?: string
  error?: string
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}

function trimOuterBlankLines(value: string): string {
  return value
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '')
}

function rtrimSpaces(line: string): string {
  return line.replace(/[ \t]+$/g, '')
}

function commonIndent(lines: string[]): number {
  const nonEmpty = lines.filter(line => line.trim().length > 0)
  if (nonEmpty.length === 0) return 0
  return Math.min(...nonEmpty.map(line => (line.match(/^[ \t]*/)?.[0].length ?? 0)))
}

function stripCommonIndent(lines: string[]): string[] {
  const indent = commonIndent(lines)
  if (indent <= 0) return [...lines]
  return lines.map(line => line.slice(Math.min(indent, line.length)))
}

function firstLineIndent(lines: string[]): string {
  const first = lines.find(line => line.trim().length > 0)
  if (!first) return ''
  return first.match(/^[ \t]*/)?.[0] ?? ''
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function reindentBlock(lines: string[], indent: string): string[] {
  return lines.map(line => line.trim().length === 0 ? '' : indent + line)
}

function buildLineOffsets(lines: string[]): number[] {
  const offsets: number[] = []
  let cursor = 0
  for (const line of lines) {
    offsets.push(cursor)
    cursor += line.length + 1
  }
  return offsets
}

function applyLineRtrimFallback(
  content: string,
  oldNorm: string,
  newNorm: string,
  doReplaceAll: boolean,
): EditApplyResult {
  const oldTrimmed = trimOuterBlankLines(oldNorm)
  const newTrimmed = trimOuterBlankLines(newNorm)
  if (!oldTrimmed.trim()) {
    return { ok: false, occurrences: 0, error: 'Error: oldString must not be empty or whitespace only.' }
  }

  const contentLines = content.split('\n')
  const oldLines = oldTrimmed.split('\n')
  if (oldLines.length === 0 || oldLines.length > contentLines.length) {
    return { ok: false, occurrences: 0, error: 'Error: oldString not found.' }
  }

  const matches: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let matched = true
    for (let j = 0; j < oldLines.length; j++) {
      if (rtrimSpaces(contentLines[i + j]) !== rtrimSpaces(oldLines[j])) {
        matched = false
        break
      }
    }
    if (matched) {
      matches.push({ startLine: i, endLine: i + oldLines.length - 1 })
      i += oldLines.length - 1
    }
  }

  if (matches.length === 0) {
    return {
      ok: false,
      occurrences: 0,
      error: 'Error: oldString not found (even after whitespace-tolerant matching).',
    }
  }

  if (!doReplaceAll && matches.length > 1) {
    return {
      ok: false,
      occurrences: matches.length,
      error: `Error: oldString appears ${matches.length} times (whitespace-tolerant match). Add more context or use replaceAll:true.`,
    }
  }

  const selected = doReplaceAll ? matches : [matches[0]]
  const offsets = buildLineOffsets(contentLines)
  let next = content
  for (const m of selected.slice().reverse()) {
    const start = offsets[m.startLine]
    const end = offsets[m.endLine] + contentLines[m.endLine].length
    next = next.slice(0, start) + newTrimmed + next.slice(end)
  }

  return {
    ok: true,
    occurrences: matches.length,
    mode: 'line-rtrim',
    newContent: next,
  }
}

function applyLineDedentFallback(
  content: string,
  oldNorm: string,
  newNorm: string,
  doReplaceAll: boolean,
): EditApplyResult {
  const oldTrimmed = trimOuterBlankLines(oldNorm)
  const newTrimmed = trimOuterBlankLines(newNorm)
  if (!oldTrimmed.trim()) {
    return { ok: false, occurrences: 0, error: 'Error: oldString must not be empty or whitespace only.' }
  }

  const contentLines = content.split('\n')
  const oldLines = oldTrimmed.split('\n')
  if (oldLines.length === 0 || oldLines.length > contentLines.length) {
    return { ok: false, occurrences: 0, error: 'Error: oldString not found.' }
  }

  const normalOld = stripCommonIndent(oldLines).map(rtrimSpaces)
  const matches: Array<{ startLine: number; endLine: number; indent: string }> = []

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const window = contentLines.slice(i, i + oldLines.length)
    const normalWindow = stripCommonIndent(window).map(rtrimSpaces)
    if (!arraysEqual(normalWindow, normalOld)) continue

    matches.push({
      startLine: i,
      endLine: i + oldLines.length - 1,
      indent: firstLineIndent(window),
    })
    i += oldLines.length - 1
  }

  if (matches.length === 0) {
    return {
      ok: false,
      occurrences: 0,
      error: 'Error: oldString not found (even after indentation-tolerant matching).',
    }
  }

  if (!doReplaceAll && matches.length > 1) {
    return {
      ok: false,
      occurrences: matches.length,
      error: `Error: oldString appears ${matches.length} times (indentation-tolerant match). Add more context or use replaceAll:true.`,
    }
  }

  const selected = doReplaceAll ? matches : [matches[0]]
  const offsets = buildLineOffsets(contentLines)
  const newBaseLines = stripCommonIndent(newTrimmed.split('\n'))
  let next = content

  for (const m of selected.slice().reverse()) {
    const start = offsets[m.startLine]
    const end = offsets[m.endLine] + contentLines[m.endLine].length
    const replacement = reindentBlock(newBaseLines, m.indent).join('\n')
    next = next.slice(0, start) + replacement + next.slice(end)
  }

  return {
    ok: true,
    occurrences: matches.length,
    mode: 'line-dedent',
    newContent: next,
  }
}

function applyEditWithFallback(
  content: string,
  oldNorm: string,
  newNorm: string,
  doReplaceAll: boolean,
): EditApplyResult {
  if (!oldNorm.trim()) {
    return { ok: false, occurrences: 0, error: 'Error: oldString must not be empty or whitespace only.' }
  }

  // 1) Exact match.
  if (content.includes(oldNorm)) {
    const occurrences = countOccurrences(content, oldNorm)
    if (!doReplaceAll && occurrences > 1) {
      return {
        ok: false,
        occurrences,
        error: `Error: oldString appears ${occurrences} times. Include more context or use replaceAll:true.`,
      }
    }
    return {
      ok: true,
      occurrences,
      mode: 'exact',
      newContent: doReplaceAll ? content.split(oldNorm).join(newNorm) : content.replace(oldNorm, newNorm),
    }
  }

  // 2) Boundary-trim fallback: tolerate extra blank lines around snippet.
  const oldTrimmed = trimOuterBlankLines(oldNorm)
  const newTrimmed = trimOuterBlankLines(newNorm)
  if (oldTrimmed !== oldNorm && oldTrimmed.length > 0 && content.includes(oldTrimmed)) {
    const occurrences = countOccurrences(content, oldTrimmed)
    if (!doReplaceAll && occurrences > 1) {
      return {
        ok: false,
        occurrences,
        error: `Error: oldString appears ${occurrences} times after trimming boundary blank lines. Add more context or use replaceAll:true.`,
      }
    }
    return {
      ok: true,
      occurrences,
      mode: 'trimmed-boundary',
      newContent: doReplaceAll ? content.split(oldTrimmed).join(newTrimmed) : content.replace(oldTrimmed, newTrimmed),
    }
  }

  // 3) Line-wise trailing-space-tolerant fallback.
  const rtrimAttempt = applyLineRtrimFallback(content, oldNorm, newNorm, doReplaceAll)
  if (rtrimAttempt.ok || rtrimAttempt.occurrences > 0) return rtrimAttempt

  // 4) Indentation-tolerant fallback for dedented snippets.
  return applyLineDedentFallback(content, oldNorm, newNorm, doReplaceAll)
}

function editNotFoundHint(content: string, oldNorm: string): string {
  const firstMeaningfulLine = oldNorm
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0)

  if (!firstMeaningfulLine) return ''

  const lineHits = content
    .split('\n')
    .filter(line => line.includes(firstMeaningfulLine)).length

  if (lineHits > 0) {
    return `\nHint: the first non-empty oldString line appears ${lineHits} time(s), but surrounding lines differ. Re-read and include 3-5 exact context lines.`
  }
  return '\nHint: no line from oldString was found verbatim. Re-read the file and copy exact text, including punctuation.'
}

// ── editFile ─────────────────────────────────────────────────────────────
// Mirrors raptor's FileEditTool: replaces the FIRST occurrence of oldString with
// newString. Pass replaceAll:true to replace every occurrence (for renames).
// The model must include enough surrounding context to uniquely identify the
// target location (same contract as the CLI tool).
async function toolEditFile(input: ToolInput): Promise<string> {
  const absPath    = resolvePath(input['path'] as string)
  const oldString  = input['oldString'] as string
  const newString  = input['newString'] as string
  const doReplaceAll = (input['replaceAll'] as boolean | undefined) ?? false

  let rawContent: string
  try {
    rawContent = await fs.readFile(absPath, 'utf-8')
  } catch {
    return `Error: cannot read "${absPath}"`
  }

  // ── CRLF normalisation ────────────────────────────────────────────────────
  // Files on Windows often have CRLF line endings but the model always sends LF
  // in oldString/newString. We match against a normalised copy and write back
  // with the file's original line endings preserved.
  const hasCRLF   = rawContent.includes('\r\n')
  const content   = hasCRLF ? rawContent.replace(/\r\n/g, '\n') : rawContent
  const oldNorm   = oldString.replace(/\r\n/g, '\n')
  const newNorm   = newString.replace(/\r\n/g, '\n')

  const applied = applyEditWithFallback(content, oldNorm, newNorm, doReplaceAll)
  if (!applied.ok || !applied.newContent) {
    const baseError = applied.error ?? 'Error: oldString not found.'
    return (
      `${baseError} File: "${absPath}".` +
      `${editNotFoundHint(content, oldNorm)}\n` +
      `Tip: make sure whitespace and indentation match exactly. Use readFile to re-read the file first.`
    )
  }

  const occurrences = applied.occurrences
  let newContent = applied.newContent

  // Restore original line endings if file was CRLF
  if (hasCRLF) newContent = newContent.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')

  try {
    await fs.writeFile(absPath, newContent, 'utf-8')
    void vscode.window.showTextDocument(vscode.Uri.file(absPath), {
      preview: true,
      preserveFocus: true,
    })
    const modeNote = applied.mode && applied.mode !== 'exact' ? ` [${applied.mode}]` : ''
    return doReplaceAll
      ? `✓ Edited ${absPath} (replaced ${occurrences} occurrence${occurrences !== 1 ? 's' : ''})${modeNote}`
      : `✓ Edited ${absPath}${modeNote}`
  } catch (err) {
    return `Error writing "${absPath}": ${String(err)}`
  }
}

// ── multiEdit ────────────────────────────────────────────────────────────
// Batch version of editFile. Applies multiple edits — if any
// oldString is not found the entire batch fails and no files are modified.
// When multiple edits target the SAME file, they are chained: each subsequent
// edit's oldString is matched against the content produced by the prior edit.
// This is critical because the LLM often reads a file once, then sends N edits
// whose oldStrings reflect the progressive state of the file.
interface EditOp {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

async function toolMultiEdit(input: ToolInput): Promise<string> {
  const edits = input['edits'] as EditOp[]
  if (!Array.isArray(edits) || edits.length === 0) {
    return 'Error: edits must be a non-empty array'
  }

  // Phase 1 — group edits by file and validate sequentially within each file.
  // We keep an in-memory "working copy" per file so chained edits see prior changes.
  const fileState = new Map<string, { originalRaw: string; hasCRLF: boolean; content: string }>()
  const prepared: Array<{
    absPath: string
    newContent: string
    occurrences: number
    doAll: boolean
    fallbackModes: EditMatchMode[]
  }> = []

  for (let idx = 0; idx < edits.length; idx++) {
    const edit = edits[idx]
    const absPath = resolvePath(edit.path)
    const doAll   = edit.replaceAll ?? false

    // Read from disk only the first time we encounter this file; subsequent
    // edits to the same file work against the accumulated in-memory state.
    if (!fileState.has(absPath)) {
      let rawContent: string
      try {
        rawContent = await fs.readFile(absPath, 'utf-8')
      } catch {
        return `Error: cannot read "${absPath}" (edit #${idx + 1}) -- batch aborted, no files modified`
      }
      const hasCRLF = rawContent.includes('\r\n')
      const content = hasCRLF ? rawContent.replace(/\r\n/g, '\n') : rawContent
      fileState.set(absPath, { originalRaw: rawContent, hasCRLF, content })
    }
    const state = fileState.get(absPath)!

    // Normalise search strings to LF for matching
    const oldNorm = edit.oldString.replace(/\r\n/g, '\n')
    const newNorm = edit.newString.replace(/\r\n/g, '\n')

    const applied = applyEditWithFallback(state.content, oldNorm, newNorm, doAll)
    if (!applied.ok || !applied.newContent) {
      const preview = state.content.slice(0, 400)
      return (
        `Error applying edit #${idx + 1} in "${absPath}": ${applied.error ?? 'oldString not found'}.\n` +
        `The file content (after applying prior edits in this batch) starts with:\n${preview}\n` +
        `${editNotFoundHint(state.content, oldNorm)}\n` +
        `Batch aborted -- no files modified.\n` +
        `Tip: re-read the file with readFile and include exact context.`
      )
    }

    // Apply edit to the in-memory working copy
    state.content = applied.newContent

    // Restore CRLF for the final write
    let finalContent = state.content
    if (state.hasCRLF) finalContent = finalContent.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')

    const fallbackModes = applied.mode && applied.mode !== 'exact' ? [applied.mode] : []

    // Update (or overwrite) the prepared entry for this file
    const existing = prepared.find(p => p.absPath === absPath)
    if (existing) {
      existing.newContent = finalContent
      existing.occurrences += applied.occurrences
      for (const m of fallbackModes) {
        if (!existing.fallbackModes.includes(m)) existing.fallbackModes.push(m)
      }
    } else {
      prepared.push({
        absPath,
        newContent: finalContent,
        occurrences: applied.occurrences,
        doAll,
        fallbackModes,
      })
    }
  }

  // Phase 2 — commit all writes
  const results: string[] = []
  const writtenPaths: string[] = []
  for (const { absPath, newContent, occurrences, doAll, fallbackModes } of prepared) {
    try {
      await fs.writeFile(absPath, newContent, 'utf-8')
      writtenPaths.push(absPath)
      void vscode.window.showTextDocument(vscode.Uri.file(absPath), {
        preview: true,
        preserveFocus: true,
      })
      const modeNote = fallbackModes.length > 0 ? ` [${fallbackModes.join(', ')}]` : ''
      results.push(
        doAll
          ? `✓ ${absPath} (${occurrences} occurrence${occurrences !== 1 ? 's' : ''} replaced)${modeNote}`
          : `✓ ${absPath}${modeNote}`,
      )
    } catch (err) {
      const rollbackResults: string[] = []
      for (const p of writtenPaths.reverse()) {
        try {
          const original = fileState.get(p)?.originalRaw
          if (original !== undefined) {
            await fs.writeFile(p, original, 'utf-8')
            rollbackResults.push(`↩ rolled back ${p}`)
          } else {
            rollbackResults.push(`⚠ could not find rollback snapshot for ${p}`)
          }
        } catch (rollbackErr) {
          rollbackResults.push(`✗ rollback failed for ${p}: ${String(rollbackErr)}`)
        }
      }

      return [
        `Error: write failed for "${absPath}": ${String(err)}`,
        'Batch aborted. Attempted rollback of previously written files:',
        ...rollbackResults,
      ].join('\n')
    }
  }

  return results.join('\n')
}

// ── listDir ──────────────────────────────────────────────────────────────
async function toolListDir(input: ToolInput): Promise<string> {
  const absPath = resolvePath(input['path'] as string)
  try {
    const entries = await fs.readdir(absPath, { withFileTypes: true })
    const lines = entries
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
    return lines.join('\n') || '(empty directory)'
  } catch (err) {
    return `Error listing "${absPath}": ${String(err)}`
  }
}

// ── glob ─────────────────────────────────────────────────────────────────
async function toolGlob(input: ToolInput): Promise<string> {
  const pattern = input['pattern'] as string
  const exclude = (input['exclude'] as string | undefined) ??
    '{**/node_modules/**,**/dist/**,.git/**}'

  try {
    const uris = await vscode.workspace.findFiles(pattern, exclude, 1000)
    if (uris.length === 0) return 'No files matched.'
    const lines = uris
      .map(u => vscode.workspace.asRelativePath(u))
      .sort()
    const cap = 500
    return lines.slice(0, cap).join('\n') +
      (lines.length > cap ? `\n…and ${lines.length - cap} more` : '')
  } catch (err) {
    return `Error in glob: ${String(err)}`
  }
}

// ── searchCode ───────────────────────────────────────────────────────────
async function toolSearchCode(input: ToolInput): Promise<string> {
  const query         = input['query']         as string
  const glob          = (input['glob']          as string  | undefined) ?? '**/*'
  const isRegex       = (input['isRegex']       as boolean | undefined) ?? false
  const caseSensitive = (input['caseSensitive'] as boolean | undefined) ?? false
  const contextLines  = Math.min((input['contextLines'] as number | undefined) ?? 0, 5)
  const maxResults    = Math.min((input['maxResults']   as number | undefined) ?? 200, 500)

  const uris = await vscode.workspace.findFiles(
    glob,
    '{**/node_modules/**,**/dist/**,.git/**}',
    500,
  )

  const results: string[] = []
  const flags = caseSensitive ? '' : 'i'
  const re = isRegex ? new RegExp(query, flags) : null
  const needle = caseSensitive ? query : query.toLowerCase()

  for (const uri of uris) {
    if (results.length >= maxResults) break
    try {
      const text  = await fs.readFile(uri.fsPath, 'utf-8')
      const lines = text.split('\n')
      const rel   = vscode.workspace.asRelativePath(uri)
      lines.forEach((line, i) => {
        if (results.length >= maxResults) return
        const hit = re
          ? re.test(line)
          : caseSensitive
            ? line.includes(needle)
            : line.toLowerCase().includes(needle)
        if (!hit) return

        // Include context lines before/after the match (like rg -C N)
        if (contextLines > 0) {
          const start = Math.max(0, i - contextLines)
          const end   = Math.min(lines.length - 1, i + contextLines)
          for (let j = start; j <= end; j++) {
            const prefix = j === i ? `${rel}:${j + 1}:` : `${rel}:${j + 1}-`
            results.push(`${prefix} ${lines[j]}`)
          }
          results.push('--')  // separator between matches (like rg)
        } else {
          results.push(`${rel}:${i + 1}: ${line.trim()}`)
        }
      })
    } catch { /* skip unreadable */ }
  }

  if (results.length === 0) return 'No matches found.'
  const overflow = results.length > maxResults
  const out = results.slice(0, maxResults).join('\n')
  return overflow ? out + `\n…results capped at ${maxResults}` : out
}

// ── runTerminal ──────────────────────────────────────────────────────────
// Uses Node.js spawn() directly instead of PowerShell exec() to avoid:
//   - UTF-16 encoding issues (emoji/Unicode coming back as ??)
//   - PowerShell syntax differences (&& vs ;, Out-File quirks)
//   - C:\ root temp file hallucinations (PS profile path issues)
//   - chcp/OutputEncoding boilerplate
//
// On Windows we use cmd.exe /C as the shell — it's simpler, faster, and the
// LLM's commands (git, npm, node, python, etc.) are all PATH-accessible.
// For commands that truly need PowerShell, the user/model can explicitly call
// `powershell -Command "..."`.

function spawnCommand(
  command: string,
  cwd: string,
  timeoutMs: number = 120_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const tempDir = extensionTempDir()

    // Use cmd.exe on Windows, /bin/sh on Unix
    const shell = isWin ? 'cmd.exe' : '/bin/sh'

    // On Windows: always cd /d to the cwd first, so cmd.exe is NEVER on C:\.
    // This is belt-and-suspenders on top of the spawn cwd option.
    const wrappedCmd = isWin ? `cd /d "${cwd}" && ${command}` : command
    const args = isWin ? ['/C', wrappedCmd] : ['-c', command]

    const child = spawn(shell, args, {
      cwd,
      env: {
        ...process.env,
        // Force UTF-8 everywhere
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        NODE_OPTIONS: '--no-warnings',
        // Git: avoid pager, use UTF-8
        GIT_PAGER: '',
        LESSCHARSET: 'utf-8',
        // Keep tool temp output in extension-specific temp dir.
        TEMP: tempDir,
        TMP: tempDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let killed = false

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* */ } }, 2000)
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
      const stderr = Buffer.concat(stderrChunks).toString('utf-8')
      if (killed) {
        resolve({ stdout, stderr: stderr + `\n(process killed after ${timeoutMs / 1000}s timeout)`, exitCode: code ?? 1 })
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 0 })
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function toolRunTerminal(input: ToolInput): Promise<string> {
  const command = input['command'] as string
  const cwd = input['cwd']
    ? resolvePath(input['cwd'] as string)
    : (workspaceRoot() ?? process.cwd())

  logToOutput(`▶ ${command}`, `  cwd: ${cwd}`)

  try {
    const { stdout, stderr, exitCode } = await spawnCommand(command, cwd)

    const parts: string[] = []
    if (stdout.trim()) parts.push(stdout.trim())
    if (stderr.trim()) parts.push(`--- stderr ---\n${stderr.trim()}`)
    if (exitCode !== 0) parts.push(`(exit code: ${exitCode})`)

    const result = parts.join('\n') || '(no output)'

    // Truncate very large outputs
    const maxLen = 100_000
    const truncated = result.length > maxLen
      ? result.slice(0, maxLen) + `\n...[truncated: ${result.length} chars total]`
      : result

    logToOutput(truncated, '─'.repeat(60))
    return truncated
  } catch (err: unknown) {
    const result = `Error running command: ${String(err)}`
    logToOutput(`Command failed: ${command}`, result, '─'.repeat(60))
    return result
  }
}

// ── webFetch ─────────────────────────────────────────────────────────────
async function toolWebFetch(input: ToolInput): Promise<string> {
  const url = input['url'] as string
  try {
    const fetchFn = globalThis.fetch
    if (typeof fetchFn !== 'function') {
      throw new Error('fetch is not available in this environment')
    }
    const res = await fetchFn(url, {
      headers: { 'User-Agent': 'raptor-vscode/0.0.1' },
      signal: AbortSignal.timeout(15_000),
    })
    const text: string = await res.text()
    const stripped = text.replace(/<[^>]+>/g, '').replace(/\s{3,}/g, '\n').trim()
    return stripped.length > 50_000
      ? stripped.slice(0, 50_000) + '\n…[truncated]'
      : stripped
  } catch (err) {
    return `Error fetching "${url}": ${String(err)}`
  }
}

// ── getDiagnostics ───────────────────────────────────────────────────────
// Exposes VS Code's language-service diagnostics (errors + warnings) so the
// agent can verify its edits compiled cleanly — closing the autopilot feedback loop.
async function toolGetDiagnostics(input: ToolInput): Promise<string> {
  const filePath = input['path'] as string | undefined
  const severity = (input['severity'] as string | undefined) ?? 'all'  // 'error'|'warning'|'all'

  let pairs: Array<[vscode.Uri, vscode.Diagnostic[]]>

  if (filePath) {
    const absPath = resolvePath(filePath)
    const uri     = vscode.Uri.file(absPath)
    pairs = [[uri, vscode.languages.getDiagnostics(uri)]]
  } else {
    pairs = vscode.languages.getDiagnostics()
  }

  const lines: string[] = []
  for (const [uri, diags] of pairs) {
    const rel = vscode.workspace.asRelativePath(uri)
    for (const d of diags) {
      const sev = d.severity === vscode.DiagnosticSeverity.Error   ? 'error'
                : d.severity === vscode.DiagnosticSeverity.Warning ? 'warning'
                : d.severity === vscode.DiagnosticSeverity.Information ? 'info'
                : 'hint'
      if (severity !== 'all' && sev !== severity) continue
      const line = d.range.start.line + 1
      const col  = d.range.start.character + 1
      lines.push(`${rel}:${line}:${col} [${sev}] ${d.message}`)
    }
  }

  if (lines.length === 0) return filePath ? `✓ No diagnostics for ${filePath}` : '✓ No diagnostics in workspace'
  return lines.join('\n')
}

// ── lsp ──────────────────────────────────────────────────────────────────
async function toolLsp(input: ToolInput): Promise<string> {
  const action   = input['action'] as string
  const filePath = input['path']   as string | undefined
  const line     = (input['line']  as number | undefined) ?? 1
  const col      = (input['col']   as number | undefined) ?? 1
  const query    = input['query']  as string | undefined

  switch (action) {
    case 'definition':       return lspDefinition(filePath, line, col)
    case 'references':       return lspReferences(filePath, line, col)
    case 'hover':            return lspHover(filePath, line, col)
    case 'symbols':          return lspDocumentSymbols(filePath)
    case 'workspaceSymbols': return lspWorkspaceSymbols(query ?? '')
    case 'implementations':  return lspImplementations(filePath, line, col)
    case 'typeDefinition':   return lspTypeDefinition(filePath, line, col)
    default: return `Error: unknown LSP action "${action}". Use: definition, references, hover, symbols, workspaceSymbols, implementations, typeDefinition`
  }
}

function lspPosition(line: number, col: number): vscode.Position {
  return new vscode.Position(Math.max(0, line - 1), Math.max(0, col - 1))
}

function formatLocations(locs: vscode.Location[] | undefined): string {
  if (!locs?.length) return 'No results found.'
  return locs.map(loc => {
    const rel = vscode.workspace.asRelativePath(loc.uri)
    return `${rel}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
  }).join('\n')
}

async function lspDefinition(filePath: string | undefined, line: number, col: number): Promise<string> {
  if (!filePath) return 'Error: path is required'
  try {
    const locs: vscode.Location[] | undefined = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider', vscode.Uri.file(resolvePath(filePath)), lspPosition(line, col),
    )
    return formatLocations(locs)
  } catch (err) { return `LSP error: ${String(err)}` }
}

async function lspReferences(filePath: string | undefined, line: number, col: number): Promise<string> {
  if (!filePath) return 'Error: path is required'
  try {
    const locs: vscode.Location[] | undefined = await vscode.commands.executeCommand(
      'vscode.executeReferenceProvider', vscode.Uri.file(resolvePath(filePath)), lspPosition(line, col),
    )
    return formatLocations(locs)
  } catch (err) { return `LSP error: ${String(err)}` }
}

async function lspHover(filePath: string | undefined, line: number, col: number): Promise<string> {
  if (!filePath) return 'Error: path is required'
  try {
    const hovers: vscode.Hover[] | undefined = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider', vscode.Uri.file(resolvePath(filePath)), lspPosition(line, col),
    )
    if (!hovers?.length) return 'No hover info.'
    return hovers.map(h => h.contents.map(c =>
      typeof c === 'string' ? c : (c as vscode.MarkdownString).value
    ).join('\n')).join('\n---\n')
  } catch (err) { return `LSP error: ${String(err)}` }
}

async function lspDocumentSymbols(filePath: string | undefined): Promise<string> {
  if (!filePath) return 'Error: path is required'
  try {
    const symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined =
      await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider', vscode.Uri.file(resolvePath(filePath)),
      )
    if (!symbols?.length) return 'No symbols found.'
    return symbols.map((s: any) => {
      const kind = vscode.SymbolKind[s.kind] ?? String(s.kind)
      const line = s.range?.start?.line ?? s.location?.range?.start?.line ?? '?'
      return `${kind} ${s.name} :${Number(line) + 1}`
    }).join('\n')
  } catch (err) { return `LSP error: ${String(err)}` }
}

async function lspWorkspaceSymbols(query: string): Promise<string> {
  try {
    const symbols: vscode.SymbolInformation[] | undefined =
      await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)
    if (!symbols?.length) return `No workspace symbols matching "${query}".`
    return symbols.slice(0, 50).map(s => {
      const rel = vscode.workspace.asRelativePath(s.location.uri)
      const line = s.location.range.start.line + 1
      return `${vscode.SymbolKind[s.kind]} ${s.name} ${rel}:${line}`
    }).join('\n')
  } catch (err) { return `LSP error: ${String(err)}` }
}

async function lspImplementations(filePath: string | undefined, line: number, col: number): Promise<string> {
  if (!filePath) return 'Error: path is required'
  try {
    const locs: vscode.Location[] | undefined = await vscode.commands.executeCommand(
      'vscode.executeImplementationProvider', vscode.Uri.file(resolvePath(filePath)), lspPosition(line, col),
    )
    return formatLocations(locs)
  } catch (err) { return `LSP error: ${String(err)}` }
}

async function lspTypeDefinition(filePath: string | undefined, line: number, col: number): Promise<string> {
  if (!filePath) return 'Error: path is required'
  try {
    const locs: vscode.Location[] | undefined = await vscode.commands.executeCommand(
      'vscode.executeTypeDefinitionProvider', vscode.Uri.file(resolvePath(filePath)), lspPosition(line, col),
    )
    return formatLocations(locs)
  } catch (err) { return `LSP error: ${String(err)}` }
}

// ── spawnAgent ───────────────────────────────────────────────────────────
// Intentionally excludes persistence, network, and nested-agent tools by default.
// See SUB_AGENT_DEFAULT_TOOLS_NOTE in src/tools/catalog.ts for the policy baseline.
async function toolSpawnAgent(input: ToolInput): Promise<string> {
  const task         = input['task']  as string
  const toolsAllowed = (input['tools'] as string[] | undefined) ?? SUB_AGENT_DEFAULT_TOOLS
  const maxIter      = Math.min((input['maxIterations'] as number | undefined) ?? 20, getConfig().spawnAgentMaxIterations)

  if (!task?.trim()) return 'Error: task is required'

  const loaded = await getLoadedConfig()
  const activeAgent = loaded.agents.get('_default')!
  const allToolNames = getToolDefs().map(t => t.name)
  const agentAllowed = filterToolsByAgent(allToolNames, activeAgent.tools)
  const effectiveTools = toolsAllowed.filter(t => agentAllowed.includes(t))

  let resolved: ResolvedModel
  try {
    resolved = await getRegistry().resolve({ agentModel: activeAgent.model })
  } catch (err) {
    return 'Error: no model available for sub-agent'
  }

  const subSystemPrompt = [
    `You are a sub-agent spawned to complete a specific scoped task.`,
    `Workspace root: ${workspaceRoot() ?? '(none)'}   Platform: ${process.platform}`,
    ``, `## Your Task`, task, ``,
    `## Rules`,
    `1. Complete ONLY the task above. Do not expand scope.`,
    `2. Use tools autonomously -- do not ask for permission.`,
    `3. Always read files before editing them.`,
    `4. When done, provide a brief completion summary starting with "DONE: ".`,
    `5. If you cannot complete the task, explain why starting with "BLOCKED: ".`,
  ].join('\n')

  const subMessages: RaptorMessage[] = [
    { role: 'system', content: [{ type: 'text', value: subSystemPrompt }] },
    { role: 'user', content: [{ type: 'text', value: 'Begin the task now.' }] },
  ]

  const subTools = getToolDefs().filter((tool: vscode.LanguageModelChatTool) => effectiveTools.includes(tool.name))

  logToOutput(`[sub-agent] spawned for: ${task.slice(0, 100)}`)

  let iteration = 0
  let finalText = ''

  while (iteration < maxIter) {
    iteration++
    let responseStream: AsyncIterable<RaptorResponseEvent>
    try {
      responseStream = await resolved.provider.sendRequest(
        resolved.model,
        subMessages,
        { tools: subTools },
        new vscode.CancellationTokenSource().token,
      )
    } catch (err) { return `Sub-agent model error: ${String(err)}` }

    const textParts: RaptorTextPart[] = []
    const toolCalls: RaptorToolCallPart[] = []

    for await (const part of responseStream) {
      if (part.type === 'text') textParts.push({ type: 'text', value: part.value })
      else if (part.type === 'tool_call') toolCalls.push({ type: 'tool_call', callId: part.callId, name: part.name, input: part.input })
    }

    finalText = textParts.map(p => p.value).join('')
    if (toolCalls.length === 0) break

    appendToolResult(subMessages, textParts, toolCalls)

    const results = await executeToolCallsInOrder(toolCalls)
    for (const { toolCall, result } of results) {
      appendToolResultToMessages(subMessages, toolCall.callId, result)
    }
  }

  logToOutput(`[sub-agent] completed after ${iteration} iterations`)
  const summary = finalText.trim() || '(sub-agent completed with no final text)'
  return summary.length > 8000 ? summary.slice(0, 8000) + '\n...[truncated]' : summary
}

// ─── Chat participant ──────────────────────────────────────────────────────────

function createFlowFollowupProvider(): vscode.ChatFollowupProvider {
  return {
    async provideFollowups(
      _result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken,
    ): Promise<vscode.ChatFollowup[]> {
      const loaded = await getLoadedConfig()
      const flows = Array.from(loaded.flows.values())
      if (flows.length === 0) {
        return []
      }
      return flows.map(f => ({
        prompt: `/flow ${f.id}`,
        label: `Run ${f.name ?? f.id} flow`,
      }))
    },
  }
}

function registerChatParticipant(context: vscode.ExtensionContext): void {
  registerChatParticipantModule(context, handleChatRequest, createFlowFollowupProvider())
}

async function handleChatRequest(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  // Pin request.model so the vscode provider uses it directly in sendRequest.
  // Copilot only allows request.model to produce responses in a handler invocation;
  // models found via selectChatModels() silently return 0 chars.
  setVSCodeSessionModel(request.model)

  const config = getConfig()
  const promptTrimmed = request.prompt.trim()

  // ── Slash commands ─────────────────────────────────────────────────────────

  if (request.command === 'help' || promptTrimmed === '/help') {
    stream.markdown(buildHelpMarkdown())
    return {}
  }

  if (
    request.command === 'memory' ||
    request.command === 'resume' ||
    request.command === 'todos' ||
    request.command === 'clearmemory' ||
    request.command === 'steer' ||
    /^\/(?:memory|resume|todos|clearmemory|steer)\b/.test(promptTrimmed)
  ) {
    stream.markdown('This legacy command has been removed. Use `/help` for the current orchestration commands.')
    return {}
  }

  // ── Load config (agents, skills, flows) ───────────────────────────────────
  const loaded = await getLoadedConfig()
  for (const w of loaded.warnings) {
    logToOutput(`[config] ${w}`)
  }
  if (loaded.sources.length > 0) {
    logToOutput(`[config] Loaded from: ${loaded.sources.join(', ')}`)
    logToOutput(`[config] Agents: ${Array.from(loaded.agents.keys()).join(', ')}`)
    logToOutput(`[config] Skills: ${Array.from(loaded.skills.keys()).join(', ')}`)
    logToOutput(`[config] Flows: ${Array.from(loaded.flows.keys()).join(', ')}`)
  }

  let requestScope: RequestScope | undefined

  if (request.command === 'skills' || promptTrimmed === '/skills') {
    const skills = Array.from(loaded.skills.values())
    if (skills.length === 0) {
      stream.markdown('## Skills\n\nNo skills are loaded in this workspace yet.')
      return {}
    }

    const rows = skills.map(skill => `| \`${skill.id}\` | ${skill.source} |`)
    stream.markdown([
      '## Skills',
      '',
      '| ID | Source |',
      '|---|---|',
      ...rows,
      '',
      'Use a skill by attaching it to an agent or installing it as a normal markdown skill pack.',
    ].join('\n'))
    return {}
  }

  // ── /agents — list loaded agents ──────────────────────────────────────────
  if (request.command === 'agents' || promptTrimmed === '/agents') {
    const rows = Array.from(loaded.agents.values()).map(a => {
      const tools = a.tools === null ? 'all' : (a.tools?.join(', ') ?? 'all')
      return `| \`${a.id}\` | ${a.name ?? a.id} | ${a.description ?? '-'} | ${a.model ?? '-'} | ${tools} | ${a.source ?? '-'} |`
    })
    stream.markdown([
      '## Agents',
      '',
      '| ID | Name | Description | Model | Tools | Source |',
      '|---|---|---|---|---|---|',
      ...rows,
      '',
      'Use `/agent <id>` to inspect an agent, or `/agent <id> <task...>` to run a request-scoped task with it.',
      loaded.imports.length > 0
        ? `Imported configs detected but quarantined: ${loaded.imports.map(imported => `${imported.origin} (${imported.agents.length} agent${imported.agents.length === 1 ? '' : 's'})`).join(', ')}.`
        : '',
    ].join('\n'))
    return {}
  }

  // ── /agent <id> — inspect or run one-off task ────────────────────────────
  if (request.command === 'agent' || promptTrimmed.startsWith('/agent ')) {
    const agentArgs = getCommandArgs(promptTrimmed, 'agent')
    const [agentId, ...rest] = agentArgs.split(/\s+/)
    if (!agentId) {
      stream.markdown('Usage: `/agent <id>` to inspect a loaded agent, or `/agent <id> <task...>` to run a request-scoped task. Use `/agents` to list.')
      return {}
    }
    const agent = loaded.agents.get(agentId)
    if (!agent) {
      stream.markdown(`Agent "${agentId}" not found. Use \`/agents\` to list available agents.`)
      return {}
    }
    const task = rest.join(' ').trim()
    if (!task) {
      const tools = agent.tools === null ? 'all' : (agent.tools?.join(', ') ?? 'all')
      stream.markdown([
        `## Agent: ${agent.name ?? agent.id}`,
        '',
        `**ID:** \`${agent.id}\``,
        `**Description:** ${agent.description ?? '-'} `,
        `**Model:** ${agent.model ?? '(workspace/session default)'}`,
        `**Tools:** ${tools}`,
        `**Source:** ${agent.source ?? '-'}`,
        '',
        'Run a request-scoped task with `/agent <id> <task...>`.',
      ].join('\n'))
      return {}
    }
    requestScope = { agentId: agent.id, task, isExplicitAgentRequest: true }
    stream.markdown(`Running **${agent.name ?? agent.id}** for this turn only.\n\n`)
  }

  // ── /flows — list loaded flows ────────────────────────────────────────────
  if (request.command === 'flows' || promptTrimmed === '/flows') {
    const rows = Array.from(loaded.flows.values()).map(f => {
      const steps = f.steps.map((s, i) => `${i + 1}. ${s.agent}: ${s.instruction.slice(0, 60)}${s.instruction.length > 60 ? '…' : ''}`).join('\n')
      return `| \`${f.id}\` | ${f.name ?? f.id} | ${f.description ?? '-'} | ${f.steps.length} |`
    })
    stream.markdown([
      '## Flows',
      '',
      '| ID | Name | Description | Steps |',
      '|---|---|---|---|',
      ...rows,
      '',
      'Use `/flow <id>` to run a flow.',
    ].join('\n'))
    return {}
  }

  if (request.command === 'models' || promptTrimmed === '/models') {
    const registry = getRegistry()
    const providers = registry.listProviders()
    const rows: string[] = []
    for (const p of providers) {
      const providerStatus = p.getStatus ? await p.getStatus().catch(() => ({ available: false, reason: 'status check failed' })) : null
      const models = await p.listModels().catch(() => [])
      const available = providerStatus ? providerStatus.available : models.length > 0
      const statusIcon = available ? '✓' : '✗'
      const modelList = models
        .map(m => m.maxInputTokens ? `${m.id} (${m.maxInputTokens.toLocaleString()} ctx)` : m.id)
        .join(', ') || (providerStatus && !providerStatus.available && providerStatus.reason ? `(${providerStatus.reason})` : '(no models)')
      rows.push(`| \`${p.id}\` | ${p.name} | ${p.capability} | ${statusIcon} | ${modelList} |`)
    }
    stream.markdown([
      '## Available Providers',
      '',
      '| ID | Name | Capability | Status | Models / Reason |',
      '|---|---|---|---|---|',
      ...rows,
      '',
      'Capabilities: `native-tools` = full tool loop, `native-text` = text only, `delegated` = CLI subprocess, `unavailable` = not configured.',
      'Use provider-qualified model specs like `vscode:copilot-gpt-4`, `claude-code:sonnet`, `codex:gpt-5.3-codex`, `opencode:default`.',
    ].join('\n'))
    return {}
  }

  if (request.command === 'flow' || promptTrimmed.startsWith('/flow ')) {
    const flowArgs = getCommandArgs(promptTrimmed, 'flow')
    const flowParts = flowArgs.split(/\s+/).filter(Boolean)
    const flowId = flowParts[0] ?? ''
    const doResume = flowParts.includes('--resume')
    const doMemory = flowParts.includes('--memory')

    // /flow --list — show all saved flow states
    if (flowId === '--list') {
      const states = await listFlowCheckpoints()
      if (states.length === 0) {
        stream.markdown('No saved flow states. States are saved automatically when a flow is interrupted.')
      } else {
        const rows = states.map(s => {
          const progress = `${s.completedSteps} step${s.completedSteps === 1 ? '' : 's'} done`
          const note = s.failureReason ? ` — ${s.failureReason}` : ''
          return `| \`${s.flowId}\` | ${s.status} | ${progress} | ${new Date(s.updatedAt).toLocaleString()} |${note}`
        })
        stream.markdown([
          '## Saved flow states',
          '',
          '| Flow | Status | Progress | Last updated | Notes |',
          '|---|---|---|---|---|',
          ...rows,
          '',
          'Resume incomplete flows with `/flow <id> --resume`. View checkpoint details with `/flow <id> --memory`.',
        ].join('\n'))
      }
      return {}
    }

    if (!flowId) {
      const flows = Array.from(loaded.flows.values())
      if (flows.length === 0) {
        stream.markdown('No flows loaded. Define flows in `~/.raptor/flows.yaml` or a workspace `.raptor/` directory.')
        return {}
      }
      const rows = flows.map(f => {
        const stepsPreview = f.steps.map((s, i) => `${i + 1}. ${s.agent}`).join(' → ')
        return `| \`${f.id}\` | ${f.name ?? f.id} | ${f.description ?? '-'} | ${f.steps.length} | ${stepsPreview} |`
      })
      stream.markdown([
        '## Available Flows',
        '',
        '| ID | Name | Description | Steps | Pipeline |',
        '|---|---|---|---|---|',
        ...rows,
        '',
        'Click a follow-up button below or type `/flow <id>` to run one.',
      ].join('\n'))
      return {}
    }

    // /flow <id> --memory — show persisted summary for this flow
    if (doMemory) {
      const saved = await loadLatestFlowCheckpoint(flowId)
      if (!saved) {
        stream.markdown(`No saved state for flow \`${flowId}\`.`)
      } else {
        stream.markdown([
          `## Flow memory: \`${saved.flowId}\``,
          '',
          `**Run ID:** ${saved.runId}`,
          `**Status:** ${saved.status}`,
          `**Progress:** ${saved.completedSteps} steps completed`,
          `**Fingerprint:** \`${saved.configFingerprint}\``,
          `**Started:** ${new Date(saved.startedAt).toLocaleString()}`,
          `**Updated:** ${new Date(saved.updatedAt).toLocaleString()}`,
          '',
          '### Step summaries',
          '',
          saved.stepSummary || '_(no summary)_',
          '',
          '### Artifacts',
          '',
          ...saved.steps.map(step => `- Step ${step.index + 1}: \`${step.artifactPath}\` (${step.status})`),
        ].join('\n'))
      }
      return {}
    }

    const flow = loaded.flows.get(flowId)
    if (!flow) {
      stream.markdown(`Flow "${flowId}" not found. Use \`/flows\` to list available flows.`)
      return {}
    }
    const preflight = await preflightFlow(flow, loaded)
    const saved = doResume ? await loadLatestFlowCheckpoint(flow.id) : null
    if (doResume) {
      if (!saved) {
        stream.markdown(`No incomplete saved state for flow "${flow.id}". Run \`/flow ${flow.id}\` to start fresh.`)
        return {}
      }
      if (saved.status === 'completed' || saved.completedSteps >= flow.steps.length) {
        stream.markdown([
          `Flow **${flow.name ?? flow.id}** already completed (${saved.completedSteps}/${flow.steps.length} steps).`,
          '',
          `Run \`/flow ${flow.id} --memory\` to inspect the saved checkpoint, or run \`/flow ${flow.id}\` to start a fresh execution.`,
        ].join('\n'))
        return {}
      }
      if (saved.configFingerprint !== preflight.configFingerprint) {
        stream.markdown([
          `Saved checkpoint for flow **${flow.name ?? flow.id}** is stale after config changes.`,
          '',
          `Run \`/flow ${flow.id}\` to start a fresh execution instead of resuming an old fingerprint.`,
        ].join('\n'))
        return {}
      }
      stream.markdown(`> ↩ Resuming **${flow.name ?? flow.id}** from step ${saved.completedSteps + 1} (${flow.steps.length - saved.completedSteps} remaining)\n\n`)
    }
    await runDeterministicFlow(flow, loaded, request, chatContext, stream, token, {
      preflight,
      resumeState: saved ?? undefined,
      originalPrompt: request.prompt,
    })
    return {}
  }

  const effectiveAgent = requestScope
    ? loaded.agents.get(requestScope.agentId) ?? loaded.agents.get('_default')!
    : loaded.agents.get('_default')!
  const effectivePrompt = requestScope?.task?.trim() ? requestScope.task.trim() : request.prompt
  const effectiveRequest = effectivePrompt === request.prompt
    ? request
    : ({ ...request, prompt: effectivePrompt } as vscode.ChatRequest)

  let resolved: ResolvedModel
  try {
    resolved = await getRegistry().resolve({
      agentModel: effectiveAgent.model,
      fallbackModel: getConfiguredFallbackModel(),
    })
  } catch (err) {
    const errMsg = err instanceof ProviderError ? err.message : String(err)
    stream.markdown(`No chat model available: ${errMsg}\n\nInstall/configure a supported provider (VS Code, Claude Code, Codex, or OpenCode) and sign in if required.`)
    return {}
  }

  const messages = await buildMessages(chatContext, effectiveRequest, effectiveAgent, loaded)
  if (request.command === 'build-flow') {
    injectBuildFlowCommand(messages, effectivePrompt)
  }
  const allToolNames = getToolDefs().map(t => t.name)
  const allowedToolNames = filterToolsByAgent(allToolNames, effectiveAgent.tools)
  const requestedTools = getToolDefs().filter(t => allowedToolNames.includes(t.name))
  const tools = resolved.provider.supportsTools(resolved.model) ? requestedTools : []

  const availabilityNote = `${resolved.available.length} model${resolved.available.length === 1 ? '' : 's'} detected`
  const capNote = tools.length === 0 ? ' (text-only provider)' : ''
  stream.progress(`raptor -> ${resolved.model.name} (${resolved.source}; ${availabilityNote}${contextWindowNote(resolved.model)}${capNote})`)

  const MAX_ITERATIONS = config.maxIterations
  let iteration = 0
  let totalToolCalls = 0
  let fullAssistantText = ''

  while (iteration < MAX_ITERATIONS) {
    if (token.isCancellationRequested) break
    iteration++

    const tokenCount = estimateTokens(messages)
    const thresholds = compactThresholdsForModel(resolved.model)
    if (tokenCount > thresholds.full) {
      stream.progress(`Context full (${tokenCount.toLocaleString()} tokens) -- compacting...`)
      const compacted = await fullCompactMessages(messages, resolved, token)
      messages.length = 0
      messages.push(...compacted)
    } else if (tokenCount > thresholds.micro) {
      const compacted = microCompactMessages(messages)
      messages.length = 0
      messages.push(...compacted)
    }

    let responseStream: AsyncIterable<RaptorResponseEvent>
    try {
      responseStream = await resolved.provider.sendRequest(
        resolved.model, messages, { tools }, token,
      )
    } catch (err) {
      const errMsg = err instanceof ProviderError ? err.message : String(err)
      stream.markdown(`\nModel error: ${errMsg}`)
      return {}
    }

    const textParts: RaptorTextPart[] = []
    const toolCalls: RaptorToolCallPart[] = []

    for await (const part of responseStream) {
      if (token.isCancellationRequested) break
      if (part.type === 'text') {
        textParts.push({ type: 'text', value: part.value })
        stream.markdown(part.value)
      } else if (part.type === 'tool_call') {
        toolCalls.push({ type: 'tool_call', callId: part.callId, name: part.name, input: part.input })
      }
    }

    fullAssistantText += textParts.map(p => p.value).join('')

    if (token.isCancellationRequested) break
    if (toolCalls.length === 0) break

    appendToolResult(messages, textParts, toolCalls)

    totalToolCalls += toolCalls.length

    const callSummary = toolCalls.map(c => `${c.name}(${summariseInput(c.input)})`).join(', ')
    stream.progress(`[iter ${iteration}] ${callSummary}`)

    const results = await executeToolCallsInOrder(toolCalls, token)
    for (const { toolCall, result } of results) {
      renderToolResultDropdown(stream, toolCall, result)
      logToolCallToOutput(toolCall.name, toolCall.input as Record<string, unknown>, result)

      appendToolResultToMessages(messages, toolCall.callId, result)
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    stream.markdown(
      `\n\nReached maximum iterations (${MAX_ITERATIONS}). ` +
      `Task may be incomplete. Total tool calls: ${totalToolCalls}.`,
    )
  }

  return {}
}

// ─── Tool result rendering (compact one-liners) ───────────────────────────────

/**
 * Render a tool call result as a compact one-line summary in the chat.
 *
 * VS Code chat markdown does NOT support <details>/<summary> HTML — those tags
 * get stripped and the full content floods the chat.  Instead we render:
 *
 *   ✅ **editFile** `src/foo.ts`: ✓ Edited src/foo.ts
 *   📄 **runTerminal** `git status`: 3 files changed … (6 lines)
 *   📄 **readFile** `src/foo.ts`: 142 lines read
 *
 * The full result still goes to the LLM — only the *display* is compact.
 */
// ─── Messages ─────────────────────────────────────────────────────────────────

function inferActiveAgent(_chatContext: vscode.ChatContext): string {
  return '_default'
}

function inferActiveModel(_chatContext: vscode.ChatContext): string | undefined {
  return undefined
}

async function buildMessages(
  chatContext: vscode.ChatContext,
  request: vscode.ChatRequest,
  activeAgent: Agent,
  loaded: LoadedConfig,
): Promise<RaptorMessage[]> {
  const promptParts: string[] = []

  if (activeAgent.prompt?.trim()) {
    promptParts.push(`\n\n# Agent Instructions\nYou are acting as the "${activeAgent.name ?? activeAgent.id}" agent.\n\n${activeAgent.prompt.trim()}`)
  }
  const skillIds = activeAgent.skills ?? []
  if (skillIds.length > 0) {
    const skillText = getSkillContent(loaded.skills, skillIds)
    if (skillText.trim()) {
      promptParts.push(`\n\n# Skills\n${skillText}`)
    }
  }

  const root = workspaceRoot() ?? '(no workspace)'
  const promptEditor = vscode.window.activeTextEditor
  const editorContext = promptEditor
    ? `Active file: ${promptEditor.document.fileName}  Language: ${promptEditor.document.languageId}`
    : 'No file open'

  const messages: RaptorMessage[] = [
    {
      role: 'system',
      content: [{ type: 'text', value: buildSystemPrompt({
        root,
        editorContext,
        today: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        isWindows: process.platform === 'win32',
        platform: process.platform,
        shell: process.platform === 'win32'
          ? 'cmd.exe (Windows). Use standard CMD syntax: && to chain, & for parallel, | for pipe. For PowerShell-specific commands, use: powershell -Command "..."'
        : process.env.SHELL ?? 'unknown',
        dataDir: raptorDataDir(),
        tempDir: extensionTempDir(),
      }) + promptParts.join('') }],
    },
  ]

  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push({ role: 'user', content: [{ type: 'text', value: turn.prompt }] })
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = (turn.response as vscode.ChatResponsePart[])
        .filter((p): p is vscode.ChatResponseMarkdownPart =>
          p instanceof vscode.ChatResponseMarkdownPart)
        .map(p => p.value.value)
        .join('')
      if (text) messages.push({ role: 'assistant', content: [{ type: 'text', value: text }] })
    }
  }

  // Build user message — inject active editor context + any @-mentioned references
  const activeEditor = vscode.window.activeTextEditor
  let userContent = request.prompt

  // Auto-attach active editor selection if non-empty
  if (activeEditor && !activeEditor.selection.isEmpty) {
    const sel = activeEditor.document.getText(activeEditor.selection)
    const startLine = activeEditor.selection.start.line + 1
    const endLine   = activeEditor.selection.end.line + 1
    userContent +=
      `\n\n[Active selection in ${activeEditor.document.fileName} (lines ${startLine}-${endLine}):\n` +
      '```' + activeEditor.document.languageId + '\n' + sel + '\n```]'
  }

  // Attach any explicitly @-mentioned or dragged-in references
  for (const ref of request.references) {
    if (ref.value instanceof vscode.Uri) {
      userContent += `\n\n[Context file: ${ref.value.fsPath}]`
    } else if (ref.value instanceof vscode.Location) {
      userContent += `\n\n[Context selection: ${ref.value.uri.fsPath}]`
    }
  }

  messages.push({ role: 'user', content: [{ type: 'text', value: userContent }] })
  return messages
}

// ─── Commands ──────────────────────────────────────────────────────────────────

function injectBuildFlowCommand(messages: RaptorMessage[], userPrompt: string): void {
  const goal = userPrompt.trim()
  const instruction = [
    '',
    '[COMMAND: /build-flow]',
    'Follow the agent-flow-builder skill process now.',
    'Use `.raptor/agents/*.md` plus `.raptor/flows.yaml` as the canonical workspace config, with `~/.raptor/agents/*.md` and `~/.raptor/flows.yaml` as the global fallback.',
    'Do not prefer `.json` config files unless you are explicitly migrating a missing YAML/Markdown setup.',
    goal
      ? `Treat this request as the workflow goal: ${goal}`
      : 'No extra details were provided, so use sensible defaults for any omitted model, tools, or step settings and then ask the Phase 2 interview questions.',
    'Do not require flags to proceed. If the user omitted model or tool scope, infer reasonable defaults and explain them in the draft.',
    'Then continue to Phase 2 and interview the user in one message.',
  ].join('\n')

  const last = messages[messages.length - 1]
  const textPart = last?.role === 'user'
    ? last.content.find((part): part is RaptorTextPart => part.type === 'text')
    : undefined

  if (textPart) {
    textPart.value = `${textPart.value.trimEnd()}\n\n${instruction}`
    return
  }

  messages.push({ role: 'user', content: [{ type: 'text', value: instruction.trimStart() }] })
}

function registerCommands(context: vscode.ExtensionContext): void {
  registerCommandsModule(context)
}

// ─── Flow runner ───────────────────────────────────────────────────────────────

const localModelQueue = new Map<string, Promise<unknown>>()

async function acquireLocalModel(model: RaptorModel): Promise<() => void> {
  const isLocal = /local/i.test(model.id) || /local/i.test(model.name)
  if (!isLocal) return () => {}

  const key = model.id
  const previous = localModelQueue.get(key) ?? Promise.resolve()
  let release = () => {}
  const next = new Promise<void>((resolve) => {
    release = () => {
      localModelQueue.delete(key)
      resolve()
    }
  })
  localModelQueue.set(key, previous.then(() => next))
  await previous
  return release
}

function normalizeModelToken(value: string): string {
  return value.trim().toLowerCase()
}

// ─── Flow state persistence ────────────────────────────────────────────────────

interface FlowState {
  flowId: string
  status?: 'running' | 'completed'
  completedSteps: number
  stepSummary: string
  originalPrompt?: string
  startedAt: string
  updatedAt: string
}

function flowStateDir(): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const base = ws ? path.join(ws, '.raptor') : raptorDataDir()
  return path.join(base, 'flow-state')
}

function flowStatePath(flowId: string): string {
  return path.join(flowStateDir(), `${flowId}.json`)
}

async function saveFlowState(state: FlowState): Promise<void> {
  try {
    await fs.mkdir(flowStateDir(), { recursive: true })
    await fs.writeFile(flowStatePath(state.flowId), JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    logToOutput(`[flow-state] Failed to save flow state for "${state.flowId}": ${String(err)}`)
  }
}

async function loadFlowState(flowId: string): Promise<FlowState | null> {
  try {
    const raw = await fs.readFile(flowStatePath(flowId), 'utf-8')
    return JSON.parse(raw) as FlowState
  } catch { return null }
}

async function listFlowStates(): Promise<FlowState[]> {
  try {
    const dir = flowStateDir()
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'))
    const states: FlowState[] = []
    for (const f of files) {
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8')
        states.push(JSON.parse(raw) as FlowState)
      } catch { /* skip malformed */ }
    }
    return states
  } catch { return [] }
}

interface FlowRunOptions {
  allowModelChanges?: boolean
  keepCurrentModel?: boolean
  useChat?: boolean
  chatModel?: string
  currentModelSpec?: string
  resumeFromStep?: number
  resumedSummary?: string
  originalPrompt?: string
}

function flowStepModelSpec(step: Flow['steps'][number], loaded: LoadedConfig, currentModelSpec: string | undefined): string {
  const agent = loaded.agents.get(step.agent) ?? loaded.agents.get('_default')
  return step.model ?? agent?.model ?? currentModelSpec ?? getConfiguredFallbackModel()
}

function collectFlowModelChanges(flow: Flow, loaded: LoadedConfig, currentModelSpec: string | undefined): Array<{ step: number; agent: string; from: string; to: string }> {
  const changes: Array<{ step: number; agent: string; from: string; to: string }> = []
  let previous = currentModelSpec ?? getConfiguredFallbackModel()
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i]
    const next = flowStepModelSpec(step, loaded, currentModelSpec)
    if (normalizeModelToken(next) !== normalizeModelToken(previous)) {
      changes.push({ step: i + 1, agent: step.agent, from: previous, to: next })
    }
    previous = next
  }
  return changes
}

function isFlowCommandPrompt(value: string): boolean {
  return /^\/?flow(?:\s|$)/i.test(value.trim())
}

function toolCapabilityError(providerId: string, modelId: string, toolCount: number): string {
  return [
    `Provider/model \`${providerId}:${modelId}\` cannot receive Raptor tools but this step requires ${toolCount} tool${toolCount === 1 ? '' : 's'}.`,
    'Use a tool-capable provider, run without `--chat`/with `--accept-models`, or remove tools from this step.',
  ].join(' ')
}

function looksLikeHallucinatedToolExecution(text: string): boolean {
  const toolNames = getToolDefs().map(tool => tool.name).join('|')
  const toolNamePattern = new RegExp(`(?:${toolNames})`, 'i')
  if (!toolNamePattern.test(text)) return false

  const fakeResultPatterns = [
    new RegExp(`(?:^|\\n)\\s*(?:✅|✓|📄|🔧)\\s*(?:${toolNames})\\b`, 'i'),
    new RegExp(`(?:^|\\n)\\s*(?:📄|✅|✓)\\s*(?:readFile|writeFile|editFile|multiEdit|glob|searchCode)\\s+[^\\n]+:\\s*(?:✓|\\d+|[\\w-]+\\s+lines)`, 'i'),
    /\bPlan Created\b[\s\S]*\bPath:\s*\.plans\//i,
    /\b(?:Applied \d+ edits|Saved \d+ todos|No diagnostics|lines read|matches found)\b/i,
  ]
  return fakeResultPatterns.some(pattern => pattern.test(text))
}

function stepRequiresPlanArtifact(step: Flow['steps'][number], agent: Agent): boolean {
  const skills = [...(agent.skills ?? []), ...(step.skills ?? [])]
    .map(skill => skill.toLowerCase())
  if (skills.includes('plan-small') || skills.includes('plan-large')) return true

  const identity = [
    step.agent,
    agent.id,
    agent.name ?? '',
    step.instruction,
  ].join(' ').toLowerCase()

  return /\bplanner\b/.test(identity) || /\bplan-(?:small|large)\b/.test(identity)
}

async function newestPlanFileSince(startedAtMs: number): Promise<string | null> {
  const root = workspaceRoot()
  if (!root) return null
  const plansDir = path.join(root, '.plans')

  async function walk(dir: string): Promise<string[]> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }

    const files: string[] = []
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...await walk(entryPath))
      } else if (entry.isFile() && entry.name.toLowerCase() === 'plan.md') {
        files.push(entryPath)
      }
    }
    return files
  }

  const candidates: Array<{ filePath: string; mtimeMs: number }> = []
  for (const filePath of await walk(plansDir)) {
    try {
      const stat = await fs.stat(filePath)
      if (stat.mtimeMs >= startedAtMs - 1000) candidates.push({ filePath, mtimeMs: stat.mtimeMs })
    } catch { /* ignore */ }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.filePath ?? null
}

async function runFlow(
  flow: Flow,
  loaded: LoadedConfig,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  options: FlowRunOptions = {},
): Promise<void> {
  const startedAt = new Date().toISOString()
  const resumeFrom = options.resumeFromStep ?? 0

  if (resumeFrom === 0) {
    stream.markdown(`**Starting flow: ${flow.name ?? flow.id}** (${flow.steps.length} steps)\n\n`)
    logToOutput(`[flow] Starting "${flow.id}" with ${flow.steps.length} steps`)
  } else {
    stream.markdown(`**Resuming flow: ${flow.name ?? flow.id}** from step ${resumeFrom + 1}/${flow.steps.length}\n\n`)
    logToOutput(`[flow] Resuming "${flow.id}" from step ${resumeFrom + 1}`)
  }

  let stepSummary = options.resumedSummary ?? ''
  const originalPromptContext = options.originalPrompt?.trim()
  const shouldAttachOriginalPrompt = !!originalPromptContext && !isFlowCommandPrompt(originalPromptContext)
  let chatModel: vscode.LanguageModelChat | undefined = request.model
  if (options.useChat && options.chatModel) {
    const allModels = await vscode.lm.selectChatModels()
    const found = allModels.find(m => m.id === options.chatModel || m.id.includes(options.chatModel!))
    if (!found) {
      stream.markdown(`\n❌ Model \`${options.chatModel}\` not found. Available: ${allModels.map(m => `\`${m.id}\``).join(', ')}\n`)
      return
    }
    chatModel = found
  }
  if (options.useChat && !chatModel) {
    stream.markdown(`\n❌ No current chat model was provided by VS Code for \`--chat\`. Select a model in the chat picker and retry \`/flow ${flow.id} --chat\`.\n`)
    return
  }
  if (options.useChat) {
    setVSCodeSessionModel(chatModel)
    logToOutput(`[flow] Using chat model ${chatModel?.id}`)
  }
  if (resumeFrom === 0) {
    await saveFlowState({
      flowId: flow.id,
      status: 'running',
      completedSteps: 0,
      stepSummary,
      originalPrompt: originalPromptContext,
      startedAt,
      updatedAt: new Date().toISOString(),
    })
  }

  for (let i = 0; i < flow.steps.length; i++) {
    if (token.isCancellationRequested) {
      stream.markdown('\n_Flow cancelled by user._\n')
      return
    }

    // Skip already-completed steps when resuming
    if (i < resumeFrom) {
      stream.markdown(`~~Step ${i + 1}~~ _(resumed — skipped)_\n`)
      continue
    }

    const step = flow.steps[i]
    const agent = loaded.agents.get(step.agent) ?? loaded.agents.get('_default')!
    const modelSpec = options.keepCurrentModel
      ? options.currentModelSpec
      : options.useChat
        ? chatModel?.id
        : step.model ?? agent.model
    const stepAgent: Agent = {
      ...agent,
      model: modelSpec,
      skills: step.skills ?? agent.skills,
      tools: step.tools ?? agent.tools,
    }

    const skipOverride = options.keepCurrentModel || options.useChat
    let resolved: ResolvedModel
    try {
      resolved = await getRegistry().resolve({
        flowStepModel: skipOverride ? undefined : modelSpec,
        agentModel: skipOverride ? undefined : agent.model,
        sessionModel: chatModel ? { providerId: 'vscode', modelId: chatModel.id } : undefined,
        fallbackModel: getConfiguredFallbackModel(),
      })
    } catch (err) {
      stream.markdown(`\n❌ Step ${i + 1} (${agent.name ?? agent.id}): no model available.\n\nConfigured model: \`${modelSpec ?? 'none'}\`. Enable a supported provider (VS Code, Claude Code, Codex, or OpenCode) or remove the model spec from the agent/step.\n\n> Check raptor Settings → \`raptor.providers.enabled\``)
      return
    }

    // Warn if the configured model didn't match — something else was used instead.
    const requestedNorm = modelSpec?.toLowerCase().trim() ?? ''
    const resolvedId = resolved.model.id.toLowerCase().trim()
    const resolvedName = resolved.model.name.toLowerCase().trim()
    const modelMismatch = requestedNorm
      && resolved.source !== 'fallback'
      && !resolvedId.includes(requestedNorm)
      && !resolvedName.includes(requestedNorm)
      && !requestedNorm.includes(resolvedId)

    stream.markdown(`**Step ${i + 1}/${flow.steps.length}** — ${agent.name ?? agent.id} \`${resolved.provider.id}:${resolved.model.id}\`\n`)
    if (modelMismatch) {
      stream.markdown(`> ⚠️ Configured model \`${modelSpec}\` not found — using \`${resolved.provider.id}:${resolved.model.id}\` (${resolved.source}). Check provider is enabled.\n\n`)
    }
    logToOutput(`[flow] Step ${i + 1}: agent=${step.agent}, requested=${modelSpec ?? 'default'}, resolved=${resolved.provider.id}:${resolved.model.id} (${resolved.source})`)

    const release = await acquireLocalModel(resolved.model)
    const stepStartedAtMs = Date.now()
    const requiresPlanArtifact = stepRequiresPlanArtifact(step, agent)
    try {
      const messages = await buildMessages(chatContext, request, stepAgent, loaded)
      // Replace the last user message with the step instruction + prior summary
      const lastUser = messages[messages.length - 1]
      if (lastUser && lastUser.role === 'user') {
        const budget = step.summaryBudget ?? 2000
        const summaryPrefix = stepSummary
          ? `[Previous steps summary (max ${budget} chars):\n${stepSummary.slice(0, budget)}\n]\n\n`
          : ''
        const originalContext = shouldAttachOriginalPrompt
          ? `\n\n[Original user request context: ${originalPromptContext}]`
          : ''
        const newContent = `${summaryPrefix}${step.instruction}${originalContext}`
        messages[messages.length - 1] = { role: 'user', content: [{ type: 'text', value: newContent }] }
      }

      const allToolNames = getToolDefs().map(t => t.name)
      const allowedToolNames = filterToolsByAgent(allToolNames, stepAgent.tools)
      const requestedTools = getToolDefs().filter(t => allowedToolNames.includes(t.name))
      const modelSupportsTools = resolved.provider.supportsTools(resolved.model)
      if (!modelSupportsTools && requestedTools.length > 0) {
        logToOutput(`[flow] ${resolved.provider.id}:${resolved.model.id} does not support tools; running step ${i + 1} text-only`)
      }
      const tools = modelSupportsTools ? requestedTools : []

      let stepText = ''
      let iteration = 0
      let stepToolCalls = 0
      const maxIterations = getConfig().maxIterations
      const thresholds = compactThresholdsForModel(resolved.model)

      const capNote = tools.length === 0 ? ' (text-only)' : ''
      stream.progress(`raptor -> ${resolved.model.name} (${resolved.source}; step ${i + 1}${contextWindowNote(resolved.model)}${capNote})`)

      while (iteration < maxIterations) {
        if (token.isCancellationRequested) break
        iteration++

        const tokenCount = estimateTokens(messages)
        if (tokenCount > thresholds.full) {
          stream.progress(`Flow step ${i + 1} context full (${tokenCount.toLocaleString()} tokens) -- compacting...`)
          const compacted = await fullCompactMessages(messages, resolved, token)
          messages.length = 0
          messages.push(...compacted)
        } else if (tokenCount > thresholds.micro) {
          const compacted = microCompactMessages(messages)
          messages.length = 0
          messages.push(...compacted)
        }

        const responseStream = await resolved.provider.sendRequest(resolved.model, messages, { tools }, token)
        const textParts: RaptorTextPart[] = []
        const toolCalls: RaptorToolCallPart[] = []

        for await (const part of responseStream) {
          if (token.isCancellationRequested) break
          if (part.type === 'text') {
            textParts.push({ type: 'text', value: part.value })
            stepText += part.value
            stream.markdown(part.value)
          } else if (part.type === 'tool_call') {
            toolCalls.push({ type: 'tool_call', callId: part.callId, name: part.name, input: part.input })
          }
        }

        if (token.isCancellationRequested) break
        if (toolCalls.length === 0) break

        appendToolResult(messages, textParts, toolCalls)

        stepToolCalls += toolCalls.length
        const callSummary = toolCalls.map(c => `${c.name}(${summariseInput(c.input)})`).join(', ')
        stream.progress(`[flow step ${i + 1} iter ${iteration}] ${callSummary}`)

        const results = await executeToolCallsInOrder(toolCalls, token)
        for (const { toolCall, result } of results) {
          renderToolResultDropdown(stream, toolCall, result)
          logToolCallToOutput(toolCall.name, toolCall.input as Record<string, unknown>, result)

          appendToolResultToMessages(messages, toolCall.callId, result)
        }
      }

      if (iteration >= maxIterations) {
        stream.markdown(`\n\nStep ${i + 1} reached maximum iterations (${maxIterations}). Task may be incomplete.`)
      }

      if (!stepText.trim() && stepToolCalls === 0) {
        stream.markdown(`\n⚠️ Step ${i + 1} produced no output. Check the raptor Output channel for details. Continuing...`)
      }
      if (stepToolCalls === 0 && looksLikeHallucinatedToolExecution(stepText)) {
        throw new Error(
          `Step ${i + 1} described tool results in text but made no real tool calls. ` +
          'Flow aborted so fake edits/plans are not treated as completed work. Retry with a tool-capable model.',
        )
      }
      if (requiresPlanArtifact) {
        const planFile = await newestPlanFileSince(stepStartedAtMs)
        if (!planFile) {
          throw new Error(
            `Planner step ${i + 1} did not create a real .plans/<slug>/plan.md file in the workspace. ` +
            'Flow aborted so the implementer cannot invent fixes from prose-only planning.',
          )
        }
        logToOutput(`[flow] Planner artifact created: ${shortenPath(planFile)}`)
      }

      // Compact step output for next step summary
      const compact = stepText.trim().slice(0, step.summaryBudget ?? 2000)
      stepSummary += `\n--- Step ${i + 1} (${agent.name ?? agent.id}) ---\n${compact}\n`
      logToOutput(`[flow] Step ${i + 1} completed (${stepText.length} chars, ${stepToolCalls} tool calls)`)

      // Persist state after each step so --resume can pick up from here
      await saveFlowState({
        flowId: flow.id,
        status: 'running',
        completedSteps: i + 1,
        stepSummary,
        originalPrompt: originalPromptContext,
        startedAt,
        updatedAt: new Date().toISOString(),
      })

    } catch (err) {
      stream.markdown(`\n❌ Step ${i + 1} failed: ${String(err)}. Flow aborted.\n\n> Use \`/flow ${flow.id} --resume\` to retry from this step.`)
      logToOutput(`[flow] Step ${i + 1} error: ${String(err)}`)
      return
    } finally {
      release()
    }
  }

  await saveFlowState({
    flowId: flow.id,
    status: 'completed',
    completedSteps: flow.steps.length,
    stepSummary,
    originalPrompt: originalPromptContext,
    startedAt,
    updatedAt: new Date().toISOString(),
  })
  stream.markdown(`\n✅ Flow **${flow.name ?? flow.id}** completed.`)
  logToOutput(`[flow] "${flow.id}" completed`)
}

interface FlowCheckpointStepState {
  index: number
  agentId: string
  instructionDigest: string
  resolvedProvider: string
  resolvedModel: string
  requestedTools: string[]
  artifactPath: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt?: string
  updatedAt?: string
}

interface FlowCheckpointState {
  flowId: string
  runId: string
  status: 'running' | 'completed' | 'failed'
  completedSteps: number
  failedStepIndex?: number
  failureReason?: string
  configFingerprint: string
  originalPrompt?: string
  startedAt: string
  updatedAt: string
  stepSummary: string
  steps: FlowCheckpointStepState[]
}

interface FlowExecutionPlanStep {
  index: number
  step: Flow['steps'][number]
  agent: Agent
  modelSpec: string
  resolved: ResolvedModel
  requestedTools: vscode.LanguageModelChatTool[]
  instructionDigest: string
}

interface FlowExecutionPlan {
  flowId: string
  configFingerprint: string
  steps: FlowExecutionPlanStep[]
}

function flowStateRootDir(): string {
  const ws = workspaceRoot()
  const base = ws ? path.join(ws, '.raptor') : raptorDataDir()
  return path.join(base, 'flow-state')
}

function flowCheckpointRunDir(flowId: string, runId: string): string {
  return path.join(flowStateRootDir(), flowId, runId)
}

function flowLatestCheckpointPath(flowId: string): string {
  return path.join(flowStateRootDir(), flowId, 'latest.json')
}

function computeFlowFingerprint(flow: Flow, loaded: LoadedConfig): string {
  const payload = {
    flow,
    agentSources: Array.from(loaded.agents.values()).map(agent => ({
      id: agent.id,
      source: agent.source ?? null,
      model: agent.model ?? null,
      skills: agent.skills ?? null,
      tools: agent.tools ?? null,
    })),
    skillSources: Array.from(loaded.skills.values()).map(skill => ({
      id: skill.id,
      source: skill.source,
    })),
    signature: loaded.signature ?? '',
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

function createInstructionDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
}

async function writeFlowCheckpoint(state: FlowCheckpointState): Promise<void> {
  const runDir = flowCheckpointRunDir(state.flowId, state.runId)
  const latestPath = flowLatestCheckpointPath(state.flowId)
  try {
    await fs.mkdir(runDir, { recursive: true })
    await fs.mkdir(path.dirname(latestPath), { recursive: true })
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8')
    await fs.writeFile(latestPath, JSON.stringify({
      flowId: state.flowId,
      runId: state.runId,
      updatedAt: state.updatedAt,
      status: state.status,
      statePath: path.join(runDir, 'state.json'),
    }, null, 2), 'utf-8')
  } catch (err) {
    logToOutput(`[flow-state] Failed to write checkpoint for "${state.flowId}": ${String(err)}`)
  }
}

async function loadFlowCheckpoint(flowId: string, runId: string): Promise<FlowCheckpointState | null> {
  try {
    const raw = await fs.readFile(path.join(flowCheckpointRunDir(flowId, runId), 'state.json'), 'utf-8')
    return JSON.parse(raw) as FlowCheckpointState
  } catch {
    return null
  }
}

async function loadLatestFlowCheckpoint(flowId: string): Promise<FlowCheckpointState | null> {
  try {
    const latestRaw = await fs.readFile(flowLatestCheckpointPath(flowId), 'utf-8')
    const latest = JSON.parse(latestRaw) as { runId?: string; statePath?: string }
    if (!latest.runId) return null
    const state = await loadFlowCheckpoint(flowId, latest.runId)
    return state
  } catch {
    return null
  }
}

async function listFlowCheckpoints(): Promise<FlowCheckpointState[]> {
  try {
    const root = flowStateRootDir()
    const flowDirs = await fs.readdir(root, { withFileTypes: true })
    const states: FlowCheckpointState[] = []
    for (const flowDir of flowDirs) {
      if (!flowDir.isDirectory()) continue
      const state = await loadLatestFlowCheckpoint(flowDir.name)
      if (state) states.push(state)
    }
    return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

async function preflightFlow(flow: Flow, loaded: LoadedConfig): Promise<FlowExecutionPlan> {
  const fingerprint = computeFlowFingerprint(flow, loaded)
  const allToolNames = getToolDefs().map(tool => tool.name)
  const steps: FlowExecutionPlanStep[] = []

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i]
    const agent = loaded.agents.get(step.agent) ?? loaded.agents.get('_default')!
    const modelSpec = step.model ?? agent.model ?? getConfiguredFallbackModel()
    const resolved = await getRegistry().resolve({
      flowStepModel: modelSpec,
      fallbackModel: getConfiguredFallbackModel(),
    })
    const allowedToolNames = filterToolsByAgent(allToolNames, step.tools ?? agent.tools)
    const requestedTools = getToolDefs().filter(tool => allowedToolNames.includes(tool.name))
    if (requestedTools.length > 0 && !resolved.provider.supportsTools(resolved.model)) {
      throw new Error(toolCapabilityError(resolved.provider.id, resolved.model.id, requestedTools.length))
    }
    steps.push({
      index: i,
      step,
      agent,
      modelSpec,
      resolved,
      requestedTools,
      instructionDigest: createInstructionDigest(step.instruction),
    })
  }

  return {
    flowId: flow.id,
    configFingerprint: fingerprint,
    steps,
  }
}

async function runDeterministicFlow(
  flow: Flow,
  loaded: LoadedConfig,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  options: {
    preflight: FlowExecutionPlan
    resumeState?: FlowCheckpointState
    originalPrompt?: string
  },
): Promise<void> {
  const startedAt = options.resumeState?.startedAt ?? new Date().toISOString()
  const runId = options.resumeState?.runId ?? createRunId()
  const resumeFrom = options.resumeState?.completedSteps ?? 0
  const stepSummarySeed = options.resumeState?.stepSummary ?? ''
  const originalPromptContext = options.originalPrompt?.trim()
  const shouldAttachOriginalPrompt = !!originalPromptContext && !isFlowCommandPrompt(originalPromptContext)
  let stepSummary = stepSummarySeed

  if (!options.resumeState) {
    stream.markdown(`**Starting flow: ${flow.name ?? flow.id}** (${flow.steps.length} steps)\n\n`)
    logToOutput(`[flow] Starting "${flow.id}" with ${flow.steps.length} steps`)
  }

  const checkpointSteps: FlowCheckpointStepState[] = options.preflight.steps.map(step => ({
    index: step.index,
    agentId: step.agent.id,
    instructionDigest: step.instructionDigest,
    resolvedProvider: step.resolved.provider.id,
    resolvedModel: step.resolved.model.id,
    requestedTools: step.requestedTools.map(tool => tool.name),
    artifactPath: path.join(flowCheckpointRunDir(flow.id, runId), `step-${step.index + 1}.md`),
    status: step.index < resumeFrom ? 'completed' : 'pending',
    startedAt: step.index < resumeFrom ? startedAt : undefined,
    updatedAt: step.index < resumeFrom ? startedAt : undefined,
  }))

  if (!options.resumeState) {
    await writeFlowCheckpoint({
      flowId: flow.id,
      runId,
      status: 'running',
      completedSteps: 0,
      configFingerprint: options.preflight.configFingerprint,
      originalPrompt: originalPromptContext,
      startedAt,
      updatedAt: new Date().toISOString(),
      stepSummary,
      steps: checkpointSteps,
    })
  }

  for (const planStep of options.preflight.steps) {
    if (token.isCancellationRequested) {
      stream.markdown('\n_Flow cancelled by user._\n')
      return
    }

    if (planStep.index < resumeFrom) {
      stream.markdown(`~~Step ${planStep.index + 1}~~ _(resumed — skipped)_\n`)
      continue
    }

    const step = planStep.step
    const agent = planStep.agent
    const stepAgent: Agent = {
      ...agent,
      model: planStep.modelSpec,
      skills: step.skills ?? agent.skills,
      tools: step.tools ?? agent.tools,
    }
    const stepArtifactPath = checkpointSteps[planStep.index].artifactPath
    const stepStartedAt = new Date().toISOString()

    stream.markdown(`**Step ${planStep.index + 1}/${flow.steps.length}** — ${agent.name ?? agent.id} \`${planStep.resolved.provider.id}:${planStep.resolved.model.id}\`\n`)
    logToOutput(`[flow] Step ${planStep.index + 1}: agent=${step.agent}, requested=${planStep.modelSpec}, resolved=${planStep.resolved.provider.id}:${planStep.resolved.model.id}`)

    const release = await acquireLocalModel(planStep.resolved.model)
    try {
      const messages = await buildMessages(chatContext, request, stepAgent, loaded)
      const lastUser = messages[messages.length - 1]
      if (lastUser && lastUser.role === 'user') {
        const budget = step.summaryBudget ?? 2000
        const summaryPrefix = stepSummary
          ? `[Previous steps summary (max ${budget} chars):\n${stepSummary.slice(0, budget)}\n]\n\n`
          : ''
        const originalContext = shouldAttachOriginalPrompt
          ? `\n\n[Original user request context: ${originalPromptContext}]`
          : ''
        const newContent = `${summaryPrefix}${step.instruction}${originalContext}`
        messages[messages.length - 1] = { role: 'user', content: [{ type: 'text', value: newContent }] }
      }

      const tools = planStep.requestedTools
      const capNote = tools.length === 0 ? ' (text-only)' : ''
      stream.progress(`raptor -> ${planStep.resolved.model.name} (${planStep.resolved.source}; step ${planStep.index + 1}${contextWindowNote(planStep.resolved.model)}${capNote})`)

      let stepText = ''
      let iteration = 0
      let stepToolCalls = 0
      const maxIterations = getConfig().maxIterations
      const thresholds = compactThresholdsForModel(planStep.resolved.model)

      while (iteration < maxIterations) {
        if (token.isCancellationRequested) break
        iteration++

        const tokenCount = estimateTokens(messages)
        if (tokenCount > thresholds.full) {
          stream.progress(`Flow step ${planStep.index + 1} context full (${tokenCount.toLocaleString()} tokens) -- compacting...`)
          const compacted = await fullCompactMessages(messages, planStep.resolved, token)
          messages.length = 0
          messages.push(...compacted)
        } else if (tokenCount > thresholds.micro) {
          const compacted = microCompactMessages(messages)
          messages.length = 0
          messages.push(...compacted)
        }

        const responseStream = await planStep.resolved.provider.sendRequest(planStep.resolved.model, messages, { tools }, token)
        const textParts: RaptorTextPart[] = []
        const toolCalls: RaptorToolCallPart[] = []

        for await (const part of responseStream) {
          if (token.isCancellationRequested) break
          if (part.type === 'text') {
            textParts.push({ type: 'text', value: part.value })
            stepText += part.value
            stream.markdown(part.value)
          } else if (part.type === 'tool_call') {
            toolCalls.push({ type: 'tool_call', callId: part.callId, name: part.name, input: part.input })
          }
        }

        if (token.isCancellationRequested) break
        if (toolCalls.length === 0) break

        appendToolResult(messages, textParts, toolCalls)

        stepToolCalls += toolCalls.length
        const callSummary = toolCalls.map(c => `${c.name}(${summariseInput(c.input)})`).join(', ')
        stream.progress(`[flow step ${planStep.index + 1} iter ${iteration}] ${callSummary}`)

        const results = await executeToolCallsInOrder(toolCalls, token)
        for (const { toolCall, result } of results) {
          renderToolResultDropdown(stream, toolCall, result)
          logToolCallToOutput(toolCall.name, toolCall.input as Record<string, unknown>, result)
          appendToolResultToMessages(messages, toolCall.callId, result)
        }
      }

      if (iteration >= maxIterations) {
        stream.markdown(`\n\nStep ${planStep.index + 1} reached maximum iterations (${maxIterations}). Task may be incomplete.`)
      }

      if (!stepText.trim() && stepToolCalls === 0) {
        stream.markdown(`\n⚠️ Step ${planStep.index + 1} produced no output. Check the raptor Output channel for details. Continuing...`)
      }
      if (stepToolCalls === 0 && looksLikeHallucinatedToolExecution(stepText)) {
        throw new Error(
          `Step ${planStep.index + 1} described tool results in text but made no real tool calls. Flow aborted so fake edits/plans are not treated as completed work.`,
        )
      }
      if (stepRequiresPlanArtifact(step, agent)) {
        const planFile = await newestPlanFileSince(Date.parse(stepStartedAt))
        if (!planFile) {
          throw new Error(
            `Planner step ${planStep.index + 1} did not create a real .plans/<slug>/plan.md file in the workspace.`,
          )
        }
        logToOutput(`[flow] Planner artifact created: ${shortenPath(planFile)}`)
      }

      const compact = stepText.trim().slice(0, step.summaryBudget ?? 2000)
      stepSummary += `\n--- Step ${planStep.index + 1} (${agent.name ?? agent.id}) ---\n${compact}\n`
      await fs.mkdir(path.dirname(stepArtifactPath), { recursive: true })
      await fs.writeFile(stepArtifactPath, [
        `# Step ${planStep.index + 1}: ${agent.name ?? agent.id}`,
        '',
        `Model: ${planStep.resolved.provider.id}:${planStep.resolved.model.id}`,
        '',
        stepText.trim() || '_No textual output_',
      ].join('\n'), 'utf-8')

      checkpointSteps[planStep.index] = {
        ...checkpointSteps[planStep.index],
        status: 'completed',
        startedAt: checkpointSteps[planStep.index].startedAt ?? stepStartedAt,
        updatedAt: new Date().toISOString(),
      }

      await writeFlowCheckpoint({
        flowId: flow.id,
        runId,
        status: 'running',
        completedSteps: planStep.index + 1,
        configFingerprint: options.preflight.configFingerprint,
        originalPrompt: originalPromptContext,
        startedAt,
        updatedAt: new Date().toISOString(),
        stepSummary,
        steps: checkpointSteps,
      })
    } catch (err) {
      checkpointSteps[planStep.index] = {
        ...checkpointSteps[planStep.index],
        status: 'failed',
        startedAt: checkpointSteps[planStep.index].startedAt ?? stepStartedAt,
        updatedAt: new Date().toISOString(),
      }
      await writeFlowCheckpoint({
        flowId: flow.id,
        runId,
        status: 'failed',
        completedSteps: planStep.index,
        failedStepIndex: planStep.index,
        failureReason: String(err),
        configFingerprint: options.preflight.configFingerprint,
        originalPrompt: originalPromptContext,
        startedAt,
        updatedAt: new Date().toISOString(),
        stepSummary,
        steps: checkpointSteps,
      })
      stream.markdown(`\n❌ Step ${planStep.index + 1} failed: ${String(err)}. Flow aborted.\n\n> Use \`/flow ${flow.id} --resume\` to retry from this step.`)
      logToOutput(`[flow] Step ${planStep.index + 1} error: ${String(err)}`)
      return
    } finally {
      release()
    }
  }

  await writeFlowCheckpoint({
    flowId: flow.id,
    runId,
    status: 'completed',
    completedSteps: flow.steps.length,
    configFingerprint: options.preflight.configFingerprint,
    originalPrompt: originalPromptContext,
    startedAt,
    updatedAt: new Date().toISOString(),
    stepSummary,
    steps: checkpointSteps.map(step => ({
      ...step,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    })),
  })
  stream.markdown(`\n✅ Flow **${flow.name ?? flow.id}** completed.`)
  logToOutput(`[flow] "${flow.id}" completed`)
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Log one or more lines to the VS Code "raptor" Output channel (View → Output → raptor). */
function logToOutput(...lines: string[]): void {
  writeOutputLines(outputChannel, ...lines)
}

/** Log every tool call + result to the output channel for full visibility. */
function logToolCallToOutput(
  name: string,
  input: Record<string, unknown>,
  result: string,
): void {
  writeToolCallLog(outputChannel, name, input, result)
}
