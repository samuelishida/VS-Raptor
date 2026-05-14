import * as vscode from 'vscode'
import {
  ProviderError,
  type ModelProvider,
  type RaptorModel,
  type RaptorMessage,
  type RaptorResponseEvent,
  type RaptorTextPart,
  type RaptorToolCallPart,
  type RaptorToolResultPart,
} from './types'

interface OpenRouterConfig {
  apiKey: string
  baseUrl?: string
}

export function createOpenRouterProvider(config: OpenRouterConfig): ModelProvider {
  const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return {
      id: 'openrouter',
      name: 'OpenRouter (disabled - no API key)',
      capability: 'unavailable' as const,
      acceptsArbitraryModel: false,
      async listModels() { return [] },
      async sendRequest() { throw new ProviderError('openrouter', 'no-api-key', 'OpenRouter API key not configured') },
    supportsTools(_model: RaptorModel): boolean {
      return true
    },
    }
  }

  const baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1'

  return {
    id: 'openrouter',
    name: 'OpenRouter',
    capability: 'native-tools' as const,
    acceptsArbitraryModel: false,

    async listModels(): Promise<RaptorModel[]> {
      try {
        const response = await fetch(`${baseUrl}/models`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        })
        if (response.ok) {
          const data = await response.json() as {
            data?: Array<{ id: string; name?: string; context_length?: number }>
          }
          const models = data.data?.map(m => ({
            id: m.id,
            name: m.name ?? m.id,
            providerId: 'openrouter',
            maxInputTokens: typeof m.context_length === 'number' ? m.context_length : undefined,
          })) ?? []
          if (models.length > 0) return models
        }
      } catch { /* fall back to static list */ }

      return [
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', providerId: 'openrouter', maxInputTokens: 200_000 },
        { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', providerId: 'openrouter', maxInputTokens: 200_000 },
        { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo', providerId: 'openrouter', maxInputTokens: 128_000 },
        { id: 'openai/gpt-4o', name: 'GPT-4o', providerId: 'openrouter', maxInputTokens: 128_000 },
        { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5', providerId: 'openrouter', maxInputTokens: 1_000_000 },
        { id: 'meta-llama/llama-3-70b-instruct', name: 'Llama 3 70B', providerId: 'openrouter', maxInputTokens: 8_192 },
      ]
    },

    async sendRequest(
      model: RaptorModel,
      messages: RaptorMessage[],
      options: { tools?: vscode.LanguageModelChatTool[] },
      token: vscode.CancellationToken,
    ): Promise<AsyncIterable<RaptorResponseEvent>> {
      const url = `${baseUrl}/chat/completions`
      const body = buildRequestBody(model, messages, options.tools)

      const controller = new AbortController()
      token.onCancellationRequested(() => controller.abort())

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/raptor-vscode',
          'X-Title': 'Raptor VSCode',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const error = await response.text().catch(() => 'Unknown error')
        throw new ProviderError('openrouter', `http-${response.status}`, `OpenRouter API error: ${error}`)
      }

      return streamResponse(response.body)
    },

    supportsTools() { return true },
  }
}

interface OpenAIMessageFormat {
  role: string
  content?: string | { type: string; text: string }[] | null
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function buildRequestBody(
  model: RaptorModel,
  messages: RaptorMessage[],
  tools?: vscode.LanguageModelChatTool[],
): Record<string, unknown> {
  const openrouterMessages: OpenAIMessageFormat[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      openrouterMessages.push({
        role: 'system',
        content: m.content.filter(c => c.type === 'text').map(c => c.value).join(''),
      })
      continue
    }

    const toolCallParts = m.content.filter(c => c.type === 'tool_call') as RaptorToolCallPart[]
    const toolResultParts = m.content.filter(c => c.type === 'tool_result') as RaptorToolResultPart[]
    const textParts: RaptorTextPart[] = m.content.filter(c => c.type === 'text') as RaptorTextPart[]

    if (m.role === 'assistant' && toolCallParts.length > 0) {
      openrouterMessages.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.map(t => t.value).join('') : null,
        tool_calls: toolCallParts.map(tc => ({
          id: tc.callId,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      })
      continue
    }

    if (m.role === 'user') {
      if (textParts.length > 0) {
        openrouterMessages.push({
          role: 'user',
          content: textParts.map(t => ({ type: 'text', text: t.value })),
        })
      }
      for (const tr of toolResultParts) {
        openrouterMessages.push({
          role: 'tool',
          tool_call_id: tr.callId,
          content: tr.content.map(c => c.value).join(''),
        })
      }
      if (textParts.length === 0 && toolResultParts.length === 0) {
        openrouterMessages.push({
          role: 'user',
          content: [{ type: 'text', text: '' }],
        })
      }
      continue
    }

    openrouterMessages.push({
      role: 'assistant',
      content: textParts.length > 0 ? textParts.map(t => t.value).join('') : null,
    })
  }

  const body: Record<string, unknown> = {
    model: model.id,
    messages: openrouterMessages,
    stream: true,
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

interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
}

async function* streamResponse(body: ReadableStream<Uint8Array> | null): AsyncIterable<RaptorResponseEvent> {
  if (!body) return

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const accumulators = new Map<number, ToolCallAccumulator>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') continue

      try {
        const chunk = JSON.parse(data)
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue

        if (delta.content != null) {
          yield { type: 'text', value: delta.content }
        }

        if (delta.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index
            if (!accumulators.has(idx)) {
              accumulators.set(idx, { id: tcDelta.id || '', name: tcDelta.function?.name || '', arguments: '' })
            }
            const acc = accumulators.get(idx)!
            if (tcDelta.id) acc.id = tcDelta.id
            if (tcDelta.function?.name) acc.name = tcDelta.function.name
            if (tcDelta.function?.arguments) acc.arguments += tcDelta.function.arguments
          }
        }

        const finishReason = chunk.choices?.[0]?.finish_reason
        if (finishReason === 'tool_calls') {
          for (const [, acc] of accumulators) {
            if (acc.id && acc.name) {
              try {
                yield {
                  type: 'tool_call',
                  callId: acc.id,
                  name: acc.name,
                  input: JSON.parse(acc.arguments || '{}'),
                }
              } catch {
                throw new ProviderError('openrouter', 'tool-parse-error', `Failed to parse tool call arguments: ${acc.arguments.slice(0, 200)}`)
              }
            }
          }
          accumulators.clear()
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err
      }
    }
  }

  for (const [, acc] of accumulators) {
    if (acc.id && acc.name && acc.arguments) {
      try {
        yield {
          type: 'tool_call',
          callId: acc.id,
          name: acc.name,
          input: JSON.parse(acc.arguments),
        }
      } catch { /* partial args, skip */ }
    }
  }
}
