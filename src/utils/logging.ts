import * as vscode from 'vscode'

export function summariseInput(input: unknown): string {
  const serialized = JSON.stringify(input)
  return serialized.length > 60 ? serialized.slice(0, 57) + '…' : serialized
}

export function logToOutput(
  outputChannel: vscode.OutputChannel | undefined,
  ...lines: string[]
): void {
  if (!outputChannel) return
  const timestamp = new Date().toLocaleTimeString()
  for (const line of lines) {
    outputChannel.appendLine(`[${timestamp}] ${line}`)
  }
}

export function logToolCallToOutput(
  outputChannel: vscode.OutputChannel | undefined,
  name: string,
  input: Record<string, unknown>,
  result: string,
): void {
  const inputStr = JSON.stringify(input, null, 2)
  logToOutput(
    outputChannel,
    `🔧 ${name}`,
    `   input: ${inputStr.length > 500 ? inputStr.slice(0, 500) + '…' : inputStr}`,
    `   result (${result.length} chars):`,
    result.length > 4000 ? result.slice(0, 4000) + '\n…[truncated in output log]' : result,
    '─'.repeat(60),
  )
}