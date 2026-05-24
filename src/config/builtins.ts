// Built-in config is intentionally empty now.
// Raptor's runtime should rely on normal installed skills and agents.

import { Skill, type ImportedConfig } from './loader'

/**
 * The extension no longer ships private built-in skill content.
 * Workspace and user-installed config fully own the skill surface.
 */
export function getBuiltinConfig(): {
  skills: Map<string, Skill>
  agents: Map<string, any>
  flows: Map<string, any>
  imports: ImportedConfig[]
  warnings: string[]
  sources: string[]
  signature?: string
} {
  return {
    skills: new Map<string, Skill>(),
    agents: new Map(),
    flows: new Map(),
    imports: [],
    warnings: [],
    sources: [],
  }
}
