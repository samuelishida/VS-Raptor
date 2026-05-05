import * as vscode from 'vscode'

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  handler: vscode.ChatRequestHandler,
): void {
  const participant = vscode.chat.createChatParticipant('raptor.agent', handler)
  participant.iconPath = new vscode.ThemeIcon('robot')
  context.subscriptions.push(participant)
}