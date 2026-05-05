import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import {
  getConfig,
  pickPreferredChatModel,
  resolveModelForRequest,
} from './src/config/model'
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

// ─── Module-level singletons ───────────────────────────────────────────────────

let outputChannel: vscode.OutputChannel | undefined
let extContext: vscode.ExtensionContext | undefined

// ── Steering buffer ────────────────────────────────────────────────────────────
// Allows users to inject guidance mid-flight via `/steer <message>` or the
// `raptor.steer` command. The agent loop drains this buffer each iteration and
// injects the messages as new User turns so the LLM sees them immediately.
const steeringBuffer: string[] = []

function pushSteering(msg: string): void {
  steeringBuffer.push(msg)
}

function drainSteering(): string[] {
  return steeringBuffer.splice(0, steeringBuffer.length)
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
// ─── PERSISTENT MEMORY SYSTEM ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// Two tiers:
//   1. GLOBAL memory  — ~/.raptor/memory/MEMORY.md  (user-wide facts, preferences)
//   2. PROJECT memory  — <workspace>/.raptor/MEMORY.md  (project-specific knowledge)
// Both are auto-injected into the system prompt.

const MEMORY_MAX_BYTES = 25 * 1024       // 25 KB per entry
const MEMORY_INDEX_MAX_LINES = 200       // keep index under 200 lines

function memoryDir(): string { return path.join(raptorDataDir(), 'memory') }
function memoryIndexPath(): string { return path.join(memoryDir(), 'MEMORY.md') }

function projectClawdDir(): string | null {
  const root = workspaceRoot()
  return root ? path.join(root, '.raptor') : null
}
function projectMemoryPath(): string | null {
  const dir = projectClawdDir()
  return dir ? path.join(dir, 'MEMORY.md') : null
}
function projectHistoryDir(): string | null {
  const dir = projectClawdDir()
  return dir ? path.join(dir, 'history') : null
}

async function readMemoryIndex(): Promise<string> {
  try {
    const content = await fs.readFile(memoryIndexPath(), 'utf-8')
    return content.replace(/\r\n/g, '\n')
  } catch { return '' }
}

async function writeMemoryIndex(content: string): Promise<void> {
  await fs.mkdir(memoryDir(), { recursive: true })
  const lines = content.split('\n')
  const trimmed = lines.length > MEMORY_INDEX_MAX_LINES
    ? lines.slice(lines.length - MEMORY_INDEX_MAX_LINES).join('\n')
    : content
  await fs.writeFile(memoryIndexPath(), trimmed, 'utf-8')
}

async function readProjectMemory(): Promise<string> {
  const p = projectMemoryPath()
  if (!p) return ''
  try {
    const content = await fs.readFile(p, 'utf-8')
    return content.replace(/\r\n/g, '\n')
  } catch { return '' }
}

async function writeProjectMemory(content: string): Promise<void> {
  const p = projectMemoryPath()
  if (!p) return
  await fs.mkdir(path.dirname(p), { recursive: true })
  const lines = content.split('\n')
  const trimmed = lines.length > MEMORY_INDEX_MAX_LINES
    ? lines.slice(lines.length - MEMORY_INDEX_MAX_LINES).join('\n')
    : content
  await fs.writeFile(p, trimmed, 'utf-8')
}

// ── Workspace profile ──────────────────────────────────────────────────────────
// Auto-scanned on first prompt per session. Cached in <workspace>/.raptor/profile.md
let workspaceProfileCache: string | null = null

async function getOrBuildWorkspaceProfile(): Promise<string> {
  if (workspaceProfileCache) return workspaceProfileCache

  const pDir = projectClawdDir()
  if (!pDir) return ''

  // Try loading cached profile
  const profilePath = path.join(pDir, 'profile.md')
  try {
    const cached = await fs.readFile(profilePath, 'utf-8')
    const lines = cached.split('\n')
    // Check if it's recent (header line has date)
    const dateLine = lines.find(l => l.includes('Generated:'))
    if (dateLine) {
      const dateStr = dateLine.replace(/.*Generated:\s*/, '').trim()
      const cacheDate = new Date(dateStr)
      const ageMs = Date.now() - cacheDate.getTime()
      if (ageMs < 24 * 60 * 60 * 1000) { // less than 24h old
        workspaceProfileCache = cached
        return cached
      }
    }
  } catch { /* no cache, build it */ }

  // Build fresh profile
  const root = workspaceRoot()
  if (!root) return ''

  const profile: string[] = [`# Workspace Profile`, `Generated: ${new Date().toISOString()}`]

  // Package.json
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'))
    profile.push(`\n## Node.js Project`)
    if (pkg.name) profile.push(`- Name: ${pkg.name}`)
    if (pkg.description) profile.push(`- Description: ${pkg.description}`)
    if (pkg.scripts) profile.push(`- Scripts: ${Object.keys(pkg.scripts).join(', ')}`)
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const keyDeps = Object.keys(allDeps).filter(d =>
      /react|vue|angular|next|express|fastify|nest|typeorm|prisma|jest|mocha|vitest|webpack|vite|esbuild|typescript|tailwind|eslint|prettier/i.test(d)
    )
    if (keyDeps.length) profile.push(`- Key deps: ${keyDeps.join(', ')}`)
  } catch { /* no package.json */ }

  // pom.xml / build.gradle
  for (const buildFile of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    try {
      await fs.access(path.join(root, buildFile))
      profile.push(`\n## JVM Project (${buildFile})`)
    } catch { /* not found */ }
  }

  // Python
  for (const pyFile of ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile']) {
    try {
      await fs.access(path.join(root, pyFile))
      profile.push(`\n## Python Project (${pyFile})`)
      if (pyFile === 'requirements.txt') {
        const reqs = (await fs.readFile(path.join(root, pyFile), 'utf-8')).split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 30)
        profile.push(`- Dependencies: ${reqs.map(r => r.split('=')[0].split('>')[0].split('<')[0].trim()).join(', ')}`)
      }
    } catch { /* not found */ }
  }

  // tsconfig
  try {
    const tsc = JSON.parse(await fs.readFile(path.join(root, 'tsconfig.json'), 'utf-8'))
    profile.push(`\n## TypeScript Config`)
    if (tsc.compilerOptions?.target) profile.push(`- Target: ${tsc.compilerOptions.target}`)
    if (tsc.compilerOptions?.module) profile.push(`- Module: ${tsc.compilerOptions.module}`)
    if (tsc.compilerOptions?.strict !== undefined) profile.push(`- Strict: ${tsc.compilerOptions.strict}`)
  } catch { /* no tsconfig */ }

  // Top-level directory listing (first 50 entries)
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name + '/').slice(0, 30)
    const files = entries.filter(e => e.isFile()).map(e => e.name).slice(0, 20)
    profile.push(`\n## Workspace Structure`)
    profile.push(`Dirs: ${dirs.join(', ')}`)
    profile.push(`Files: ${files.join(', ')}`)
  } catch { /* can't list */ }

  const result = profile.join('\n')
  workspaceProfileCache = result

  // Cache to disk
  try {
    await fs.mkdir(pDir, { recursive: true })
    await fs.writeFile(profilePath, result, 'utf-8')
  } catch { /* silent */ }

  return result
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

function estimateTokens(messages: vscode.LanguageModelChatMessage[]): number {
  let total = 0
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += part.value.length / TOKEN_ESTIMATE_RATIO
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        for (const c of part.content) {
          if (c instanceof vscode.LanguageModelTextPart) {
            total += c.value.length / TOKEN_ESTIMATE_RATIO
          }
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        total += JSON.stringify(part.input).length / TOKEN_ESTIMATE_RATIO
      }
    }
  }
  return Math.round(total)
}

function microCompactMessages(
  messages: vscode.LanguageModelChatMessage[],
  keepRecentTurns = 4,
): vscode.LanguageModelChatMessage[] {
  const cutoff = Math.max(2, messages.length - keepRecentTurns * 2)
  return messages.map((msg, idx) => {
    if (idx >= cutoff) return msg
    let changed = false
    const newParts = msg.content.map(part => {
      if (!(part instanceof vscode.LanguageModelToolResultPart)) return part
      const newContent = part.content.map(c => {
        if (!(c instanceof vscode.LanguageModelTextPart)) return c
        if (c.value.length <= MICRO_COMPACT_TOOL_LIMIT) return c
        changed = true
        const preview = c.value.slice(0, MICRO_COMPACT_TOOL_LIMIT)
        return new vscode.LanguageModelTextPart(
          preview + `\n...[compacted: ${c.value.length} chars -> ${MICRO_COMPACT_TOOL_LIMIT}]`,
        )
      })
      return new vscode.LanguageModelToolResultPart(part.callId, newContent)
    })
    if (!changed) return msg
    return new vscode.LanguageModelChatMessage(msg.role, newParts as vscode.LanguageModelInputPart[])
  })
}

async function fullCompactMessages(
  messages: vscode.LanguageModelChatMessage[],
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<vscode.LanguageModelChatMessage[]> {
  const convoText = messages
    .map(m => {
      const role = m.role === vscode.LanguageModelChatMessageRole.User ? 'User' : 'Assistant'
      const text = m.content
        .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
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
    const resp = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(summaryPrompt)], {}, token,
    )
    let summary = ''
    for await (const part of resp.stream) {
      if (part instanceof vscode.LanguageModelTextPart) summary += part.value
    }
    const systemMessages = messages.slice(0, 2)
    const recentMessages = messages.slice(-4)
    return [
      ...systemMessages,
      vscode.LanguageModelChatMessage.User(
        `[CONVERSATION SUMMARY -- context was compacted]\n\n${summary}`,
      ),
      vscode.LanguageModelChatMessage.Assistant('Understood. Continuing from the summary above.'),
      ...recentMessages,
    ]
  } catch {
    return microCompactMessages(messages, 6)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SESSION RESUME + CONVERSATION HISTORY ───────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function sessionSummaryPath(): string {
  // Prefer project-local, fall back to global
  const pDir = projectClawdDir()
  return pDir ? path.join(pDir, 'last-session-summary.md') : path.join(raptorDataDir(), 'last-session-summary.md')
}

async function saveSessionSummary(summary: string): Promise<void> {
  try {
    const p = sessionSummaryPath()
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, summary, 'utf-8')
    // Also save to global for cross-project resume
    const globalPath = path.join(raptorDataDir(), 'last-session-summary.md')
    await fs.mkdir(path.dirname(globalPath), { recursive: true })
    await fs.writeFile(globalPath, summary, 'utf-8')
  } catch { /* silent */ }
}

async function loadSessionSummary(): Promise<string | null> {
  // Try project-local first, then global
  for (const p of [sessionSummaryPath(), path.join(raptorDataDir(), 'last-session-summary.md')]) {
    try {
      const content = await fs.readFile(p, 'utf-8')
      if (content.trim()) return content.replace(/\r\n/g, '\n')
    } catch { /* try next */ }
  }
  return null
}

// ── Conversation history persistence ────────────────────────────────────────
// Saves a serialisable snapshot of the conversation so /resume can reload
// actual messages rather than just a summary.
interface ConversationSnapshot {
  timestamp: string
  messages: Array<{ role: 'user' | 'assistant'; text: string }>
  totalToolCalls: number
}

async function saveConversationHistory(
  messages: vscode.LanguageModelChatMessage[],
  totalToolCalls: number,
): Promise<void> {
  try {
    const hDir = projectHistoryDir() ?? path.join(raptorDataDir(), 'history')
    await fs.mkdir(hDir, { recursive: true })

    const snapshot: ConversationSnapshot = {
      timestamp: new Date().toISOString(),
      totalToolCalls,
      messages: messages.slice(1).map(m => ({
        role: m.role === vscode.LanguageModelChatMessageRole.User ? 'user' as const : 'assistant' as const,
        text: m.content
          .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
          .map(p => p.value).join(' ')
          .slice(0, 5000),
      })).filter(m => m.text.trim()),
    }

    // Keep last 5 sessions
    const files = (await fs.readdir(hDir)).filter(f => f.startsWith('session-') && f.endsWith('.json')).sort()
    if (files.length >= 5) {
      for (const old of files.slice(0, files.length - 4)) {
        try { await fs.unlink(path.join(hDir, old)) } catch { /* */ }
      }
    }

    const filename = `session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    await fs.writeFile(path.join(hDir, filename), JSON.stringify(snapshot, null, 2), 'utf-8')
  } catch { /* silent */ }
}

async function loadRecentHistory(): Promise<ConversationSnapshot | null> {
  const dirs = [projectHistoryDir(), path.join(raptorDataDir(), 'history')].filter(Boolean) as string[]
  for (const hDir of dirs) {
    try {
      const files = (await fs.readdir(hDir)).filter(f => f.startsWith('session-') && f.endsWith('.json')).sort()
      if (!files.length) continue
      const latest = await fs.readFile(path.join(hDir, files[files.length - 1]), 'utf-8')
      return JSON.parse(latest) as ConversationSnapshot
    } catch { continue }
  }
  return null
}

async function generateSessionSummary(
  messages: vscode.LanguageModelChatMessage[],
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string> {
  const convoText = messages.slice(2)
    .map(m => {
      const role = m.role === vscode.LanguageModelChatMessageRole.User ? 'User' : 'Assistant'
      const text = m.content
        .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
        .map(p => p.value).join(' ')
      return `${role}: ${text.slice(0, 1500)}`
    }).join('\n\n').slice(0, 30_000)

  if (!convoText.trim()) return ''

  const prompt = [
    'Summarise this coding session in 300-500 words for resumption in a future session.',
    'Include: goals, files changed, key decisions, unfinished work, important context.',
    'Start with: "# Session Summary -- ' + new Date().toLocaleDateString() + '"',
    '', convoText,
  ].join('\n')

  try {
    const resp = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)], {}, token,
    )
    let summary = ''
    for await (const part of resp.stream) {
      if (part instanceof vscode.LanguageModelTextPart) summary += part.value
    }
    return summary.trim()
  } catch {
    return `# Session Summary -- ${new Date().toLocaleDateString()}\n\n(Summary generation failed)`
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MEMORY EXTRACTION (post-turn) ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function extractAndStoreMemories(
  userPrompt: string,
  assistantResponse: string,
): Promise<void> {
  try {
    const models = await vscode.lm.selectChatModels()
    const model = models.find(m =>
      /gpt-4o-mini/i.test(m.id) || /gpt-4o-mini/i.test(m.family) || /gpt-4o-mini/i.test(m.name),
    ) ?? models[0]
    if (!model) return

    const extractPrompt = [
      'Analyse this Q&A exchange. Extract two categories of facts:',
      '',
      '## DURABLE FACTS (project-agnostic)',
      'User preferences, coding style, general decisions. 0-3 items.',
      'Format: "- [global] <fact>"',
      '',
      '## PROJECT FACTS (specific to the codebase being worked on)',
      'File conventions, architecture decisions, build commands, known issues. 0-4 items.',
      'Format: "- [project] <fact>"',
      '',
      '## CORRECTIONS (if the user corrected the assistant)',
      'What the assistant did wrong and what the right approach is. 0-2 items.',
      'These are HIGH PRIORITY -- the assistant must not repeat the mistake.',
      'Format: "- [correction] WRONG: <what was wrong>. RIGHT: <what to do instead>"',
      '',
      'If nothing worth remembering, reply with: (none)',
      '',
      `USER ASKED: ${userPrompt.slice(0, 800)}`,
      '',
      `ASSISTANT DID: ${assistantResponse.slice(0, 1500)}`,
    ].join('\n')

    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(extractPrompt)],
      {}, new vscode.CancellationTokenSource().token,
    )
    let extracted = ''
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) extracted += part.value
    }
    extracted = extracted.trim()
    if (!extracted || extracted.includes('(none)') || extracted.length < 10) return

    const lines = extracted.split('\n').map(l => l.trim()).filter(l => l.startsWith('- '))
    const globalFacts:  string[] = []
    const projectFacts: string[] = []

    for (const line of lines) {
      const text = line.replace(/^- \[(global|project|correction)\]\s*/i, '- ')
      if (/\[correction\]/i.test(line)) {
        // Corrections go to BOTH global and project memory (high priority)
        globalFacts.push(`- **CORRECTION**: ${text.replace(/^- /, '')}`)
        projectFacts.push(`- **CORRECTION**: ${text.replace(/^- /, '')}`)
      } else if (/\[project\]/i.test(line)) {
        projectFacts.push(text)
      } else {
        globalFacts.push(text)
      }
    }

    const timestamp = new Date().toISOString().split('T')[0]

    // Save global facts
    if (globalFacts.length > 0) {
      let index = await readMemoryIndex()
      const block = `## session-facts (${timestamp})\n${globalFacts.join('\n')}\n`
      index = index ? index.trimEnd() + '\n\n' + block : block
      await writeMemoryIndex(index)
    }

    // Save project facts
    if (projectFacts.length > 0) {
      let pMem = await readProjectMemory()
      const block = `## session-facts (${timestamp})\n${projectFacts.join('\n')}\n`
      pMem = pMem ? pMem.trimEnd() + '\n\n' + block : block
      await writeProjectMemory(pMem)
    }
  } catch { /* fire-and-forget */ }
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  extContext = context
  outputChannel = vscode.window.createOutputChannel('raptor')
  context.subscriptions.push(outputChannel)
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

// ── Steering function ──────────────────────────────────────────────────────────
// Intercepts and rewrites LLM tool-call inputs BEFORE execution to fix
// known-bad patterns that the model frequently generates. This is a defence-in-
// depth layer on top of the system-prompt guardrails.
//
// Rules are additive -- add new cases as new failure patterns emerge.
function steerToolCall(name: string, input: ToolInput): void {
  const isWin = process.platform === 'win32'
  const tempDir = extensionTempDir()

  // ── runTerminal steering ──────────────────────────────────────────────────
  if (name === 'runTerminal' && typeof input['command'] === 'string') {
    let cmd = input['command'] as string

    // 1. COMPREHENSIVE C:\ root redirect.
    //    The model loves writing temp files to C:\ root (commit-msg.txt, patch.diff, etc.)
    //    which fails because users don't have write access there.
    //    Strategy: replace ALL occurrences of C:\<bare-filename> (not under a real subdir)
    //    with $TEMP\<filename>.  A "bare filename" = C:\ followed by a name with no further backslash.
    if (isWin) {
      // Match C:\someFile.ext or "C:\someFile.ext" or 'C:\someFile.ext'
      // but NOT C:\Users\..., C:\Program Files\..., C:\Windows\..., etc.
      const safeRoots = /^(Users|Program|Windows|ProgramData|tools|apps|opt)/i
      cmd = cmd.replace(
        /(?:["']?)C:\\([a-zA-Z0-9_. -]+?)(?=["'\s;|>)`]|$)/gi,
        (match, afterBackslash: string) => {
          // If it continues with \ it's a subdir — leave it alone
          // (this regex already prevents that by not including \ in the capture)
          // If it looks like a known safe subdirectory, leave it
          if (safeRoots.test(afterBackslash)) return match
          // If it has no dot and could be a directory name like C:\repos, leave it
          // (heuristic: real temp files almost always have extensions)
          if (!afterBackslash.includes('.') && afterBackslash.length < 20) return match
          const fixed = match.replace(/C:\\/i, `${tempDir}\\`)
          logToOutput(`[steering] Redirected "${match}" -> "${fixed}"`)
          return fixed
        },
      )

      // Specific git pattern: git commit -F <path>
      // Rewrite to use -m instead if the file doesn't exist yet, or redirect the path
      cmd = cmd.replace(
        /git\s+commit\s+.*?-F\s+["']?C:\\([^"'\s;|]+)["']?/gi,
        (match, filename: string) => {
          if (safeRoots.test(filename)) return match
          const redirected = match.replace(/C:\\/i, `${tempDir}\\`)
          logToOutput(`[steering] Redirected git -F path: "${match}" -> "${redirected}"`)
          return redirected
        },
      )
    }

    // 2. Rewrite PowerShell-isms to cmd.exe equivalents (model sometimes still generates PS syntax)
    if (isWin) {
      // $env:VAR -> %VAR%
      cmd = cmd.replace(/\$env:([A-Za-z_]+)/g, '%$1%')
      // Out-File "path" -> > "path"
      cmd = cmd.replace(/\|\s*Out-File\s+/gi, '> ')
      // Set-Content -> echo ... >
      // Get-Content -> type
      cmd = cmd.replace(/(?:^|&&\s*|&\s*)Get-Content\s+/gi, (m) => m.replace(/Get-Content/i, 'type'))
      // Remove PowerShell encoding preambles that the model might still hallucinate
      cmd = cmd.replace(/\[Console\]::OutputEncoding\s*=\s*[^;]+;\s*/gi, '')
      cmd = cmd.replace(/\$OutputEncoding\s*=\s*[^;]+;\s*/gi, '')
      // Remove chcp calls (no longer needed with spawn + UTF-8 env)
      cmd = cmd.replace(/chcp\s+65001\s*[;&|]?\s*/gi, '')
      // Replace PowerShell semicolons with && for cmd.exe
      // (only if the command looks like PS syntax with semicolons as separators)
      // Don't replace semicolons inside quotes
    }

    // 3. Prevent catastrophic commands
    if (/rm\s+(-rf?|\/s)\s+[/\\]($|\s)/i.test(cmd) || /Remove-Item\s+[/\\]\s/i.test(cmd) || /del\s+\/[sq]\s+[/\\]/i.test(cmd)) {
      input['command'] = 'echo BLOCKED: Refusing to delete root filesystem'
      logToOutput(`[steering] BLOCKED destructive command: ${cmd}`)
      return
    }

    // 4. Prevent disk operations
    if (/(?:format|fdisk|diskpart)\s/i.test(cmd)) {
      input['command'] = 'echo BLOCKED: Disk operations not allowed'
      logToOutput(`[steering] BLOCKED disk operation: ${cmd}`)
      return
    }

    input['command'] = cmd
  }

  // ── editFile / multiEdit steering ─────────────────────────────────────────
  if (name === 'editFile' || name === 'multiEdit') {
    // Fix model sending paths starting with / on Windows (e.g. /H:/repos/...)
    if (isWin) {
      if (typeof input['path'] === 'string') {
        input['path'] = (input['path'] as string).replace(/^\/([A-Za-z]:)/, '$1')
      }
      if (Array.isArray(input['edits'])) {
        for (const edit of input['edits'] as Array<Record<string, unknown>>) {
          if (typeof edit['path'] === 'string') {
            edit['path'] = (edit['path'] as string).replace(/^\/([A-Za-z]:)/, '$1')
          }
        }
      }
    }
  }

  // ── writeFile steering ────────────────────────────────────────────────────
  if (name === 'writeFile' && typeof input['path'] === 'string') {
    const p = input['path'] as string
    // Block writes to C:\ root
    if (isWin && /^C:\\[^\\]+$/i.test(p)) {
      const filename = path.basename(p)
      input['path'] = path.join(tempDir, filename)
      logToOutput(`[steering] Redirected writeFile C:\\${filename} -> ${tempDir}\\${filename}`)
    }
    // Fix leading slash on Windows
    if (isWin) {
      input['path'] = (input['path'] as string).replace(/^\/([A-Za-z]:)/, '$1')
    }
  }

  // ── readFile steering ─────────────────────────────────────────────────────
  if (name === 'readFile' && typeof input['path'] === 'string') {
    if (isWin) {
      input['path'] = (input['path'] as string).replace(/^\/([A-Za-z]:)/, '$1')
    }
  }
}

async function dispatchTool(name: string, input: ToolInput, token?: vscode.CancellationToken): Promise<string> {
  // ── Steering: rewrite known-bad patterns before execution ─────────────────
  steerToolCall(name, input)

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
    case 'todoWrite':      return toolTodoWrite(input)
    case 'memoryRead':     return toolMemoryRead(input)
    case 'memoryWrite':    return toolMemoryWrite(input)
    case 'lsp':            return toolLsp(input)
    case 'spawnAgent':     return toolSpawnAgent(input)
    default: return `Unknown tool: ${name}`
  }
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (globalThis as any).fetch(url, {
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

// ── todoWrite ────────────────────────────────────────────────────────────
async function toolTodoWrite(input: ToolInput): Promise<string> {
  const todos = input['todos']
  const dataDir = raptorDataDir()
  try {
    await fs.mkdir(dataDir, { recursive: true })
    const filePath = path.join(dataDir, 'todos.json')
    await fs.writeFile(filePath, JSON.stringify(todos, null, 2), 'utf-8')
    const count = Array.isArray(todos) ? todos.length : '?'
    return `✓ Saved ${count} todos to ${filePath}`
  } catch (err) {
    return `Error writing todos: ${String(err)}`
  }
}

// ── memoryRead ───────────────────────────────────────────────────────────
async function toolMemoryRead(input?: ToolInput): Promise<string> {
  const scope = (input?.['scope'] as string | undefined) ?? 'all'
  const parts: string[] = []

  if (scope === 'all' || scope === 'global') {
    const content = await readMemoryIndex()
    if (content.trim()) parts.push(`# Global Memory\n${content}`)
  }
  if (scope === 'all' || scope === 'project') {
    const content = await readProjectMemory()
    if (content.trim()) parts.push(`# Project Memory\n${content}`)
  }

  return parts.length > 0 ? parts.join('\n\n---\n\n') : '(no memories stored yet)'
}

// ── memoryWrite ──────────────────────────────────────────────────────────
async function toolMemoryWrite(input: ToolInput): Promise<string> {
  const topic   = (input['topic']   as string | undefined) ?? 'general'
  const content = input['content']  as string
  const replace = (input['replace'] as boolean | undefined) ?? false
  const scope   = (input['scope']   as string | undefined) ?? 'global'

  if (!content?.trim()) return 'Error: content is required'

  const entry = content.length > MEMORY_MAX_BYTES
    ? content.slice(0, MEMORY_MAX_BYTES) + '\n...[truncated]'
    : content

  const timestamp = new Date().toISOString().split('T')[0]
  const heading   = `## ${topic} (${timestamp})`
  const block     = `${heading}\n${entry.trim()}\n`

  const readFn  = scope === 'project' ? readProjectMemory  : readMemoryIndex
  const writeFn = scope === 'project' ? writeProjectMemory : writeMemoryIndex

  let index = await readFn()
  if (replace) {
    const escapedTopic = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const sectionRe = new RegExp(`## ${escapedTopic}[^\n]*\n(?:(?!## )[\\s\\S])*`, 'g')
    if (sectionRe.test(index)) {
      index = index.replace(sectionRe, block)
    } else {
      index = index ? index.trimEnd() + '\n\n' + block : block
    }
  } else {
    index = index ? index.trimEnd() + '\n\n' + block : block
  }

  await writeFn(index)
  return `Memory saved [${scope}]: "${topic}" (${entry.length} chars)`
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

  const availableModels = await vscode.lm.selectChatModels()
  const picked = pickPreferredChatModel(availableModels, getConfig().preferredModel)
  const model = picked.model
  if (!model) return 'Error: no model available for sub-agent'

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

  const subMessages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(subSystemPrompt),
    vscode.LanguageModelChatMessage.Assistant('Understood. I will complete this task autonomously.'),
    vscode.LanguageModelChatMessage.User('Begin the task now.'),
  ]

  const subTools = getToolDefs().filter((tool: vscode.LanguageModelChatTool) => toolsAllowed.includes(tool.name))

  logToOutput(`[sub-agent] spawned for: ${task.slice(0, 100)}`)

  let iteration = 0
  let finalText = ''

  while (iteration < maxIter) {
    iteration++
    let response: vscode.LanguageModelChatResponse
    try {
      response = await model.sendRequest(
        subMessages, { tools: subTools }, new vscode.CancellationTokenSource().token,
      )
    } catch (err) { return `Sub-agent model error: ${String(err)}` }

    const textParts: vscode.LanguageModelTextPart[] = []
    const toolCalls: vscode.LanguageModelToolCallPart[] = []

    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) textParts.push(part)
      else if (part instanceof vscode.LanguageModelToolCallPart) toolCalls.push(part)
    }

    finalText = textParts.map(p => p.value).join('')
    if (toolCalls.length === 0) break

    subMessages.push(new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.Assistant, [...textParts, ...toolCalls],
    ))

    const settled = await Promise.allSettled(
      toolCalls.map(async tc => {
        let result: string
        try { result = await dispatchTool(tc.name, tc.input as ToolInput) }
        catch (e) { result = `Error: ${String(e)}` }
        return { tc, result }
      }),
    )

    for (const s of settled) {
      const { tc, result } = s.status === 'fulfilled'
        ? s.value
        : { tc: toolCalls[settled.indexOf(s)], result: `Error: ${String((s as PromiseRejectedResult).reason)}` }
      subMessages.push(new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        [new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(result)])],
      ))
    }
  }

  logToOutput(`[sub-agent] completed after ${iteration} iterations`)
  const summary = finalText.trim() || '(sub-agent completed with no final text)'
  return summary.length > 8000 ? summary.slice(0, 8000) + '\n...[truncated]' : summary
}

// ─── Chat participant ──────────────────────────────────────────────────────────

function registerChatParticipant(context: vscode.ExtensionContext): void {
  registerChatParticipantModule(context, handleChatRequest)
}

async function handleChatRequest(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  const config = getConfig()
  const promptTrimmed = request.prompt.trim()

  // ── Slash commands ─────────────────────────────────────────────────────────

  if (request.command === 'help' || promptTrimmed === '/help') {
    stream.markdown(buildHelpMarkdown())
    return {}
  }

  if (request.command === 'memory' || promptTrimmed === '/memory') {
    const [globalMem, projectMem] = await Promise.all([readMemoryIndex(), readProjectMemory()])
    const parts: string[] = []
    if (globalMem.trim()) parts.push(`## Global Memory\n\n${globalMem}`)
    if (projectMem.trim()) parts.push(`## Project Memory\n\n${projectMem}`)
    stream.markdown(parts.length > 0 ? parts.join('\n\n---\n\n') : '_(no memories stored yet)_')
    return {}
  }

  if (request.command === 'resume' || promptTrimmed === '/resume') {
    const [summary, history] = await Promise.all([loadSessionSummary(), loadRecentHistory()])
    const parts: string[] = []

    if (summary) {
      parts.push(`## Session Summary\n\n${summary}`)
    }
    if (history) {
      const age = Date.now() - new Date(history.timestamp).getTime()
      const ageStr = age < 3600_000 ? `${Math.round(age / 60_000)}m ago` : `${Math.round(age / 3600_000)}h ago`
      const lastMsgs = history.messages.slice(-6).map(m =>
        `**${m.role}**: ${m.text.slice(0, 300)}${m.text.length > 300 ? '...' : ''}`
      ).join('\n\n')
      parts.push(`## Last Conversation (${ageStr}, ${history.totalToolCalls} tool calls)\n\n${lastMsgs}`)
    }

    if (parts.length === 0) {
      stream.markdown('No previous session data found.')
    } else {
      stream.markdown(`**Resuming previous session:**\n\n${parts.join('\n\n---\n\n')}`)
    }
    return {}
  }

  if (request.command === 'todos' || promptTrimmed === '/todos') {
    const todosPath = path.join(raptorDataDir(), 'todos.json')
    let raw = ''
    try { raw = await fs.readFile(todosPath, 'utf-8') } catch { /* not found */ }
    if (!raw.trim()) {
      stream.markdown('_(no todos file found)_')
    } else {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          const statusIcon = (s: string) => s === 'completed' ? '\\u2705' : s === 'in_progress' ? '\\ud83d\\udd04' : '\\u2b1c'
          const rows = parsed.map((t: any) =>
            `${statusIcon(t.status ?? '')} **${t.title ?? t.id ?? '?'}** \`[${t.status ?? '?'}]\`` +
            (t.description ? `\n   > ${t.description}` : '')
          ).join('\n')
          stream.markdown(`**Todos:**\n\n${rows}`)
        } else {
          stream.markdown(`**Todos:**\n\`\`\`json\n${raw}\n\`\`\``)
        }
      } catch { stream.markdown(`**Todos:**\n\`\`\`json\n${raw}\n\`\`\``) }
    }
    return {}
  }

  if (request.command === 'clearmemory' || promptTrimmed === '/clearmemory') {
    const cleared: string[] = []
    try { await fs.unlink(memoryIndexPath()); cleared.push('global') } catch { /* */ }
    const pm = projectMemoryPath()
    if (pm) { try { await fs.unlink(pm); cleared.push('project') } catch { /* */ } }
    stream.markdown(cleared.length > 0 ? `Cleared: ${cleared.join(', ')} memory.` : 'No memory to clear.')
    return {}
  }

  // /steer — inject guidance into a running agent session.
  // The message is pushed to the steering buffer and will be picked up by whichever
  // agent loop iteration runs next.  If no agent is running, it's just queued
  // until the next @raptor prompt.
  if (request.command === 'steer' || promptTrimmed.startsWith('/steer ')) {
    const steerMsg = request.command === 'steer'
      ? request.prompt.trim()
      : promptTrimmed.replace(/^\/steer\s+/, '')
    if (!steerMsg) {
      stream.markdown('Usage: `/steer <guidance>` -- inject steering into the running agent.')
      return {}
    }
    pushSteering(steerMsg)
    stream.markdown(`Steering queued (will be injected on the agent's next iteration):\n> ${steerMsg}`)
    return {}
  }

  const { model, source, available } = await resolveModelForRequest(request, config.preferredModel)
  if (!model) {
    stream.markdown('No chat model available. Install/configure a chat model provider (Copilot, Ollama, etc.) and sign in if required.')
    return {}
  }

  // ── Build messages + inject memory ─────────────────────────────────────────
  const messages = await buildMessages(chatContext, request)
  const tools    = getToolDefs()

  const hasOllama = available.some(m => /ollama/i.test(m.vendor) || /ollama/i.test(m.id) || /ollama/i.test(m.family))
  const availabilityNote = `${available.length} model${available.length === 1 ? '' : 's'} detected${hasOllama ? ', includes Ollama' : ''}`
  stream.progress(`raptor -> ${model.name} (${source}; ${availabilityNote})`)

  const MAX_ITERATIONS = config.maxIterations
  let iteration = 0
  let totalToolCalls = 0
  let fullAssistantText = ''

  while (iteration < MAX_ITERATIONS) {
    if (token.isCancellationRequested) break
    iteration++

    // ── Drain steering buffer ───────────────────────────────────────────────
    // If the user sent `/steer <msg>` or used the raptor.steer command while
    // the agent was running, inject their guidance as a new User message so
    // the LLM sees it on this iteration.
    const steered = drainSteering()
    if (steered.length > 0) {
      const combined = steered.join('\n\n')
      messages.push(
        vscode.LanguageModelChatMessage.User(
          `[USER STEERING -- mid-session guidance, follow this immediately]\n${combined}`,
        ),
      )
      stream.markdown(`\n> **Steering injected:** ${combined}\n\n`)
      logToOutput(`[steering] Injected ${steered.length} message(s): ${combined.slice(0, 200)}`)
    }

    // ── Context compaction ──────────────────────────────────────────────────
    const tokenCount = estimateTokens(messages)
    if (tokenCount > FULL_COMPACT_THRESHOLD) {
      stream.progress(`Context full (${tokenCount.toLocaleString()} tokens) -- compacting...`)
      const compacted = await fullCompactMessages(messages, model, token)
      messages.length = 0
      messages.push(...compacted)
    } else if (tokenCount > MICRO_COMPACT_THRESHOLD) {
      const compacted = microCompactMessages(messages)
      messages.length = 0
      messages.push(...compacted)
    }

    let response: vscode.LanguageModelChatResponse
    try {
      response = await model.sendRequest(messages, { tools }, token)
    } catch (err) {
      stream.markdown(`\nModel error: ${String(err)}`)
      return {}
    }

    const textParts: vscode.LanguageModelTextPart[]     = []
    const toolCalls: vscode.LanguageModelToolCallPart[] = []

    for await (const part of response.stream) {
      if (token.isCancellationRequested) break
      if (part instanceof vscode.LanguageModelTextPart) {
        textParts.push(part)
        stream.markdown(part.value)
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part)
      }
    }

    fullAssistantText += textParts.map(p => p.value).join('')

    if (token.isCancellationRequested) break
    if (toolCalls.length === 0) break

    messages.push(
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.Assistant,
        [...textParts, ...toolCalls],
      ),
    )

    totalToolCalls += toolCalls.length

    const callSummary = toolCalls.map(c => `${c.name}(${summariseInput(c.input)})`).join(', ')
    stream.progress(`[iter ${iteration}] ${callSummary}`)

    const settled = await Promise.allSettled(
      toolCalls.map(async toolCall => {
        const input = toolCall.input as Record<string, unknown>
        let result: string
        try {
          result = await dispatchTool(toolCall.name, input, token)
        } catch (err) {
          result = `Error: ${String(err)}`
        }
        return { toolCall, result }
      }),
    )

    for (const outcome of settled) {
      const { toolCall, result } = outcome.status === 'fulfilled'
        ? outcome.value
        : { toolCall: toolCalls[settled.indexOf(outcome)], result: `Error: ${String((outcome as PromiseRejectedResult).reason)}` }

      if (toolCall.name === 'todoWrite') {
        const todos = (toolCall.input as ToolInput)['todos']
        if (Array.isArray(todos) && todos.length > 0) {
          const lines = todos.map((t: {id?:string;content?:string;status?:string}) => {
            const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'
            return `${icon} ${t.content ?? t.id}`
          })
          stream.markdown(`\n**Tasks:**\n${lines.join('\n')}\n`)
        }
      }

      renderToolResultDropdown(stream, toolCall, result)
      logToolCallToOutput(toolCall.name, toolCall.input as Record<string, unknown>, result)

      messages.push(
        new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.User,
          [new vscode.LanguageModelToolResultPart(toolCall.callId, [
            new vscode.LanguageModelTextPart(result),
          ])],
        ),
      )
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    stream.markdown(
      `\n\nReached maximum iterations (${MAX_ITERATIONS}). ` +
      `Task may be incomplete. Total tool calls: ${totalToolCalls}.`,
    )
  }

  // ── Post-turn: save session summary + extract memories + save history (fire-and-forget) ──
  if (fullAssistantText.trim()) {
    void generateSessionSummary(messages, model, token).then(summary => {
      if (summary) return saveSessionSummary(summary)
    })
    void extractAndStoreMemories(request.prompt, fullAssistantText)
    void saveConversationHistory(messages, totalToolCalls)
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

async function buildMessages(
  chatContext: vscode.ChatContext,
  request: vscode.ChatRequest,
): Promise<vscode.LanguageModelChatMessage[]> {
  // Inject persistent memory (global + project) + workspace profile into system prompt
  const [globalMem, projectMem, wsProfile] = await Promise.all([
    readMemoryIndex(),
    readProjectMemory(),
    getOrBuildWorkspaceProfile(),
  ])

  const sections: string[] = []

  if (wsProfile.trim()) {
    sections.push(`\n\n# Workspace Profile\n${wsProfile}`)
  }
  if (globalMem.trim()) {
    sections.push(`\n\n# Persistent Memory (global)\nFacts saved from previous sessions across all projects:\n\n${globalMem}`)
  }
  if (projectMem.trim()) {
    sections.push(`\n\n# Project Memory\nFacts specific to this workspace/project:\n\n${projectMem}`)
  }

  const memorySection = sections.join('')

  const root = workspaceRoot() ?? '(no workspace)'
  const promptEditor = vscode.window.activeTextEditor
  const editorContext = promptEditor
    ? `Active file: ${promptEditor.document.fileName}  Language: ${promptEditor.document.languageId}`
    : 'No file open'

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(buildSystemPrompt({
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
    }) + memorySection),
    vscode.LanguageModelChatMessage.Assistant(
      'Ready. I will use my tools autonomously to complete your request without asking for permission.',
    ),
  ]

  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt))
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = (turn.response as vscode.ChatResponsePart[])
        .filter((p): p is vscode.ChatResponseMarkdownPart =>
          p instanceof vscode.ChatResponseMarkdownPart)
        .map(p => p.value.value)
        .join('')
      if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text))
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

  messages.push(vscode.LanguageModelChatMessage.User(userContent))
  return messages
}

// ─── Commands ──────────────────────────────────────────────────────────────────

function registerCommands(context: vscode.ExtensionContext): void {
  registerCommandsModule(context, {
    workspaceRoot,
    pushSteering,
  })
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
