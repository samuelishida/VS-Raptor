import * as vscode from 'vscode'

interface RegisterCommandsOptions {
  workspaceRoot: () => string | undefined
  pushSteering: (message: string) => void
}

export function registerCommands(
  context: vscode.ExtensionContext,
  options: RegisterCommandsOptions,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('raptor.openPanel', () => {
      void vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus')
    }),

    vscode.commands.registerCommand('raptor.runInTerminal', () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      const selection = editor.document.getText(editor.selection)
      if (!selection.trim()) return

      let terminal = vscode.window.terminals.find((item: vscode.Terminal) => item.name === 'raptor')
      if (!terminal) {
        terminal = vscode.window.createTerminal({ name: 'raptor', cwd: options.workspaceRoot() })
      }
      terminal.show()
      terminal.sendText(selection)
    }),

    vscode.commands.registerCommand('raptor.steer', async () => {
      const message = await vscode.window.showInputBox({
        prompt: 'Steer the running @raptor agent (guidance injected on next iteration)',
        placeHolder: 'e.g. "skip the tests, just fix the compile error first"',
      })
      if (message?.trim()) {
        const trimmed = message.trim()
        options.pushSteering(trimmed)
        vscode.window.showInformationMessage(`raptor: steering queued -- "${trimmed.slice(0, 60)}"`)
      }
    }),
  )
}