import * as path from 'path'
import * as vscode from 'vscode'
import * as fsSync from 'fs'

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

function normalizeIncomingPath(rawPath: string): string {
  let normalizedPath = rawPath.trim()

  if (
    (normalizedPath.startsWith('"') && normalizedPath.endsWith('"')) ||
    (normalizedPath.startsWith("'") && normalizedPath.endsWith("'")) ||
    (normalizedPath.startsWith('`') && normalizedPath.endsWith('`'))
  ) {
    normalizedPath = normalizedPath.slice(1, -1)
  }

  if (/^file:\/\//i.test(normalizedPath)) {
    try { normalizedPath = vscode.Uri.parse(normalizedPath).fsPath } catch { /* keep original */ }
  }

  if (process.platform === 'win32') {
    normalizedPath = normalizedPath.replace(/^\/([A-Za-z]:[\\/])/, '$1')
  }

  return normalizedPath
}

function workspaceChildPath(cleanedPath: string, root: string | undefined): string | undefined {
  if (!root) return undefined

  const normalized = cleanedPath.replace(/\\/g, '/')
  const normalizedLower = normalized.toLowerCase()
  const rootNoSlash = root.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  const workspaceDirs = ['.plans', '.raptor', '.agents', '.codex', '.claude', '.github']

  for (const dir of workspaceDirs) {
    const dirPrefix = `${dir}/`
    const slashDirPrefix = `/${dir}/`
    const nestedIdx = normalizedLower.lastIndexOf(slashDirPrefix)
    if (nestedIdx >= 0) return path.join(root, normalized.slice(nestedIdx + 1))
    if (normalizedLower === dir || normalizedLower.startsWith(dirPrefix)) return path.join(root, normalized)
    if (normalizedLower === `/${dir}` || normalizedLower.startsWith(slashDirPrefix)) return path.join(root, normalized.slice(1))
    if (normalizedLower.startsWith(`${rootNoSlash}${dirPrefix}`)) {
      return path.join(root, normalized.slice(rootNoSlash.length))
    }
  }

  return undefined
}

function isInsidePath(candidatePath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, candidatePath)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function rebaseOutsideAbsolutePath(cleanedPath: string, root: string): string | undefined {
  const normalized = cleanedPath.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  const anchors = [
    'src', 'test', 'tests', 'app', 'lib', 'packages', 'public', 'scripts',
    'config', 'configs', 'docs', 'server', 'client', 'renderer', 'database',
  ]

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i].toLowerCase()
    if (!anchors.includes(segment)) continue
    const relativeParts = parts.slice(i)
    const candidate = path.join(root, ...relativeParts)
    const anchorPath = path.join(root, relativeParts[0])
    if (fsSync.existsSync(candidate) || fsSync.existsSync(anchorPath)) return candidate
  }

  const fileAnchors = [
    'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
    'README.md', 'readme.md',
  ]
  for (let i = 0; i < parts.length; i++) {
    if (fileAnchors.includes(parts[i])) return path.join(root, ...parts.slice(i))
  }

  return undefined
}

export function resolvePath(inputPath: string): string {
  const cleaned = normalizeIncomingPath(inputPath)
  const root = workspaceRoot()

  const workspaceChild = workspaceChildPath(cleaned, root)
  if (workspaceChild) return path.normalize(workspaceChild)

  const isWinAbsolute = process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(cleaned)
  const isAbsolute = isWinAbsolute || path.isAbsolute(cleaned)
  if (isAbsolute) {
    const normalizedAbsolute = path.normalize(cleaned)
    if (!root) return normalizedAbsolute
    const normalizedRoot = path.normalize(root)
    if (isInsidePath(normalizedAbsolute, normalizedRoot)) return normalizedAbsolute

    const rebased = rebaseOutsideAbsolutePath(cleaned, normalizedRoot)
    if (rebased) return path.normalize(rebased)

    throw new Error(`Path "${cleaned}" is outside the workspace "${normalizedRoot}". Use a workspace-relative path.`)
  }

  if (root) {
    const joined = path.join(root, cleaned)
    if (cleaned !== path.basename(cleaned)) return joined
  }

  const activeFile = vscode.window.activeTextEditor?.document.fileName
  if (activeFile) {
    const wantedBase = path.basename(cleaned).toLowerCase()
    const activeBase = path.basename(activeFile).toLowerCase()
    if (wantedBase && wantedBase === activeBase) return activeFile
  }

  return root ? path.join(root, cleaned) : path.resolve(cleaned)
}

export function shortenPath(inputPath: string): string {
  const root = workspaceRoot()
  if (root) {
    const relativePath = path.relative(root, inputPath)
    if (!relativePath.startsWith('..')) return relativePath.replace(/\\/g, '/')
  }

  const parts = inputPath.replace(/\\/g, '/').split('/')
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : inputPath.replace(/\\/g, '/')
}
