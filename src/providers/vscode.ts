import * as vscode from 'vscode'
import {
  ProviderError,
  type ModelProvider,
  type RaptorModel,
  type RaptorMessage,
  type RaptorResponseEvent,
} from './types'

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
      }))
    },

    async sendRequest(
      model: RaptorModel,
      messages: RaptorMessage[],
      options: { tools?: vscode.LanguageModelChatTool[] },
      token: vscode.CancellationToken,
    ): Promise<AsyncIterable<RaptorResponseEvent>> {
      // Find the actual VS Code model object
      const vscodeModels = await vscode.lm.selectChatModels()
      const vscodeModel = vscodeModels.find(m => m.id === model.id)
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

    supportsTools(_model: RaptorModel): boolean {
      return true
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
