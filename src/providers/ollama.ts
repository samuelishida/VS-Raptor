import * as vscode from 'vscode'
import {
  ProviderError,
  type ModelProvider,
  type RaptorModel,
  type RaptorMessage,
  type RaptorResponseEvent,
} from './types'

interface OllamaConfig {
  baseUrl: string
}

export function createOllamaProvider(config: OllamaConfig): ModelProvider {
  const baseUrl = config.baseUrl || 'http://localhost:11434'

  return {
    id: 'ollama',
    name: 'Ollama',
    capability: 'native-text' as const,
    acceptsArbitraryModel: false,

    async listModels(): Promise<RaptorModel[]> {
      try {
        const response = await fetch(`${baseUrl}/api/tags`)
        if (!response.ok) return []
        const data = await response.json() as { models: Array<{ name: string; model: string }> }
        return data.models.map(m => ({
          id: m.name,
          name: m.name,
          providerId: 'ollama',
        }))
      } catch {
        return []
      }
    },

    async sendRequest(
      model: RaptorModel,
      messages: RaptorMessage[],
      options: { tools?: vscode.LanguageModelChatTool[] },
      token: vscode.CancellationToken,
    ): Promise<AsyncIterable<RaptorResponseEvent>> {
      const url = `${baseUrl}/api/chat`
      const body = buildRequestBody(model, messages)

      const controller = new AbortController()
      token.onCancellationRequested(() => controller.abort())

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const error = await response.text().catch(() => 'Unknown error')
        throw new ProviderError('ollama', `http-${response.status}`, `Ollama API error: ${error}`)
      }

      return streamResponse(response.body)
    },

    supportsTools() { return false }, // Ollama tool support varies by model
  }
}

function buildRequestBody(
  model: RaptorModel,
  messages: RaptorMessage[],
): Record<string, unknown> {
  const ollamaMessages = messages.map(m => {
    // Ollama expects system as first message
    if (m.role === 'system') {
      return {
        role: 'system',
        content: m.content.filter(c => c.type === 'text').map(c => c.value).join(''),
      }
    }
    return {
      role: m.role,
      content: m.content.map(c => {
        if (c.type === 'text') return c.value
        if (c.type === 'tool_call') return `[tool_call: ${c.name}]`
        if (c.type === 'tool_result') return c.content.map(tc => tc.value).join('')
        return ''
      }).join(''),
    }
  })

  return {
    model: model.id,
    messages: ollamaMessages,
    stream: true,
  }
}

async function* streamResponse(body: ReadableStream<Uint8Array> | null): AsyncIterable<RaptorResponseEvent> {
  if (!body) return

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const chunk = JSON.parse(line)
        if (chunk.message?.content) {
          yield { type: 'text', value: chunk.message.content }
        }
      } catch { /* ignore parse errors */ }
    }
  }
}
