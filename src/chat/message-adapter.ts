import * as vscode from 'vscode'
import {
  type RaptorMessage,
  type RaptorTextPart,
  type RaptorToolCallPart,
  type RaptorToolResultPart,
} from '../providers/types'

export function toRaptorMessages(vsMessages: vscode.LanguageModelChatMessage[]): RaptorMessage[] {
  return vsMessages.map(m => ({
    role: m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
    content: convertVSCodePartsToRaptor(m.content),
  }))
}

export function fromRaptorMessages(messages: RaptorMessage[]): vscode.LanguageModelChatMessage[] {
  return messages.map(m => {
    const parts: vscode.LanguageModelInputPart[] = m.content.map(part => {
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
    if (m.role === 'user') return new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, parts)
    // VS Code types don't have System role yet - treat system as assistant for now
    return new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, parts)
  })
}

export function buildRuntimeMessages(
  systemAndHistory: vscode.LanguageModelChatMessage[],
  userContent: string,
): RaptorMessage[] {
  const out = toRaptorMessages(systemAndHistory)
  out.push({ role: 'user', content: [{ type: 'text', value: userContent }] })
  return out
}

export function appendToolResult(
  messages: RaptorMessage[],
  textParts: RaptorTextPart[],
  toolCalls: RaptorToolCallPart[],
): void {
  messages.push({
    role: 'assistant',
    content: [...textParts, ...toolCalls],
  })
}

export function appendToolResultToMessages(
  messages: RaptorMessage[],
  callId: string,
  result: string,
): void {
  messages.push({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        callId,
        content: [{ type: 'text', value: result }],
      },
    ],
  })
}

export function compactRuntimeMessages(
  messages: RaptorMessage[],
  systemMessages: RaptorMessage[],
  summary: string,
  recentMessages: RaptorMessage[],
): RaptorMessage[] {
  return [
    ...systemMessages,
    { role: 'user', content: [{ type: 'text', value: `[CONVERSATION SUMMARY -- context was compacted]\n\n${summary}` }] },
    { role: 'assistant', content: [{ type: 'text', value: 'Understood. Continuing from the summary above.' }] },
    ...recentMessages,
  ]
}

function convertVSCodePartsToRaptor(parts: vscode.LanguageModelInputPart[]): RaptorMessage['content'] {
  return parts.map((p): RaptorTextPart | RaptorToolCallPart | RaptorToolResultPart => {
    if (p instanceof vscode.LanguageModelTextPart) return { type: 'text', value: p.value }
    if (p instanceof vscode.LanguageModelToolCallPart) return { type: 'tool_call', callId: p.callId, name: p.name, input: p.input as Record<string, unknown> }
    if (p instanceof vscode.LanguageModelToolResultPart) {
      return {
        type: 'tool_result',
        callId: p.callId,
        content: p.content.map(c => {
          if (c instanceof vscode.LanguageModelTextPart) return { type: 'text', value: c.value }
          return { type: 'text', value: '' }
        }),
      }
    }
    return { type: 'text', value: '' }
  })
}
