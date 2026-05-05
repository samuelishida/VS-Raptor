import * as path from 'path'
import * as vscode from 'vscode'

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

export function resolvePath(inputPath: string): string {
  const cleaned = normalizeIncomingPath(inputPath)

  if (process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(cleaned)) {
    return path.normalize(cleaned)
  }

  if (path.isAbsolute(cleaned)) return path.normalize(cleaned)

  const root = workspaceRoot()
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