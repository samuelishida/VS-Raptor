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

interface AnthropicConfig {
  apiKey: string
  baseUrl?: string
}

export function createAnthropicProvider(config: AnthropicConfig): ModelProvider {
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return {
      id: 'anthropic',
      name: 'Anthropic (disabled - no API key)',
      capability: 'unavailable' as const,
      acceptsArbitraryModel: false,
      async listModels() { return [] },
      async sendRequest() { throw new ProviderError('anthropic', 'no-api-key', 'Anthropic API key not configured') },
    supportsTools(_model: RaptorModel): boolean {
      return true
    },
    }
  }

  const baseUrl = config.baseUrl || 'https://api.anthropic.com/v1'

  return {
    id: 'anthropic',
    name: 'Anthropic',
    capability: 'native-tools' as const,
    acceptsArbitraryModel: false,

    async listModels(): Promise<RaptorModel[]> {
      return [
        { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', providerId: 'anthropic', maxInputTokens: 200_000 },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', providerId: 'anthropic', maxInputTokens: 200_000 },
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', providerId: 'anthropic', maxInputTokens: 200_000 },
        { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', providerId: 'anthropic', maxInputTokens: 200_000 },
        { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', providerId: 'anthropic', maxInputTokens: 200_000 },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', providerId: 'anthropic', maxInputTokens: 200_000 },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', providerId: 'anthropic', maxInputTokens: 200_000 },
        { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', providerId: 'anthropic', maxInputTokens: 200_000 },
      ]
    },

    async sendRequest(
      model: RaptorModel,
      messages: RaptorMessage[],
      options: { tools?: vscode.LanguageModelChatTool[] },
      token: vscode.CancellationToken,
    ): Promise<AsyncIterable<RaptorResponseEvent>> {
      const url = `${baseUrl}/messages`
      const body = buildRequestBody(model, messages, options.tools)

      const controller = new AbortController()
      token.onCancellationRequested(() => controller.abort())

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const error = await response.text().catch(() => 'Unknown error')
        throw new ProviderError('anthropic', `http-${response.status}`, `Anthropic API error: ${error}`)
      }

      return streamResponse(response.body)
    },

    supportsTools() { return true },
  }
}

function buildRequestBody(
  model: RaptorModel,
  messages: RaptorMessage[],
  tools?: vscode.LanguageModelChatTool[],
): Record<string, unknown> {
  // Extract system messages - Anthropic expects system as top-level, then messages starting with user
  const systemParts: string[] = []
  const nonSystemMessages: RaptorMessage[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      // Accumulate all system message text
      const text = m.content.filter(c => c.type === 'text').map(c => c.value).join('\n')
      systemParts.push(text)
    } else {
      nonSystemMessages.push(m)
    }
  }

  // Ensure at least one user message comes first, otherwise prepend as system to first message
  const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
  let hasUser = false

  for (const m of nonSystemMessages) {
    const toolCallParts = m.content.filter(c => c.type === 'tool_call') as RaptorToolCallPart[]
    const toolResultParts = m.content.filter(c => c.type === 'tool_result') as RaptorToolResultPart[]
    const textParts = m.content.filter(c => c.type === 'text') as RaptorTextPart[]

    const contentBlocks: unknown[] = [
      ...textParts.map(t => ({ type: 'text', text: t.value })),
      ...toolCallParts.map(tc => ({ type: 'tool_use', id: tc.callId, name: tc.name, input: tc.input })),
    ]

    if (toolResultParts.length > 0) {
      // In Anthropic, tool results MUST be in a user message
      const toolResultBlocks = toolResultParts.map(tr => ({
        type: 'tool_result',
        tool_use_id: tr.callId,
        content: tr.content.map(c => c.value).join(''),
      }))
      anthropicMessages.push({ role: 'user', content: toolResultBlocks.length === 1 && contentBlocks.length === 0 ? toolResultBlocks : [...contentBlocks, ...toolResultBlocks] })
    } else {
      anthropicMessages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }],
      })
      if (m.role === 'user') hasUser = true
    }
  }

  // If no user messages exist and we have system content, prepend a user message
  // containing the system text. Avoid rewriting an existing assistant message.
  if (!hasUser && systemParts.length > 0) {
    const systemText = systemParts.join('\n')
    anthropicMessages.unshift({
      role: 'user',
      content: [{ type: 'text', text: systemText }],
    })
    systemParts.length = 0
  }

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: 8192,
    messages: anthropicMessages,
    stream: true,
  }

  // Only include system if we have system parts
  if (systemParts.length > 0) body.system = systemParts.join('\n')

  if (tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))
  }

  return body
}

interface AnthropicToolAccumulator {
  id: string
  name: string
  inputJson: string
}

async function* streamResponse(body: ReadableStream<Uint8Array> | null): AsyncIterable<RaptorResponseEvent> {
  if (!body) return

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const accumulators = new Map<number, AnthropicToolAccumulator>()

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
        const event = JSON.parse(data)

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield { type: 'text', value: event.delta.text }
        }

        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const block = event.content_block
          accumulators.set(event.index, { id: block.id, name: block.name, inputJson: '' })
        }

        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
          const acc = accumulators.get(event.index)
          if (acc) acc.inputJson += event.delta.partial_json
        }

        if (event.type === 'content_block_stop') {
          const acc = accumulators.get(event.index)
          if (acc && acc.id && acc.name) {
            try {
              yield {
                type: 'tool_call',
                callId: acc.id,
                name: acc.name,
                input: JSON.parse(acc.inputJson || '{}'),
              }
            } catch {
              throw new ProviderError('anthropic', 'tool-parse-error', `Failed to parse Anthropic tool input: ${acc.inputJson.slice(0, 200)}`)
            }
          }
          accumulators.delete(event.index)
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err
      }
    }
  }
}
