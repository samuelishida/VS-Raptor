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
    capability: 'native-tools' as const,
    acceptsArbitraryModel: false,

    async listModels(): Promise<RaptorModel[]> {
      try {
        const response = await fetch(`${baseUrl}/api/tags`)
        if (!response.ok) return []
        const data = await response.json() as { models: Array<{ name: string; model: string }> }
        return await Promise.all(data.models.map(async m => ({
          id: m.name,
          name: m.name,
          providerId: 'ollama',
          maxInputTokens: await getOllamaContextLength(baseUrl, m.name),
        })))
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
      const body = buildRequestBody(model, messages, options.tools)

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

    supportsTools() { return true },
  }
}

async function getOllamaContextLength(baseUrl: string, model: string): Promise<number | undefined> {
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })
    if (!response.ok) return undefined
    const data = await response.json() as {
      parameters?: string
      model_info?: Record<string, unknown>
    }

    const numCtxMatch = data.parameters?.match(/(?:^|\n)\s*num_ctx\s+(\d+)/i)
    if (numCtxMatch) return Number(numCtxMatch[1])

    const contextEntry = Object.entries(data.model_info ?? {})
      .find(([key, value]) => key.endsWith('.context_length') && typeof value === 'number')
    return typeof contextEntry?.[1] === 'number' ? contextEntry[1] : undefined
  } catch {
    return undefined
  }
}

interface OllamaMessage {
  role: string
  content: string
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
}

function buildRequestBody(
  model: RaptorModel,
  messages: RaptorMessage[],
  tools?: vscode.LanguageModelChatTool[],
): Record<string, unknown> {
  const ollamaMessages: OllamaMessage[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      ollamaMessages.push({
        role: 'system',
        content: m.content.filter(c => c.type === 'text').map(c => c.value).join(''),
      })
      continue
    }

    const toolResultParts = m.content.filter(c => c.type === 'tool_result')
    const toolCallParts = m.content.filter(c => c.type === 'tool_call')
    const textParts = m.content.filter(c => c.type === 'text')

    // Tool results become role: 'tool' messages (one per result)
    if (toolResultParts.length > 0) {
      for (const tr of toolResultParts) {
        if (tr.type !== 'tool_result') continue
        ollamaMessages.push({
          role: 'tool',
          content: tr.content.map(c => c.value).join(''),
        })
      }
      continue
    }

    // Assistant messages with tool calls
    if (m.role === 'assistant' && toolCallParts.length > 0) {
      ollamaMessages.push({
        role: 'assistant',
        content: textParts.map(c => c.value).join(''),
        tool_calls: toolCallParts
          .filter((c): c is Extract<typeof c, { type: 'tool_call' }> => c.type === 'tool_call')
          .map(c => ({
            function: { name: c.name, arguments: c.input },
          })),
      })
      continue
    }

    // Normal user/assistant text messages
    ollamaMessages.push({
      role: m.role,
      content: textParts.map(c => c.value).join(''),
    })
  }

  const body: Record<string, unknown> = {
    model: model.id,
    messages: ollamaMessages,
    stream: true,
  }
  if (model.maxInputTokens) {
    body.options = { num_ctx: model.maxInputTokens }
  }

  if (tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))
  }

  return body
}

interface OllamaChunk {
  message?: {
    content?: string
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
  }
  done?: boolean
}

async function* streamResponse(body: ReadableStream<Uint8Array> | null): AsyncIterable<RaptorResponseEvent> {
  if (!body) return

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let tcCounter = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const chunk = JSON.parse(line) as OllamaChunk
        if (chunk.message?.content != null) {
          yield { type: 'text', value: chunk.message.content }
        }
        // Ollama only sends tool_calls in the final done:true chunk
        if (chunk.done && chunk.message?.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            const name = tc.function?.name
            if (!name) continue
            yield {
              type: 'tool_call',
              callId: `ollama_tc_${tcCounter++}`,
              name,
              input: tc.function?.arguments ?? {},
            }
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }
}
