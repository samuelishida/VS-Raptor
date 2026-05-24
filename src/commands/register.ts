import * as vscode from 'vscode'

export function registerCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('raptor.openPanel', () => {
      void vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus')
    }),
  )
}
