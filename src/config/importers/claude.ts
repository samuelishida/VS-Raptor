import * as fs from 'fs/promises'
import * as path from 'path'
import type { Agent, Flow } from '../loader'

export interface PartialLoadedConfig {
  agents: Map<string, Agent>
  flows: Map<string, Flow>
  warnings: string[]
  sources: string[]
}

export async function loadClaudeConfig(root: string): Promise<PartialLoadedConfig> {
  const result: PartialLoadedConfig = {
    agents: new Map(),
    flows: new Map(),
    warnings: [],
    sources: [],
  }

  const claudeMdPath = path.join(root, 'CLAUDE.md')
  try {
    const text = await fs.readFile(claudeMdPath, 'utf-8')
    const normalized = text.replace(/\r\n/g, '\n')
    
    const agent: Agent = {
      id: 'claude-md',
      name: 'CLAUDE.md Instructions',
      description: 'Instructions from CLAUDE.md file',
      prompt: normalized,
      model: 'claude-code:default',
      source: claudeMdPath,
    }
    result.agents.set(agent.id, agent)
    result.sources.push(claudeMdPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.warnings.push(`Failed to load CLAUDE.md: ${String(err)}`)
    }
  }

  const configPath = path.join(root, 'settings.json')
  try {
    const text = await fs.readFile(configPath, 'utf-8')
    const parsed = JSON.parse(text)
    
    if (parsed && typeof parsed === 'object') {
      if (parsed.model) {
        const agent: Agent = {
          id: 'claude-settings',
          name: 'Claude Settings',
          description: 'Model from Claude settings',
          model: `claude-code:${String(parsed.model)}`,
          source: configPath,
        }
        result.agents.set(agent.id, agent)
        result.sources.push(configPath)
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.warnings.push(`Failed to load Claude settings: ${String(err)}`)
    }
  }

  return result
}
