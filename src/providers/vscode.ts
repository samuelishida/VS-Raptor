import * as vscode from 'vscode'
import {
  ProviderError,
  type ModelProvider,
  type RaptorModel,
  type RaptorMessage,
  type RaptorResponseEvent,
} from './types'

// Store the current handler's chat model so sendRequest uses the exact
// LanguageModelChat object VS Code provided for this invocation. For /flow
// --chat, this is the model selected in the user's chat picker.
let activeSessionModel: vscode.LanguageModelChat | undefined

export function setVSCodeSessionModel(model: vscode.LanguageModelChat | undefined): void {
  activeSessionModel = model
}

export function createVSCodeProvider(): ModelProvider {
  return {
    id: 'vscode',
    name: 'VS Code Language Model',
    capability: 'native-tools' as const,
    acceptsArbitraryModel: false,

    async listModels(): Promise<RaptorModel[]> {
      const models = await vscode.lm.selectChatModels()
      return models.map(m => ({
        id: m.id,
        name: m.name,
        providerId: 'vscode',
        supportsTools: true,
        maxInputTokens: m.maxInputTokens,
      }))
    },

    async sendRequest(
      model: RaptorModel,
      messages: RaptorMessage[],
      options: { tools?: vscode.LanguageModelChatTool[] },
      token: vscode.CancellationToken,
    ): Promise<AsyncIterable<RaptorResponseEvent>> {
      // Prefer the stored session model (request.model from the active handler).
      // Fall back to ID lookup only when no session model is set.
      let vscodeModel: vscode.LanguageModelChat | undefined = activeSessionModel
      if (!vscodeModel) {
        const vscodeModels = await vscode.lm.selectChatModels()
        vscodeModel = vscodeModels.find(m => m.id === model.id)
      }
      if (!vscodeModel) {
        throw new ProviderError('vscode', 'model-not-found', `VS Code model "${model.id}" is no longer available.`)
      }

      const vsMessages = messages.map(m => convertToVSCodeMessage(m))
      try {
        const response = await vscodeModel.sendRequest(vsMessages, { tools: options.tools }, token)
        return streamAdapter(response)
      } catch (err) {
        throw new ProviderError('vscode', 'sendRequest-failed', String(err))
      }
    },

    supportsTools(model: RaptorModel): boolean {
      return model.supportsTools === true
    },
  }
}

function convertToVSCodeMessage(msg: RaptorMessage): vscode.LanguageModelChatMessage {
  const parts: vscode.LanguageModelInputPart[] = msg.content.map(part => {
    if (part.type === 'text') return new vscode.LanguageModelTextPart(part.value)
    if (part.type === 'tool_call') return new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input)
    if (part.type === 'tool_result') {
      return new vscode.LanguageModelToolResultPart(
        part.callId,
        part.content.map(c => new vscode.LanguageModelTextPart(c.value)),
      )
    }
    return new vscode.LanguageModelTextPart('')
  })

  let role: vscode.LanguageModelChatMessageRole = vscode.LanguageModelChatMessageRole.Assistant
  if (msg.role === 'user') role = vscode.LanguageModelChatMessageRole.User
  else if (msg.role === 'system') role = vscode.LanguageModelChatMessageRole.User

  return new vscode.LanguageModelChatMessage(role, parts)
}

async function* streamAdapter(
  response: vscode.LanguageModelChatResponse,
): AsyncIterable<RaptorResponseEvent> {
  for await (const part of response.stream) {
    if (part instanceof vscode.LanguageModelTextPart) {
      yield { type: 'text', value: part.value }
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      yield { type: 'tool_call', callId: part.callId, name: part.name, input: part.input as Record<string, unknown> }
    }
  }
}
