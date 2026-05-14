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

interface OpenAIConfig {
  apiKey: string
  baseUrl?: string
}

export function createOpenAIProvider(config: OpenAIConfig): ModelProvider {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY
  if (!apiKey) {
    return {
      id: 'openai',
      name: 'OpenAI (disabled - no API key)',
      capability: 'unavailable' as const,
      acceptsArbitraryModel: false,
      async listModels() { return [] },
      async sendRequest() { throw new ProviderError('openai', 'no-api-key', 'OpenAI API key not configured') },
    supportsTools(_model: RaptorModel): boolean {
      return true
    },
    }
  }

  const baseUrl = config.baseUrl || 'https://api.openai.com/v1'

  return {
    id: 'openai',
    name: 'OpenAI',
    capability: 'native-tools' as const,
    acceptsArbitraryModel: false,

    async listModels(): Promise<RaptorModel[]> {
      return [
        { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', providerId: 'openai', maxInputTokens: 400_000 },
        { id: 'gpt-5.2', name: 'GPT-5.2', providerId: 'openai', maxInputTokens: 400_000 },
        { id: 'gpt-4o', name: 'GPT-4o', providerId: 'openai', maxInputTokens: 128_000 },
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', providerId: 'openai', maxInputTokens: 128_000 },
        { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', providerId: 'openai', maxInputTokens: 16_385 },
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
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const error = await response.text().catch(() => 'Unknown error')
        throw new ProviderError('openai', `http-${response.status}`, `OpenAI API error: ${error}`)
      }

      return streamResponse(response.body)
    },

    supportsTools() { return true },
  }
}

interface OpenAIMessage {
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
  const openaiMessages: OpenAIMessage[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      openaiMessages.push({
        role: 'system',
        content: m.content.filter(c => c.type === 'text').map(c => c.value).join(''),
      })
      continue
    }

    const toolCallParts = m.content.filter(c => c.type === 'tool_call') as RaptorToolCallPart[]
    const toolResultParts = m.content.filter(c => c.type === 'tool_result') as RaptorToolResultPart[]
    const textParts: RaptorTextPart[] = m.content.filter(c => c.type === 'text') as RaptorTextPart[]

    if (m.role === 'assistant' && toolCallParts.length > 0) {
      openaiMessages.push({
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
      // If message has both text and tool results, emit text first then each tool result separately
      if (textParts.length > 0) {
        openaiMessages.push({
          role: 'user',
          content: textParts.map(t => ({ type: 'text', text: t.value })),
        })
      }
      // Emit each tool result as a separate 'tool' message
      for (const tr of toolResultParts) {
        openaiMessages.push({
          role: 'tool',
          tool_call_id: tr.callId,
          content: tr.content.map(c => c.value).join(''),
        })
      }
      // If only tool results and no text, still need at least one message
      if (textParts.length === 0 && toolResultParts.length === 0) {
        openaiMessages.push({
          role: 'user',
          content: [{ type: 'text', text: '' }],
        })
      }
      continue
    }

    // Plain assistant message without tool calls
    openaiMessages.push({
      role: 'assistant',
      content: textParts.length > 0 ? textParts.map(t => t.value).join('') : null,
    })
  }

  const body: Record<string, unknown> = {
    model: model.id,
    messages: openaiMessages,
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

        // Yield complete tool calls when finish_reason is tool_calls
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
                throw new ProviderError('openai', 'tool-parse-error', `Failed to parse tool call arguments: ${acc.arguments.slice(0, 200)}`)
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

  // Defensive end-of-stream flush: emit any accumulated tool calls whose JSON
  // args parse cleanly. Guards against providers that drop the final
  // finish_reason='tool_calls' chunk on connection close.
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
