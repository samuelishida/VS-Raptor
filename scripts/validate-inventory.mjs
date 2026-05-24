#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

function parseTsv(text, filePath) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) {
    throw new Error(`${filePath} must contain a header and at least one entry`)
  }
  const header = lines[0].split('\t')
  const expectedHeader = ['id', 'category', 'default_install', 'targets']
  if (header.join('\t') !== expectedHeader.join('\t')) {
    throw new Error(`${filePath} header must be "${expectedHeader.join('\t')}"`)
  }
  return lines.slice(1).map((line, index) => {
    const parts = line.split('\t')
    if (parts.length !== 4) {
      throw new Error(`${filePath}:${index + 2} must have 4 tab-separated columns`)
    }
    const [id, category, defaultInstall, targets] = parts.map(part => part.trim())
    if (!id) throw new Error(`${filePath}:${index + 2} is missing an id`)
    if (!['core', 'optional', 'internal'].includes(category)) {
      throw new Error(`${filePath}:${index + 2} has invalid category "${category}"`)
    }
    if (!['true', 'false'].includes(defaultInstall)) {
      throw new Error(`${filePath}:${index + 2} has invalid default_install "${defaultInstall}"`)
    }
    if (!targets) {
      throw new Error(`${filePath}:${index + 2} is missing targets`)
    }
    return {
      id,
      category,
      defaultInstall: defaultInstall === 'true',
      targets: targets.split(',').map(value => value.trim()).filter(Boolean),
    }
  })
}

async function readManifest(kind) {
  const filePath = path.join(repoRoot, 'catalog', `${kind}.tsv`)
  const text = await readFile(filePath, 'utf8')
  return parseTsv(text, filePath)
}

function listRepoEntries(kind) {
  const root = path.join(repoRoot, kind)
  return []
}

async function collectFilesystemIds(kind) {
  const fs = await import('node:fs/promises')
  const entries = []
  const root = path.join(repoRoot, kind)
  try {
    for (const dirent of await fs.readdir(root, { withFileTypes: true })) {
      if (kind === 'skills') {
        if (!dirent.isDirectory()) continue
        const skillPath = path.join(root, dirent.name, 'SKILL.md')
        try {
          await fs.stat(skillPath)
          entries.push(dirent.name)
        } catch {}
      } else if (kind === 'agents') {
        if (dirent.isFile() && dirent.name.endsWith('.md')) {
          entries.push(dirent.name.replace(/\.md$/, ''))
        }
      }
    }
  } catch (err) {
    throw new Error(`Failed to read ${root}: ${String(err)}`)
  }
  return entries.sort()
}

function compareSets(manifestItems, filesystemItems, kind) {
  const manifestIds = new Set(manifestItems.map(item => item.id))
  const fsIds = new Set(filesystemItems)
  const missingInManifest = filesystemItems.filter(id => !manifestIds.has(id))
  const missingOnDisk = manifestItems.filter(item => !fsIds.has(item.id))

  if (missingInManifest.length || missingOnDisk.length) {
    const parts = []
    if (missingInManifest.length) parts.push(`missing from ${kind}.tsv: ${missingInManifest.join(', ')}`)
    if (missingOnDisk.length) parts.push(`missing from ${kind}/: ${missingOnDisk.map(item => item.id).join(', ')}`)
    throw new Error(parts.join('; '))
  }
}

async function main() {
  const skillsManifest = await readManifest('skills')
  const agentsManifest = await readManifest('agents')
  const skillsFs = await collectFilesystemIds('skills')
  const agentsFs = await collectFilesystemIds('agents')

  compareSets(skillsManifest, skillsFs, 'skills')
  compareSets(agentsManifest, agentsFs, 'agents')

  const invalidDefaultSkills = skillsManifest.filter(item => item.defaultInstall && item.category !== 'core')
  const invalidDefaultAgents = agentsManifest.filter(item => item.defaultInstall)
  if (invalidDefaultSkills.length) {
    throw new Error(`non-core skills marked default_install=true: ${invalidDefaultSkills.map(item => item.id).join(', ')}`)
  }
  if (invalidDefaultAgents.length) {
    throw new Error(`agents must not default-install: ${invalidDefaultAgents.map(item => item.id).join(', ')}`)
  }

  console.log(`OK: validated ${skillsManifest.length} skills and ${agentsManifest.length} agents`)
}

main().catch(err => {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
