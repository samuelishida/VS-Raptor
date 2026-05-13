import * as vscode from 'vscode'
import {
  ProviderError,
  type ModelProvider,
  type ResolvedModel,
  type RaptorModel,
  type ModelResolutionInput,
} from './types'

export interface ProviderRegistry {
  register(provider: ModelProvider): void
  getProvider(id: string): ModelProvider | undefined
  listProviders(): ModelProvider[]
  resolve(input: ModelResolutionInput): Promise<ResolvedModel>
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase()
}

function parseModelSpec(spec: string): { provider?: string; model: string; raw: string } {
  const raw = spec.trim()
  if (!raw) return { model: '', raw }
  const idx = raw.indexOf(':')
  if (idx > 0) {
    return { provider: normalizeToken(raw.slice(0, idx)), model: raw.slice(idx + 1), raw }
  }
  return { model: raw, raw }
}

function modelTokens(model: RaptorModel): string[] {
  return [model.id, model.name].map(normalizeToken).filter(Boolean)
}

function pickModelByVendorAndId(
  models: readonly RaptorModel[],
  spec: string,
): RaptorModel | undefined {
  if (models.length === 0) {
    console.warn('[Model Registry] Empty models array passed to pickModelByVendorAndId')
    return undefined
  }

  const norm = normalizeToken(spec)

  const fullExact = models.find(m => modelTokens(m).some(v => v === norm))
  if (fullExact) return fullExact

  const fullPartial = models.find(m => modelTokens(m).some(v => v.includes(norm) || norm.includes(v)))
  if (fullPartial) return fullPartial

  const vendorSplit = norm.split(':')
  const vendorHint = vendorSplit.length > 1 ? vendorSplit[0] : undefined
  const modelHint = vendorSplit.length > 1 ? vendorSplit.slice(1).join(':') : norm
  const candidates = vendorHint
    ? models.filter(m => normalizeToken(m.providerId) === vendorHint)
    : [...models]

  const exact = candidates.find(m => modelTokens(m).some(v => v === modelHint))
  if (exact) return exact

  const partial = candidates.find(m => modelTokens(m).some(v => v.includes(modelHint)))
  if (partial) return partial

  return undefined
}

function resolveExplicitProviderModel(
  provider: ModelProvider,
  available: RaptorModel[],
  spec: string,
  providerId: string,
): RaptorModel {
  const parsed = parseModelSpec(spec)
  const modelHint = parsed.model
  const picked = pickModelByVendorAndId(available, spec)
  if (picked) return picked
  if (provider.acceptsArbitraryModel) {
    return { id: modelHint, name: modelHint, providerId }
  }
  throw new ProviderError(providerId, 'model-not-found', `Model "${modelHint}" not found in provider "${provider.name}".`)
}

async function ensureProviderAvailable(provider: ModelProvider): Promise<void> {
  const status = provider.getStatus ? await provider.getStatus() : null
  if (status && !status.available) {
    throw new ProviderError(provider.id, status.code || 'unavailable', status.reason || `Provider "${provider.name}" is unavailable.`)
  }
}

async function resolveInternal(
  providers: Map<string, ModelProvider>,
  input: ModelResolutionInput,
): Promise<ResolvedModel> {
  // 1. flowStepModel — highest precedence
  if (input.flowStepModel) {
    const parsed = parseModelSpec(input.flowStepModel)
    if (parsed.provider) {
      const provider = providers.get(parsed.provider)
      if (!provider) {
        if (input.allowFallbackForExplicitProvider) return resolveFallback(providers, input)
        throw new ProviderError(parsed.provider, 'not-registered', `Provider "${parsed.provider}" is not registered.`)
      }
      if (provider.capability === 'unavailable') {
        if (input.allowFallbackForExplicitProvider) return resolveFallback(providers, input)
        throw new ProviderError(parsed.provider, 'unavailable', `Provider "${provider.name}" is unavailable.`)
      }
      try {
        await ensureProviderAvailable(provider)
      } catch (err) {
        if (input.allowFallbackForExplicitProvider) return resolveFallback(providers, input)
        throw err
      }
      const available = await provider.listModels()
      if (available.length === 0) {
        throw new ProviderError(parsed.provider, 'no-models', `Provider "${provider.name}" returned no models.`)
      }
      const model = resolveExplicitProviderModel(provider, available, input.flowStepModel, parsed.provider)
      return { provider, model, source: 'flow-step-override', available }
    }
    for (const p of providers.values()) {
      if (p.capability === 'unavailable') continue
      const available = await p.listModels()
      const picked = pickModelByVendorAndId(available, input.flowStepModel)
      if (picked) return { provider: p, model: picked, source: 'flow-step-override', available }
    }
    throw new ProviderError('registry', 'model-not-found', `Flow step model "${input.flowStepModel}" was not found in any provider.`)
  }

  // 2. agentModel
  if (input.agentModel) {
    const parsed = parseModelSpec(input.agentModel)
    if (parsed.provider) {
      const provider = providers.get(parsed.provider)
      if (!provider) {
        if (input.allowFallbackForExplicitProvider) return resolveFallback(providers, input)
        throw new ProviderError(parsed.provider, 'not-registered', `Provider "${parsed.provider}" is not registered.`)
      }
      if (provider.capability === 'unavailable') {
        if (input.allowFallbackForExplicitProvider) return resolveFallback(providers, input)
        throw new ProviderError(parsed.provider, 'unavailable', `Provider "${provider.name}" is unavailable.`)
      }
      try {
        await ensureProviderAvailable(provider)
      } catch (err) {
        if (input.allowFallbackForExplicitProvider) return resolveFallback(providers, input)
        throw err
      }
      const available = await provider.listModels()
      if (available.length === 0) {
        throw new ProviderError(parsed.provider, 'no-models', `Provider "${provider.name}" returned no models.`)
      }
      const model = resolveExplicitProviderModel(provider, available, input.agentModel, parsed.provider)
      return { provider, model, source: 'agent-override', available }
    }
    for (const p of providers.values()) {
      if (p.capability === 'unavailable') continue
      const available = await p.listModels()
      const picked = pickModelByVendorAndId(available, input.agentModel)
      if (picked) return { provider: p, model: picked, source: 'agent-override', available }
    }
    throw new ProviderError('registry', 'model-not-found', `Agent model "${input.agentModel}" was not found in any provider.`)
  }

  // 3. sessionModel (from VS Code chat UI)
  if (input.sessionModel) {
    const sessionProviderId = input.sessionModel.providerId
    if (sessionProviderId) {
      const provider = providers.get(sessionProviderId)
      if (provider && provider.capability !== 'unavailable') {
        const available = await provider.listModels()
        const picked = pickModelByVendorAndId(available, input.sessionModel.modelId)
        if (picked) return { provider, model: picked, source: 'session-selected', available }
      }
    }
    for (const p of providers.values()) {
      if (p.capability === 'unavailable') continue
      const available = await p.listModels()
      if (available.length > 0) {
        const picked = pickModelByVendorAndId(available, input.sessionModel.modelId)
        if (picked) return { provider: p, model: picked, source: 'session-selected', available }
      }
    }
  }

  // 4. fallback
  return resolveFallback(providers, input)
}

async function resolveFallback(
  providers: Map<string, ModelProvider>,
  input: ModelResolutionInput,
): Promise<ResolvedModel> {
  const defaultProviderId = vscode.workspace.getConfiguration('raptor').get<string>('defaultProvider')
  const preferredModel = input.fallbackModel ?? vscode.workspace.getConfiguration('raptor').get<string>('model', 'claude-sonnet-4.6')

  const ordered = defaultProviderId
    ? [providers.get(defaultProviderId), ...providers.values()].filter(Boolean) as ModelProvider[]
    : Array.from(providers.values())

  for (const p of ordered) {
    if (p.capability === 'unavailable') continue
    const available = await p.listModels()
    if (available.length > 0) {
      const pref = normalizeToken(preferredModel)
      const exact = available.find(m => modelTokens(m).some(v => v === pref))
      if (exact) return { provider: p, model: exact, source: 'fallback', available }

      const base = normalizeToken(preferredModel.replace(/\.\d+$/, ''))
      if (base && base !== pref) {
        const baseMatch = available.find(m => normalizeToken(m.name).startsWith(base))
        if (baseMatch) return { provider: p, model: baseMatch, source: 'fallback', available }
      }

      return { provider: p, model: available[0], source: 'fallback', available }
    }
  }

  throw new ProviderError('registry', 'no-models', 'No chat models available from any provider.')
}

export function createProviderRegistry(context: vscode.ExtensionContext): ProviderRegistry {
  const providers = new Map<string, ModelProvider>()

  return {
    register(provider) {
      providers.set(provider.id, provider)
    },

    getProvider(id) {
      return providers.get(id)
    },

    listProviders() {
      return Array.from(providers.values())
    },

    async resolve(input: ModelResolutionInput) {
      return resolveInternal(providers, input)
    },
  }
}

export { parseModelSpec }
