import * as vscode from 'vscode'

export interface ProviderConfig {
  enabled: boolean
  apiKey?: string
  baseUrl?: string
  command?: string
  defaultModel?: string
  deprecatedSettingUsed?: boolean
}

export interface ProviderConfigMap {
  [providerId: string]: ProviderConfig
}

const PLAIN_SETTING_PREFIX = 'raptor.provider.'

const DEPRECATED_KEYS: Record<string, string> = {
  'raptor.provider.anthropic.apiKey': 'anthropic',
  'raptor.provider.openai.apiKey': 'openai',
  'raptor.provider.openrouter.apiKey': 'openrouter',
}

export async function loadProviderConfigs(context: vscode.ExtensionContext): Promise<ProviderConfigMap> {
  const cfg = vscode.workspace.getConfiguration('raptor')
  const enabledRaw = cfg.get<Record<string, boolean>>('providers.enabled', {})
  const defaultProvider = cfg.get<string>('defaultProvider', 'vscode')

  const allIds = new Set([defaultProvider, ...Object.keys(enabledRaw), 'vscode', 'anthropic', 'openai', 'openrouter', 'ollama', 'claude-code', 'codex', 'opencode'])
  const map: ProviderConfigMap = {}

  for (const id of allIds) {
    if (!id) continue
    map[id] = {
      enabled: enabledRaw[id] ?? true,
      apiKey: await getProviderSecret(context, id),
      baseUrl: cfg.get<string>(`provider.${id}.baseUrl`),
      command: cfg.get<string>(`provider.${id}.command`),
      defaultModel: cfg.get<string>(`provider.${id}.defaultModel`),
    }
  }

  return map
}

export async function getProviderSecret(context: vscode.ExtensionContext, providerId: string): Promise<string | undefined> {
  const secretKey = `raptor-provider-${providerId}-apiKey`

  try {
    const secret = await context.secrets.get(secretKey)
    if (secret) return secret
  } catch { /* fall through */ }

  const envKey = `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`
  const envValue = process.env[envKey]
  if (envValue) return envValue

  return undefined
}

export function logProviderStatus(providerId: string, status: string, logFn: (msg: string) => void): void {
  logFn(`[provider] ${providerId}: ${status}`)
}
