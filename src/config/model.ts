import * as vscode from 'vscode'

export interface RaptorConfig {
  maxIterations: number
  spawnAgentMaxIterations: number
  preferredModel: string
}

export function getConfig(): RaptorConfig {
  const cfg = vscode.workspace.getConfiguration('raptor')
  return {
    maxIterations: cfg.get<number>('maxIterations', 100),
    spawnAgentMaxIterations: cfg.get<number>('spawnAgentMaxIterations', 60),
    preferredModel: cfg.get<string>('model', 'claude-sonnet-4.6'),
  }
}

function normalizeModelToken(value: string): string {
  return value.trim().toLowerCase()
}

export function pickPreferredChatModel(
  models: readonly vscode.LanguageModelChat[],
  preferredModel: string,
): { model: vscode.LanguageModelChat | undefined; source: string } {
  if (!models.length) return { model: undefined, source: 'none' }

  const pref = normalizeModelToken(preferredModel)

  const exact = models.find(model =>
    [model.id, model.family, model.name].some(value => normalizeModelToken(value) === pref),
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

export async function resolveModelForRequest(
  request: vscode.ChatRequest,
  preferredModel: string,
): Promise<{
  model: vscode.LanguageModelChat | undefined
  source: string
  available: vscode.LanguageModelChat[]
}> {
  const available = await vscode.lm.selectChatModels()

  if (request.model) {
    return { model: request.model, source: 'session-selected', available }
  }

  const picked = pickPreferredChatModel(available, preferredModel)
  return { model: picked.model, source: picked.source, available }
}