import * as fs from 'fs/promises'
import * as path from 'path'
import { workspaceRoot } from '../utils/paths'
import { loadOpenCodeConfig } from './importers/opencode'
import { loadClaudeConfig } from './importers/claude'
import { loadCodexConfig } from './importers/codex'

// ─── Public types ────────────────────────────────────────────────────────────

export interface Skill {
  id: string
  content: string
  source: string
}

export interface Agent {
  id: string
  name?: string
  description?: string
  prompt?: string
  skills?: string[]
  tools?: string[] | null
  model?: string
  source?: string
}

export interface FlowStep {
  agent: string
  instruction: string
  model?: string
  skills?: string[]
  tools?: string[]
  summaryBudget?: number
}

export interface Flow {
  id: string
  name?: string
  description?: string
  steps: FlowStep[]
  source?: string
}

export interface LoadedConfig {
  skills: Map<string, Skill>
  agents: Map<string, Agent>
  flows: Map<string, Flow>
  warnings: string[]
  sources: string[]
}

// ─── Constants ───────────────────────────────────────────────────────────────

const WORKSPACE_ROOT_NAMES = ['.raptor', '.opencode', '.claude', '.codex', '.github'] as const
const SKILL_FILE = 'skills.md'
const AGENTS_FILE = 'agents.json'
const FLOWS_FILE = 'flows.json'

// ─── Config cache with signature-based freshness tracking ──────────────

interface CacheEntry {
  signature: string
  data: LoadedConfig
}

let configCache: CacheEntry | null = null

function raptorDataDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || require('os').homedir()
  return path.join(home || require('os').tmpdir(), '.raptor')
}

// ─── Discovery ─────────────────────────────────────────────────────────────────

function discoverConfigRoots(): string[] {
  const roots: string[] = [raptorDataDir()]

  const ws = workspaceRoot()
  if (ws) {
    // Merge order is low to high precedence so workspace-local config wins over
    // broader defaults.
    for (const name of [...WORKSPACE_ROOT_NAMES].reverse()) {
      roots.push(path.join(ws, name))
    }
  }
  return roots
}

// ─── File loading helpers ──────────────────────────────────────────────────────

async function fileMtime(p: string): Promise<number | null> {
  try {
    const stat = await fs.stat(p)
    return stat.mtimeMs
  } catch {
    return null
  }
}

async function collectSkillSignatureEntries(skillsDir: string): Promise<string[]> {
  const entriesForSignature: string[] = []
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillPath = path.join(skillsDir, entry.name, 'SKILL.md')
      const m = await fileMtime(skillPath)
      entriesForSignature.push(`${skillPath}:${m ?? 'missing'}`)
    }
  } catch {
    entriesForSignature.push(`${skillsDir}:missing`)
  }
  return entriesForSignature
}

async function computeConfigSignature(roots: string[]): Promise<string> {
  const entries: string[] = []

  for (const root of roots) {
    for (const file of [SKILL_FILE, AGENTS_FILE, FLOWS_FILE]) {
      const filePath = path.join(root, file)
      entries.push(`${filePath}:${await fileMtime(filePath) ?? 'missing'}`)
    }
    entries.push(...await collectSkillSignatureEntries(path.join(root, 'skills')))
  }

  const ws = workspaceRoot()
  if (ws) {
    entries.push(...await collectSkillSignatureEntries(path.join(ws, 'skills')))
  }

  return JSON.stringify(entries.sort())
}

async function readJsonFile<T>(
  p: string,
  label: string,
  arrayKey: 'agents' | 'flows',
): Promise<{ data: T | null; warning?: string }> {
  try {
    const text = await fs.readFile(p, 'utf-8')
    const parsed = JSON.parse(text)
    // Support both { agents: [...] } / { flows: [...] } and top-level array shapes.
    const arr = Array.isArray(parsed) ? parsed : parsed?.[arrayKey] ?? null
    if (arr === null) {
      return { data: null, warning: `${label} has no recognizable array field (expected top-level array or "${arrayKey}" key).` }
    }
    return { data: arr as T }
  } catch (err) {
    return { data: null, warning: `Failed to parse ${label}: ${String(err)}` }
  }
}

// ─── SKILL.md helpers ────────────────────────────────────────────────────────

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== '---') return { meta: {}, body: normalized }
  const endIdx = lines.indexOf('---', 1)
  if (endIdx === -1) return { meta: {}, body: normalized }
  const meta: Record<string, string> = {}
  for (const line of lines.slice(1, endIdx)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/)
    if (m) meta[m[1]] = m[2].trim()
  }
  return { meta, body: lines.slice(endIdx + 1).join('\n').trimStart() }
}

async function loadSkillFiles(skillsDir: string): Promise<Skill[]> {
  const skills: Skill[] = []
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillPath = path.join(skillsDir, entry.name, 'SKILL.md')
      try {
        const text = await fs.readFile(skillPath, 'utf-8')
        const { meta, body } = parseFrontmatter(text)
        const id = (meta['name'] ?? entry.name).trim()
        if (id) skills.push({ id, content: body, source: skillPath })
      } catch { /* not found */ }
    }
  } catch { /* dir not found */ }
  return skills
}

// ─── Skill parser ────────────────────────────────────────────────────────────

function parseSkillsFile(text: string, source: string): { skills: Skill[]; warning?: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const skills: Skill[] = []
  let currentId: string | null = null
  let currentLines: string[] = []

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/)
    if (headingMatch) {
      if (currentId !== null) {
        skills.push({ id: currentId, content: currentLines.join('\n').trimEnd(), source })
      }
      currentId = headingMatch[1].trim()
      currentLines = []
    } else if (currentId !== null) {
      currentLines.push(line)
    }
  }

  if (currentId !== null) {
    skills.push({ id: currentId, content: currentLines.join('\n').trimEnd(), source })
  }

  if (skills.length === 0) {
    return { skills, warning: `No skills found in ${source} (expected ## <skill-id> headings).` }
  }

  return { skills }
}

// ─── Agent / Flow normalizers ────────────────────────────────────────────────

function normalizeAgent(raw: unknown, source: string): { agent: Agent | null; warning?: string } {
  if (!raw || typeof raw !== 'object') {
    return { agent: null, warning: `Non-object agent entry in ${source}.` }
  }
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!id) {
    return { agent: null, warning: `Agent entry missing "id" in ${source}.` }
  }
  const agent: Agent = {
    id,
    name: typeof r.name === 'string' ? r.name : undefined,
    description: typeof r.description === 'string' ? r.description : undefined,
    prompt: typeof r.prompt === 'string' ? r.prompt : undefined,
    skills: Array.isArray(r.skills) ? r.skills.filter((s): s is string => typeof s === 'string') : undefined,
    tools: Array.isArray(r.tools)
      ? r.tools.filter((s): s is string => typeof s === 'string')
      : r.tools === null
        ? null
        : undefined,
    model: typeof r.model === 'string' ? r.model : undefined,
  }
  return { agent }
}

function normalizeFlow(raw: unknown, source: string): { flow: Flow | null; warning?: string } {
  if (!raw || typeof raw !== 'object') {
    return { flow: null, warning: `Non-object flow entry in ${source}.` }
  }
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!id) {
    return { flow: null, warning: `Flow entry missing "id" in ${source}.` }
  }
  const rawSteps = Array.isArray(r.steps) ? r.steps : []
  const steps: FlowStep[] = []
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object') continue
    const rs = s as Record<string, unknown>
    const agent = typeof rs.agent === 'string' ? rs.agent : ''
    if (!agent) {
      return { flow: null, warning: `Flow "${id}" has a step missing "agent" in ${source}.` }
    }
    steps.push({
      agent,
      instruction: typeof rs.instruction === 'string' ? rs.instruction : '',
      model: typeof rs.model === 'string' ? rs.model : undefined,
      skills: Array.isArray(rs.skills) ? rs.skills.filter((x): x is string => typeof x === 'string') : undefined,
      tools: Array.isArray(rs.tools) ? rs.tools.filter((x): x is string => typeof x === 'string') : undefined,
      summaryBudget: typeof rs.summaryBudget === 'number' ? rs.summaryBudget : undefined,
    })
  }
  const flow: Flow = {
    id,
    name: typeof r.name === 'string' ? r.name : undefined,
    description: typeof r.description === 'string' ? r.description : undefined,
    steps,
  }
  return { flow }
}

// ─── Merge / dedupe ───────────────────────────────────────────────────────────

function mergeConfigs(
  base: LoadedConfig,
  incoming: LoadedConfig,
): LoadedConfig {
  const merged: LoadedConfig = {
    skills: new Map(base.skills),
    agents: new Map(base.agents),
    flows: new Map(base.flows),
    warnings: [...base.warnings, ...incoming.warnings],
    sources: [...base.sources, ...incoming.sources],
  }

  for (const [id, skill] of incoming.skills) {
    if (merged.skills.has(id)) {
      merged.warnings.push(`Skill "${id}" overridden by ${skill.source}`)
    }
    merged.skills.set(id, skill)
  }

  for (const [id, agent] of incoming.agents) {
    if (merged.agents.has(id)) {
      merged.warnings.push(`Agent "${id}" overridden by ${agent.source}`)
    }
    merged.agents.set(id, agent)
  }

  for (const [id, flow] of incoming.flows) {
    if (merged.flows.has(id)) {
      merged.warnings.push(`Flow "${id}" overridden by ${flow.source}`)
    }
    merged.flows.set(id, flow)
  }

  return merged
}

// ─── Default fallback ─────────────────────────────────────────────────────────

function ensureDefaultAgent(config: LoadedConfig): void {
  if (!config.agents.has('_default')) {
    const orchestratorSkills = ['raptor', 'agent-flow-builder'].filter(id => config.skills.has(id))
    config.agents.set('_default', {
      id: '_default',
      name: 'Raptor',
      description: 'Agent orchestrator - routes tasks to specialist skills and builds agent flows',
      prompt: orchestratorSkills.length > 0
        ? `You are Raptor, an agent orchestrator. Route tasks through the loaded skills (${orchestratorSkills.join(', ')}) and help users build custom agent flows when asked.`
        : '',
      skills: orchestratorSkills,
      tools: null,
    })
  }
}

// ─── Main loader ─────────────────────────────────────────────────────────────

import { getBuiltinConfig } from './builtins'

export async function loadConfig(): Promise<LoadedConfig> {
  const builtinStart = getBuiltinConfig()

  const roots = discoverConfigRoots()
  // Merge builtins at lowest precedence before any config roots
  let merged: LoadedConfig = {
    skills: new Map(builtinStart.skills),
    agents: new Map(builtinStart.agents),
    flows: new Map(builtinStart.flows),
    warnings: [...builtinStart.warnings],
    sources: [...builtinStart.sources],
  }

  for (const root of roots) {
    const skillPath = path.join(root, SKILL_FILE)
    const agentsPath = path.join(root, AGENTS_FILE)
    const flowsPath = path.join(root, FLOWS_FILE)

    const mtimeSkill = await fileMtime(skillPath)
    const mtimeAgents = await fileMtime(agentsPath)
    const mtimeFlows = await fileMtime(flowsPath)

    const incoming: LoadedConfig = {
      skills: new Map(),
      agents: new Map(),
      flows: new Map(),
      warnings: [],
      sources: [],
    }

    if (mtimeSkill !== null) {
      try {
        const text = await fs.readFile(skillPath, 'utf-8')
        const parsed = parseSkillsFile(text, skillPath)
        if (parsed.warning) incoming.warnings.push(parsed.warning)
        for (const skill of parsed.skills) {
          incoming.skills.set(skill.id, skill)
        }
        incoming.sources.push(skillPath)
      } catch (err) {
        incoming.warnings.push(`Error reading ${skillPath}: ${String(err)}`)
      }
    }

    if (mtimeAgents !== null) {
      const result = await readJsonFile<unknown[]>(agentsPath, AGENTS_FILE, 'agents')
      if (result.warning) incoming.warnings.push(result.warning)
      if (result.data) {
        for (const raw of result.data) {
          const { agent, warning } = normalizeAgent(raw, agentsPath)
          if (warning) incoming.warnings.push(warning)
          if (agent) incoming.agents.set(agent.id, { ...agent, source: agentsPath } as Agent)
        }
        incoming.sources.push(agentsPath)
      }
    }

    if (mtimeFlows !== null) {
      const result = await readJsonFile<unknown[]>(flowsPath, FLOWS_FILE, 'flows')
      if (result.warning) incoming.warnings.push(result.warning)
      if (result.data) {
        for (const raw of result.data) {
          const { flow, warning } = normalizeFlow(raw, flowsPath)
          if (warning) incoming.warnings.push(warning)
          if (flow) incoming.flows.set(flow.id, { ...flow, source: flowsPath } as Flow)
        }
        incoming.sources.push(flowsPath)
      }
    }

    // Load SKILL.md files from <root>/skills/*/SKILL.md
    const rootSkillFiles = await loadSkillFiles(path.join(root, 'skills'))
    for (const skill of rootSkillFiles) {
      incoming.skills.set(skill.id, skill)
    }

    // Load external config importers
    const rootName = path.basename(root)
    if (rootName === '.opencode') {
      const external = await loadOpenCodeConfig(root)
      for (const [id, agent] of external.agents) incoming.agents.set(id, agent)
      for (const [id, flow] of external.flows) incoming.flows.set(id, flow)
      incoming.warnings.push(...external.warnings)
      incoming.sources.push(...external.sources)
    } else if (rootName === '.claude') {
      const external = await loadClaudeConfig(root)
      for (const [id, agent] of external.agents) incoming.agents.set(id, agent)
      for (const [id, flow] of external.flows) incoming.flows.set(id, flow)
      incoming.warnings.push(...external.warnings)
      incoming.sources.push(...external.sources)
    } else if (rootName === '.codex') {
      const external = await loadCodexConfig(root)
      for (const [id, agent] of external.agents) incoming.agents.set(id, agent)
      for (const [id, flow] of external.flows) incoming.flows.set(id, flow)
      incoming.warnings.push(...external.warnings)
      incoming.sources.push(...external.sources)
    }

    merged = mergeConfigs(merged, incoming)
  }

  // Scan the workspace root's own skills/ directory (for repos that ship SKILL.md files
  // alongside code). Config root entries take precedence — only fill gaps here.
  const ws = workspaceRoot()
  if (ws) {
    const wsSkills = await loadSkillFiles(path.join(ws, 'skills'))
    for (const skill of wsSkills) {
      if (!merged.skills.has(skill.id)) {
        merged.skills.set(skill.id, skill)
        merged.sources.push(skill.source)
      }
    }
  }

  ensureDefaultAgent(merged)

  configCache = { signature: await computeConfigSignature(roots), data: merged }
  return merged
}

/** Invalidate the in-memory config cache so the next call re-reads from disk. */
export function invalidateConfigCache(): void {
  configCache = null
}

/** Return cached config if still fresh (same max mtime), otherwise reload. */
export async function getConfig(): Promise<LoadedConfig> {
  const roots = discoverConfigRoots()
  const signature = await computeConfigSignature(roots)

  if (configCache && configCache.signature === signature) {
    return configCache.data
  }

  return loadConfig()
}

// ─── Helpers for consumers ───────────────────────────────────────────────────

export function getSkillContent(skills: Map<string, Skill>, ids: string[]): string {
  const parts: string[] = []
  for (const id of ids) {
    const skill = skills.get(id)
    if (skill) {
      parts.push(`# Skill: ${skill.id}\n${skill.content}`)
    }
  }
  return parts.join('\n\n')
}

export function filterToolsByAgent(
  allTools: string[],
  agentTools: string[] | null | undefined,
): string[] {
  if (agentTools === null || agentTools === undefined) return allTools
  return allTools.filter(t => agentTools.includes(t))
}
