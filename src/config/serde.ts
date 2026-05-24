import * as fs from 'fs/promises'
import * as path from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Agent, Flow } from './loader'

export type ConfigCollectionKind = 'agents' | 'flows'

const COLLECTION_FILES: Record<ConfigCollectionKind, string[]> = {
  agents: ['agents.yaml', 'agents.yml', 'agents.json'],
  flows: ['flows.yaml', 'flows.yml', 'flows.json'],
}

function arrayKeyFor(kind: ConfigCollectionKind): ConfigCollectionKind {
  return kind
}

async function fileMtime(p: string): Promise<number | null> {
  try {
    const stat = await fs.stat(p)
    return stat.mtimeMs
  } catch {
    return null
  }
}

export function collectionFileCandidates(kind: ConfigCollectionKind): string[] {
  return [...COLLECTION_FILES[kind]]
}

export function canonicalCollectionPath(root: string, kind: ConfigCollectionKind): string {
  return path.join(root, COLLECTION_FILES[kind][0])
}

export function legacyJsonPathFor(kind: ConfigCollectionKind): string {
  return COLLECTION_FILES[kind][COLLECTION_FILES[kind].length - 1]
}

export async function discoverConfigFile(root: string, kind: ConfigCollectionKind): Promise<string | null> {
  for (const file of collectionFileCandidates(kind)) {
    const filePath = path.join(root, file)
    if ((await fileMtime(filePath)) !== null) {
      return filePath
    }
  }
  return null
}

export async function collectCollectionSignatureEntries(
  root: string,
  kind: ConfigCollectionKind,
): Promise<string[]> {
  const entries: string[] = []
  for (const file of collectionFileCandidates(kind)) {
    const filePath = path.join(root, file)
    entries.push(`${filePath}:${(await fileMtime(filePath)) ?? 'missing'}`)
  }
  return entries
}

export interface ParsedCollection<T> {
  items: T[] | null
  warning?: string
}

export function parseCollectionFile<T>(
  text: string,
  source: string,
  kind: ConfigCollectionKind,
): ParsedCollection<T> {
  const arrayKey = arrayKeyFor(kind)

  try {
    const parsed = parseYaml(text) as unknown
    const candidate = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[arrayKey] : null)

    if (!Array.isArray(candidate)) {
      return {
        items: null,
        warning: `${source} has no recognizable array field (expected top-level array or "${arrayKey}" key).`,
      }
    }

    return { items: candidate as T[] }
  } catch (err) {
    return { items: null, warning: `Failed to parse ${source}: ${String(err)}` }
  }
}

export async function readConfigCollection<T>(
  root: string,
  kind: ConfigCollectionKind,
): Promise<{ items: T[] | null; source: string | null; warning?: string }> {
  const source = await discoverConfigFile(root, kind)
  if (!source) {
    return { items: null, source: null }
  }

  try {
    const text = await fs.readFile(source, 'utf-8')
    const parsed = parseCollectionFile<T>(text, source, kind)
    return { ...parsed, source }
  } catch (err) {
    return {
      items: null,
      source,
      warning: `Failed to read ${source}: ${String(err)}`,
    }
  }
}

function stringifyCollectionYaml<T>(items: T[]): string {
  return stringifyYaml(items, {
    indent: 2,
    lineWidth: 0,
  }).trimEnd()
}

export function serializeAgentsYaml(agents: Agent[]): string {
  return stringifyCollectionYaml(agents)
}

export function serializeFlowsYaml(flows: Flow[]): string {
  return stringifyCollectionYaml(flows)
}
