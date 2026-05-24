import * as vscode from 'vscode'

export const SUPPORTED_PROVIDER_IDS = ['vscode', 'claude-code', 'codex', 'opencode'] as const
export type SupportedProviderId = typeof SUPPORTED_PROVIDER_IDS[number]
export type CliProviderId = Exclude<SupportedProviderId, 'vscode'>

export interface ProviderConfig {
  enabled: boolean
  command?: string
  defaultModel?: string
}

export type ProviderConfigMap = Record<SupportedProviderId, ProviderConfig>

export interface ProviderConfigLoadResult {
  configs: ProviderConfigMap
  warnings: string[]
}

const CLI_DEFAULT_COMMANDS: Record<CliProviderId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
}

const LEGACY_DIRECT_PROVIDER_SETTING_KEYS = [
  'provider.anthropic.apiKey',
  'provider.openai.apiKey',
  'provider.openrouter.apiKey',
  'provider.ollama.baseUrl',
] as const

function isSupportedProviderId(value: string): value is SupportedProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function inspectHasValue(inspected: unknown): boolean {
  if (!inspected || typeof inspected !== 'object') return false
  const record = inspected as Record<string, unknown>
  return [
    record.globalValue,
    record.globalLanguageValue,
    record.workspaceValue,
    record.workspaceLanguageValue,
    record.workspaceFolderValue,
    record.workspaceFolderLanguageValue,
  ].some(value => value !== undefined)
}

function readTrustedCommand(
  cfg: vscode.WorkspaceConfiguration,
  providerId: CliProviderId,
  warnings: string[],
): string {
  const key = `provider.${providerId}.command`
  const inspected = cfg.inspect(key) as Record<string, unknown> | undefined
  const workspaceOverride = inspected?.workspaceValue ?? inspected?.workspaceLanguageValue ?? inspected?.workspaceFolderValue ?? inspected?.workspaceFolderLanguageValue
  const globalValue = inspected?.globalValue ?? inspected?.globalLanguageValue

  if (isNonEmptyString(workspaceOverride)) {
    warnings.push(`[config] Ignoring workspace override for ${key}; CLI command settings are user/machine scope only.`)
  }

  if (isNonEmptyString(globalValue)) {
    return globalValue.trim()
  }

  return CLI_DEFAULT_COMMANDS[providerId]
}

function readCliProviderConfig(
  cfg: vscode.WorkspaceConfiguration,
  enabledRaw: Record<string, boolean>,
  providerId: CliProviderId,
  warnings: string[],
): ProviderConfig {
  const enabled = enabledRaw[providerId] ?? false
  return {
    enabled,
    command: readTrustedCommand(cfg, providerId, warnings),
    defaultModel: cfg.get<string>(`provider.${providerId}.defaultModel`),
  }
}

function collectLegacyWarnings(cfg: vscode.WorkspaceConfiguration, warnings: string[]): void {
  const enabledRaw = cfg.get<Record<string, boolean>>('providers.enabled', {})
  for (const legacyId of Object.keys(enabledRaw)) {
    if (!isSupportedProviderId(legacyId)) {
      warnings.push(`[config] Ignoring unsupported provider id "${legacyId}" in raptor.providers.enabled.`)
    }
  }

  const defaultProvider = cfg.get<string>('defaultProvider', 'vscode')
  if (!isSupportedProviderId(defaultProvider)) {
    warnings.push(`[config] Ignoring unsupported default provider "${defaultProvider}". Use one of: ${SUPPORTED_PROVIDER_IDS.join(', ')}.`)
  }
  if (!defaultProvider) {
    warnings.push('[config] defaultProvider is not set; falling back to "vscode".')
  }
  else if (defaultProvider !== 'vscode' && !enabledRaw[defaultProvider]) {
    warnings.push(`[config] defaultProvider "${defaultProvider}" is not enabled in providers.enabled.`)
  }

  for (const key of LEGACY_DIRECT_PROVIDER_SETTING_KEYS) {
    if (inspectHasValue(cfg.inspect(key))) {
      warnings.push(`[config] Setting "raptor.${key}" is no longer used and will be ignored.`)
    }
  }
}

export async function loadProviderConfigs(_context: vscode.ExtensionContext): Promise<ProviderConfigLoadResult> {
  const cfg = vscode.workspace.getConfiguration('raptor')
  const warnings: string[] = []

  collectLegacyWarnings(cfg, warnings)

  const enabledRaw = cfg.get<Record<string, boolean>>('providers.enabled', {})
  const configs: ProviderConfigMap = {
    vscode: { enabled: true },
    'claude-code': readCliProviderConfig(cfg, enabledRaw, 'claude-code', warnings),
    codex: readCliProviderConfig(cfg, enabledRaw, 'codex', warnings),
    opencode: readCliProviderConfig(cfg, enabledRaw, 'opencode', warnings),
  }

  return { configs, warnings }
}

export function logProviderStatus(providerId: string, status: string, logFn: (msg: string) => void): void {
  logFn(`[provider] ${providerId}: ${status}`)
}
