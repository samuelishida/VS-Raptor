import * as fs from 'fs/promises'
import * as path from 'path'
import type { Agent, Flow } from '../loader'

export interface PartialLoadedConfig {
  agents: Map<string, Agent>
  flows: Map<string, Flow>
  warnings: string[]
  sources: string[]
}

export async function loadOpenCodeConfig(root: string): Promise<PartialLoadedConfig> {
  const result: PartialLoadedConfig = {
    agents: new Map(),
    flows: new Map(),
    warnings: [],
    sources: [],
  }

  const configPath = path.join(root, 'agents.json')
  try {
    const text = await fs.readFile(configPath, 'utf-8')
    const parsed = JSON.parse(text)
    
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'object' && item.id) {
          const agent: Agent = {
            id: String(item.id),
            name: item.name ? String(item.name) : undefined,
            description: item.description ? String(item.description) : undefined,
            prompt: item.instructions ? String(item.instructions) : undefined,
            model: item.model ? normalizeModelSpec(String(item.model)) : undefined,
            skills: Array.isArray(item.skills) ? item.skills.map(String) : undefined,
            tools: Array.isArray(item.tools) ? item.tools.map(String) : undefined,
            source: configPath,
          }
          result.agents.set(agent.id, agent)
        }
      }
      result.sources.push(configPath)
    } else if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.agents)) {
        for (const item of parsed.agents) {
          if (typeof item === 'object' && item.id) {
            const agent: Agent = {
              id: String(item.id),
              name: item.name ? String(item.name) : undefined,
              description: item.description ? String(item.description) : undefined,
              prompt: item.instructions ? String(item.instructions) : undefined,
              model: item.model ? normalizeModelSpec(String(item.model)) : undefined,
              skills: Array.isArray(item.skills) ? item.skills.map(String) : undefined,
              tools: Array.isArray(item.tools) ? item.tools.map(String) : undefined,
              source: configPath,
            }
            result.agents.set(agent.id, agent)
          }
        }
        result.sources.push(configPath)
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.warnings.push(`Failed to load OpenCode config: ${String(err)}`)
    }
  }

  return result
}

function normalizeModelSpec(spec: string): string {
  const trimmed = spec.trim()
  const colonIdx = trimmed.indexOf(':')
  if (colonIdx > 0) {
    return trimmed
  }
  return `openai:${trimmed}`
}
