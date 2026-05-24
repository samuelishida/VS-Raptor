import * as vscode from 'vscode'

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  handler: vscode.ChatRequestHandler,
  followupProvider?: vscode.ChatFollowupProvider,
): void {
  const participant = vscode.chat.createChatParticipant('raptor', handler)
  participant.iconPath = new vscode.ThemeIcon('robot')
  if (followupProvider) {
    participant.followupProvider = followupProvider
  }
  context.subscriptions.push(participant)
}
