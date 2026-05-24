import type { Agent, ImportedConfig } from '../loader'
import { readConfigCollection } from '../serde'

export async function loadOpenCodeConfig(root: string): Promise<ImportedConfig> {
  const result: ImportedConfig = {
    origin: 'opencode',
    sources: [],
    agents: [],
    flows: [],
    warnings: [],
  }

  const config = await readConfigCollection<unknown>(root, 'agents')
  if (config.warning) {
    result.warnings.push(`OpenCode config: ${config.warning}`)
  }

  if (config.items && config.source) {
    for (const item of config.items) {
      if (typeof item === 'object' && item && 'id' in item) {
        const raw = item as Record<string, unknown>
        if (!raw.id) continue
        const agent: Agent = {
          id: String(raw.id),
          name: typeof raw.name === 'string' ? raw.name : undefined,
          description: typeof raw.description === 'string' ? raw.description : undefined,
          prompt: typeof raw.instructions === 'string' ? raw.instructions : undefined,
          model: typeof raw.model === 'string' ? normalizeModelSpec(raw.model) : undefined,
          skills: Array.isArray(raw.skills) ? raw.skills.map(String) : undefined,
          tools: Array.isArray(raw.tools) ? raw.tools.map(String) : undefined,
          source: config.source,
        }
        result.agents.push(agent)
      }
    }
    result.sources.push(config.source)
  }

  return result
}

function normalizeModelSpec(spec: string): string {
  const trimmed = spec.trim()
  const colonIdx = trimmed.indexOf(':')
  if (colonIdx > 0) {
    return trimmed
  }
  return `opencode:${trimmed}`
}
