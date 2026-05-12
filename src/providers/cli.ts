import * as vscode from 'vscode'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
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
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(whichCmd, [trimmed], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d.toString('utf-8') })
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim().split(/\r?\n/)[0])
      } else {
        reject(new Error(`Command not found: ${trimmed}`))
      }
    })
    child.on('error', reject)
  })

  return { ok: true, command: result }
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

  let commandResolved: { ok: true; command: string } | { ok: false; reason: string } | null = null
  let statusChecked = false

  async function checkStatus(): Promise<ProviderStatus> {
    if (!statusChecked) {
      commandResolved = await resolveCommand(runtimeCommand)
      statusChecked = true
    }
    if (!commandResolved) {
      commandResolved = await resolveCommand(runtimeCommand)
    }
    if (!commandResolved.ok) {
      return { available: false, reason: commandResolved.reason, code: 'command-not-found' }
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
      const status = await checkStatus()
      if (!status.available) {
        throw new ProviderError(definition.id, status.code || 'unavailable', status.reason || 'Command not available')
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

      if (!commandResolved || !commandResolved.ok) {
        throw new ProviderError(definition.id, 'command-not-found', 'Command not resolved')
      }

      return streamCliCommand(
        commandResolved.command,
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
  // If an API key was configured via SecretStorage or settings, inject it as the
  // provider's primary env var (first entry in envKeys, e.g. ANTHROPIC_API_KEY).
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
      child.stdin.on('error', () => { /* ignore */ })
      child.stdin.write(promptText)
      child.stdin.end()
    }
  }

  const stdoutQueue: string[] = []
  let done = false
  let exitCode: number | null = null
  let error: Error | null = null

  const cancelHandler = () => {
    try {
      child.kill('SIGTERM')
    } catch { /* */ }
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* */ }
    }, 2000)
  }
  token.onCancellationRequested(cancelHandler)

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutQueue.push(chunk.toString('utf-8'))
    })
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      stdoutQueue.push(`[stderr] ${chunk.toString('utf-8')}`)
    })
  }

  child.on('close', (code) => {
    done = true
    exitCode = code
  })

  child.on('error', (err) => {
    done = true
    error = err
  })

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

  if (error) {
    throw new ProviderError(providerId, 'spawn-error', String(error))
  }
  if (exitCode !== 0 && exitCode !== null) {
    throw new ProviderError(providerId, `exit-${exitCode}`, `CLI exited with code ${exitCode}`)
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
    argsForModel: (model, prompt) => {
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
    argsForModel: (model, prompt) => {
      const modelId = (model.id && model.id !== 'default') ? model.id : 'gpt-5.3-codex'
      return ['exec', '--model', modelId, '-']
    },
    cwdPolicy: 'workspace',
    envKeys: ['OPENAI_API_KEY'],
    knownModels: ['gpt-5.3-codex', 'gpt-5.2'],
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
