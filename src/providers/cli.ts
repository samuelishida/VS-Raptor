import * as vscode from 'vscode'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import {
  ProviderError,
  type ModelProvider,
  type RaptorModel,
  type RaptorMessage,
  type RaptorResponseEvent,
  type ProviderStatus,
} from './types'

export interface CliProviderDefinition {
  id: string
  name: string
  command: string
  argsForModel: (model: RaptorModel, prompt: string) => string[]
  cwdPolicy: 'workspace' | 'home' | 'temp'
  envKeys?: string[]
  knownModels?: string[]
  acceptsArbitraryModel: boolean
  promptTransport: 'argv' | 'stdin'
}

export interface CliProviderRuntimeConfig {
  command?: string
  defaultModel?: string
  apiKey?: string
}

const WIN_ARGV_SAFE_LIMIT = 8000
const RESOLVE_COMMAND_TIMEOUT_MS = 5000

function unquoteCommand(cmd: string): string {
  const trimmed = cmd.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export async function resolveCommand(cmd: string): Promise<{ ok: true; command: string } | { ok: false; reason: string }> {
  if (!cmd) {
    return { ok: false, reason: 'Command is empty' }
  }

  const trimmed = unquoteCommand(cmd)

  if (path.isAbsolute(trimmed)) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(trimmed))
      return { ok: true, command: trimmed }
    } catch {
      return { ok: false, reason: `Absolute path not found: ${trimmed}` }
    }
  }

  const whichCmd = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Command resolution timed out: ${trimmed}`)),
        RESOLVE_COMMAND_TIMEOUT_MS,
      )
      const child = spawn(whichCmd, [trimmed], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', (d) => { stdout += d.toString('utf-8') })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim().split(/\r?\n/)[0])
        } else {
          reject(new Error(`Command not found: ${trimmed}`))
        }
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    return { ok: true, command: result }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

function textFromMessage(message: RaptorMessage): string {
  return message.content
    .filter(c => c.type === 'text')
    .map(c => c.value)
    .join('\n')
    .trim()
}

function buildDelegatedPrompt(messages: RaptorMessage[]): string {
  const sections: string[] = []

  const systemText = messages
    .filter(m => m.role === 'system')
    .map(textFromMessage)
    .filter(Boolean)
    .join('\n\n')
  if (systemText) {
    sections.push(`# System Instructions\n${systemText}`)
  }

  const conversation = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      const text = textFromMessage(m)
      if (!text) return ''
      const role = m.role === 'assistant' ? 'Assistant' : 'User'
      return `${role}:\n${text}`
    })
    .filter(Boolean)
    .join('\n\n')
  if (conversation) {
    sections.push(`# Conversation\n${conversation}`)
  }

  return sections.join('\n\n').trim()
}

export function createCliProvider(
  definition: CliProviderDefinition,
  config?: CliProviderRuntimeConfig,
): ModelProvider {
  const runtimeCommand = config?.command || definition.command
  const defaultModel = config?.defaultModel

  const baseModels: RaptorModel[] = (definition.knownModels ?? ['default']).map(m => ({
    id: m,
    name: m === 'default' ? `${definition.name} Default` : m,
    providerId: definition.id,
  }))

  // Promise-based caching: concurrent callers await the same resolution, no duplicate spawns.
  let commandResolvedPromise: Promise<{ ok: true; command: string } | { ok: false; reason: string }> | null = null

  async function getResolvedCommand() {
    if (!commandResolvedPromise) {
      commandResolvedPromise = resolveCommand(runtimeCommand)
    }
    return commandResolvedPromise
  }

  async function checkStatus(): Promise<ProviderStatus> {
    const result = await getResolvedCommand()
    if (!result.ok) {
      return { available: false, reason: result.reason, code: 'command-not-found' }
    }
    return { available: true }
  }

  function getModels(): RaptorModel[] {
    if (defaultModel) {
      const withDefault: RaptorModel[] = [
        { id: 'default', name: `${definition.name} Default (${defaultModel})`, providerId: definition.id },
        ...baseModels,
      ]
      return withDefault
    }
    return baseModels
  }

  return {
    id: definition.id,
    name: definition.name,
    capability: 'delegated',
    acceptsArbitraryModel: definition.acceptsArbitraryModel,

    async listModels(): Promise<RaptorModel[]> {
      const status = await checkStatus()
      if (!status.available) {
        return []
      }
      return getModels()
    },

    async getStatus(): Promise<ProviderStatus> {
      return checkStatus()
    },

    async sendRequest(
      model: RaptorModel,
      messages: RaptorMessage[],
      _options: { tools?: vscode.LanguageModelChatTool[] },
      token: vscode.CancellationToken,
    ): Promise<AsyncIterable<RaptorResponseEvent>> {
      const resolved = await getResolvedCommand()
      if (!resolved.ok) {
        throw new ProviderError(definition.id, 'command-not-found', resolved.reason)
      }

      const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')
      if (!lastUserMessage) {
        throw new ProviderError(definition.id, 'no-prompt', 'No user message to send to CLI')
      }

      const promptText = buildDelegatedPrompt(messages)
      if (!promptText) {
        throw new ProviderError(definition.id, 'no-prompt', 'No text prompt to send to CLI')
      }

      const effectiveModel = model.id === 'default' && defaultModel ? { ...model, id: defaultModel } : model
      const args = definition.argsForModel(effectiveModel, promptText)
      const cwd = getCwd(definition.cwdPolicy)
      const env = buildEnv(definition.envKeys, config)

      return streamCliCommand(
        resolved.command,
        args,
        cwd,
        env,
        definition.id,
        promptText,
        definition.promptTransport,
        token,
      )
    },

    supportsTools() { return false },
  }
}

function getCwd(policy: CliProviderDefinition['cwdPolicy']): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!ws) return os.homedir()

  switch (policy) {
    case 'workspace': return ws
    case 'home': return os.homedir()
    case 'temp': return os.tmpdir()
  }
}

function buildEnv(keys: string[] = [], config: CliProviderRuntimeConfig = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (config.apiKey && keys.length > 0) {
    env[keys[0]] = config.apiKey
  }
  return env
}

async function* streamCliCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  providerId: string,
  promptText: string,
  promptTransport: 'argv' | 'stdin',
  token: vscode.CancellationToken,
): AsyncIterable<RaptorResponseEvent> {
  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: promptTransport === 'stdin' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  })

  if (promptTransport === 'stdin') {
    if (child.stdin) {
      child.stdin.on('error', () => { /* ignore broken pipe on early exit */ })
      child.stdin.write(promptText)
      child.stdin.end()
    }
  }

  const stdoutQueue: string[] = []
  let stderrBuffer = ''
  let done = false
  let exitCode: number | null = null
  let error: Error | null = null

  const cancelHandler = () => {
    try { child.kill('SIGTERM') } catch { /* */ }
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* */ } }, 2000)
  }
  const cancelDisposable = token.onCancellationRequested(cancelHandler)

  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutQueue.push(stdoutDecoder.write(chunk))
    })
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += stderrDecoder.write(chunk)
    })
  }

  child.on('close', (code) => {
    const remaining = stdoutDecoder.end()
    if (remaining) stdoutQueue.push(remaining)
    stderrBuffer += stderrDecoder.end()
    done = true
    exitCode = code
  })

  child.on('error', (err) => {
    done = true
    error = err
  })

  try {
    while (!done) {
      while (stdoutQueue.length > 0) {
        const chunk = stdoutQueue.shift()!
        yield { type: 'text', value: chunk }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    while (stdoutQueue.length > 0) {
      const chunk = stdoutQueue.shift()!
      yield { type: 'text', value: chunk }
    }
  } finally {
    cancelDisposable.dispose()
  }

  if (error) {
    throw new ProviderError(providerId, 'spawn-error', String(error))
  }
  if (exitCode !== 0 && exitCode !== null) {
    const stderrHint = stderrBuffer.trim() ? `\nstderr: ${stderrBuffer.trim().slice(0, 500)}` : ''
    throw new ProviderError(providerId, `exit-${exitCode}`, `CLI exited with code ${exitCode}${stderrHint}`)
  }
}

function checkArgvLength(cmdName: string, prompt: string): void {
  if (process.platform !== 'win32') return
  if (prompt.length > WIN_ARGV_SAFE_LIMIT) {
    throw new ProviderError(
      cmdName,
      'prompt-too-long',
      `Prompt length (${prompt.length}) exceeds safe Windows command-line limit (${WIN_ARGV_SAFE_LIMIT}). Use a shorter prompt or a provider that accepts stdin.`,
    )
  }
}

export function createClaudeCodeProviderConfig(): CliProviderDefinition {
  return {
    id: 'claude-code',
    name: 'Claude Code (CLI)',
    command: 'claude',
    argsForModel: (model, _prompt) => {
      if (model.id && model.id !== 'default') {
        return ['--print', '--input-format', 'text', '--model', model.id]
      }
      return ['--print', '--input-format', 'text']
    },
    cwdPolicy: 'workspace',
    envKeys: ['ANTHROPIC_API_KEY'],
    knownModels: ['sonnet', 'opus', 'haiku'],
    acceptsArbitraryModel: true,
    promptTransport: 'stdin',
  }
}

export function createCodexProviderConfig(): CliProviderDefinition {
  return {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    argsForModel: (model, _prompt) => {
      const modelId = (model.id && model.id !== 'default') ? model.id : 'codex-mini-latest'
      return ['exec', '--model', modelId, '-']
    },
    cwdPolicy: 'workspace',
    envKeys: ['OPENAI_API_KEY'],
    knownModels: ['codex-mini-latest', 'o4-mini'],
    acceptsArbitraryModel: true,
    promptTransport: 'stdin',
  }
}

export function createOpenCodeProviderConfig(): CliProviderDefinition {
  return {
    id: 'opencode',
    name: 'OpenCode CLI',
    command: 'opencode',
    argsForModel: (model, prompt) => {
      checkArgvLength('opencode', prompt)
      if (model.id && model.id !== 'default') {
        return ['run', '--model', model.id, prompt]
      }
      return ['run', prompt]
    },
    cwdPolicy: 'workspace',
    envKeys: ['OPENCODE_API_KEY'],
    knownModels: ['default'],
    acceptsArbitraryModel: true,
    promptTransport: 'argv',
  }
}
