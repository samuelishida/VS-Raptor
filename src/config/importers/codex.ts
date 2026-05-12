import * as fs from 'fs/promises'
import * as path from 'path'
import type { Agent, Flow } from '../loader'

export interface PartialLoadedConfig {
  agents: Map<string, Agent>
  flows: Map<string, Flow>
  warnings: string[]
  sources: string[]
}

export async function loadCodexConfig(root: string): Promise<PartialLoadedConfig> {
  const result: PartialLoadedConfig = {
    agents: new Map(),
    flows: new Map(),
    warnings: [],
    sources: [],
  }

  const configPath = path.join(root, 'config.toml')
  try {
    const text = await fs.readFile(configPath, 'utf-8')
    const modelMatch = text.match(/model\s*=\s*["']([^"']+)["']/)
    
    if (modelMatch) {
      const agent: Agent = {
        id: 'codex-config',
        name: 'Codex Config',
        description: 'Model from Codex config.toml',
        model: `codex:${modelMatch[1]}`,
        source: configPath,
      }
      result.agents.set(agent.id, agent)
      result.sources.push(configPath)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.warnings.push(`Failed to load Codex config.toml: ${String(err)}`)
    }
  }

  const instructionsPath = path.join(root, 'instructions.md')
  try {
    const text = await fs.readFile(instructionsPath, 'utf-8')
    const normalized = text.replace(/\r\n/g, '\n')
    
    const agent: Agent = {
      id: 'codex-instructions',
      name: 'Codex Instructions',
      description: 'Instructions from instructions.md',
      prompt: normalized,
      model: 'codex:default',
      source: instructionsPath,
    }
    result.agents.set(agent.id, agent)
    result.sources.push(instructionsPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.warnings.push(`Failed to load Codex instructions: ${String(err)}`)
    }
  }

  return result
}
