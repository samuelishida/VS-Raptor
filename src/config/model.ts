import * as vscode from 'vscode'

export interface RaptorConfig {
  maxIterations: number
  spawnAgentMaxIterations: number
  preferredModel: string
}

export interface ModelSpec {
  provider?: string
  model: string
  raw: string
}

export function getConfig(): RaptorConfig {
  const cfg = vscode.workspace.getConfiguration('raptor')
  return {
    maxIterations: cfg.get<number>('maxIterations', 150),
    spawnAgentMaxIterations: cfg.get<number>('spawnAgentMaxIterations', 60),
    preferredModel: cfg.get<string>('model', 'claude-sonnet-4.6'),
  }
}

function normalizeModelToken(value: string): string {
  return value.trim().toLowerCase()
}

export function parseModelSpec(spec: string): ModelSpec | { error: string; raw: string } {
  const raw = spec.trim()
  if (!raw) return { error: 'empty-model-spec', raw }
  const idx = raw.indexOf(':')
  if (idx > 0) {
    return { provider: normalizeModelToken(raw.slice(0, idx)), model: raw.slice(idx + 1), raw }
  }
  return { model: raw, raw }
}

export function normalizeModelSpec(spec: string): string {
  const parsed = parseModelSpec(spec)
  if ('error' in parsed) return parsed.raw
  return parsed.provider ? `${parsed.provider}:${parsed.model}` : parsed.model
}

function modelTokens(model: vscode.LanguageModelChat): string[] {
  return [model.id, model.family, model.name].map(normalizeModelToken).filter(Boolean)
}

export function pickPreferredChatModel(
  models: readonly vscode.LanguageModelChat[],
  preferredModel: string,
): { model: vscode.LanguageModelChat | undefined; source: string } {
  if (!models.length) return { model: undefined, source: 'none' }

  const pref = normalizeModelToken(preferredModel)

  const exact = models.find(model =>
    modelTokens(model).some(value => value === pref),
  )
  if (exact) return { model: exact, source: 'preferred-exact' }

  const base = normalizeModelToken(preferredModel.replace(/\.\d+$/, ''))
  if (base && base !== pref) {
    const baseMatch = models.find(model => normalizeModelToken(model.family).startsWith(base))
    if (baseMatch) return { model: baseMatch, source: 'preferred-family-base' }
  }

  const copilot = models.find(model => normalizeModelToken(model.vendor) === 'copilot')
  if (copilot) return { model: copilot, source: 'copilot-fallback' }

  return { model: models[0], source: 'first-available' }
}

export function pickModelByVendorAndId(
  models: readonly vscode.LanguageModelChat[],
  spec: string,
): vscode.LanguageModelChat | undefined {
  const norm = normalizeModelToken(spec)

  // Support vendor:model syntax, e.g. "claude-code:sonnet" or "codex:gpt-5.3-codex"
  const vendorSplit = norm.split(':')
  const vendorHint = vendorSplit.length > 1 ? vendorSplit[0] : undefined
  const modelHint = vendorSplit.length > 1 ? vendorSplit.slice(1).join(':') : norm
  const candidates = vendorHint
    ? models.filter(m => normalizeModelToken(m.vendor) === vendorHint)
    : [...models]

  if (!modelHint) return undefined

  // Exact match on id/family/name first. When a vendor was specified, do not
  // allow an identically named model from a different provider to win.
  const exact = candidates.find(m =>
    modelTokens(m).some(v => v === modelHint),
  )
  if (exact) return exact

  const partial = candidates.find(m => modelTokens(m).some(v => v.includes(modelHint)))
  if (partial) return partial

  return undefined
}

export async function resolveModelForRequest(
  request: vscode.ChatRequest,
  preferredModel: string,
  agentModel?: string,
  overrideSource = 'agent-override',
): Promise<{
  model: vscode.LanguageModelChat | undefined
  source: string
  available: vscode.LanguageModelChat[]
}> {
  const available = await vscode.lm.selectChatModels()

  // 1. Agent override
  if (agentModel) {
    const picked = pickModelByVendorAndId(available, agentModel)
    if (picked) {
      return { model: picked, source: overrideSource, available }
    }
    return { model: available[0], source: `${overrideSource}-unavailable-first-available`, available }
  }

  // 2. Session-selected model
  if (request.model) {
    return { model: request.model, source: 'session-selected', available }
  }

  // 3. Global preferred model
  const picked = pickPreferredChatModel(available, preferredModel)
  return { model: picked.model, source: picked.source, available }
}
