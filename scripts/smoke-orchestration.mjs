#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

async function read(relPath) {
  return readFile(path.join(repoRoot, relPath), 'utf8')
}

function ok(message) {
  console.log(`OK: ${message}`)
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

function expect(condition, message) {
  if (!condition) fail(message)
  else ok(message)
}

function parseManifest(text, filePath) {
  const lines = text.trim().split(/\r?\n/)
  return lines.slice(1).map((line, index) => {
    const [id, category, defaultInstall, targets] = line.split('\t')
    if (!id || !category || !defaultInstall || !targets) {
      throw new Error(`${filePath}:${index + 2} is malformed`)
    }
    return { id, category, defaultInstall: defaultInstall === 'true', targets }
  })
}

async function main() {
  try {
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'validate-inventory.mjs')], {
      cwd: repoRoot,
      stdio: 'pipe',
    })
    ok('inventory validation passed')
  } catch (err) {
    fail(`inventory validation failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const [skillsManifestText, agentsManifestText, loaderText, readmeText, packageText] = await Promise.all([
    read('catalog/skills.tsv'),
    read('catalog/agents.tsv'),
    read('src/config/loader.ts'),
    read('README.md'),
    read('package.json'),
  ])

  const skills = parseManifest(skillsManifestText, 'catalog/skills.tsv')
  const agents = parseManifest(agentsManifestText, 'catalog/agents.tsv')

  expect(skills.some(item => item.defaultInstall), 'default-install skills exist')
  expect(skills.every(item => ['core', 'optional', 'internal'].includes(item.category)), 'skill categories are valid')
  expect(agents.every(item => !item.defaultInstall), 'agents are not default-installed')
  expect(loaderText.includes('imports:'), 'loader exposes quarantined import metadata')
  expect(loaderText.includes('Imported config'), 'loader documents import quarantine behavior')
  expect(!loaderText.includes('incoming.agents.set(id, agent)'), 'external importer agents are not merged into runtime config')
  expect(readmeText.includes('Imported `.claude`, `.codex`, and `.opencode` config is treated as migration input'), 'README explains migration-only imports')
  expect(packageText.includes('"validate:inventory"'), 'package.json exposes inventory validation script')
  expect(packageText.includes('"smoke:orchestration"'), 'package.json exposes orchestration smoke script')

  console.log(`OK: smoke summary ${skills.length} skills / ${agents.length} agents`)

  if (process.exitCode) {
    console.error('FAIL: orchestration smoke checks did not all pass')
    process.exit(process.exitCode)
  }
}

main().catch(err => {
  console.error(`FAIL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  process.exit(1)
})
