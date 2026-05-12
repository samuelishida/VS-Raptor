import * as vscode from 'vscode'

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Provider-neutral runtime types ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export interface RaptorModel {
  id: string
  name: string
  providerId: string
}

export interface RaptorTextPart {
  type: 'text'
  value: string
}

export interface RaptorToolCallPart {
  type: 'tool_call'
  callId: string
  name: string
  input: Record<string, unknown>
}

export interface RaptorToolResultPart {
  type: 'tool_result'
  callId: string
  content: RaptorTextPart[]
}

export type RaptorMessageContentPart = RaptorTextPart | RaptorToolCallPart | RaptorToolResultPart

export interface RaptorMessage {
  role: 'user' | 'assistant' | 'system'
  content: RaptorMessageContentPart[]
}

export type RaptorResponseEvent =
  | { type: 'text'; value: string }
  | { type: 'tool_call'; callId: string; name: string; input: Record<string, unknown> }

export interface RaptorToolCall {
  callId: string
  name: string
  input: Record<string, unknown>
}

export interface RaptorToolResult {
  callId: string
  content: string
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

// We keep vscode.LanguageModelChatTool in the interface for now because
// the existing tool registry returns that type. A future increment can
// introduce a fully internal RaptorTool shape.
export interface ProviderStatus {
  available: boolean
  reason?: string
  code?: string
}

export interface ModelProvider {
  readonly id: string
  readonly name: string
  readonly capability: ProviderCapability
  readonly acceptsArbitraryModel: boolean
  listModels(): Promise<RaptorModel[]>
  sendRequest(
    model: RaptorModel,
    messages: RaptorMessage[],
    options: { tools?: vscode.LanguageModelChatTool[] },
    token: vscode.CancellationToken,
  ): Promise<AsyncIterable<RaptorResponseEvent>>
  supportsTools(model: RaptorModel): boolean
  getStatus?(): Promise<ProviderStatus>
}

export interface ResolvedModel {
  provider: ModelProvider
  model: RaptorModel
  source: string
  available: RaptorModel[]
}

// ─── Inc 1 new types ──────────────────────────────────────────────────────────

export interface RaptorModelRef {
  providerId?: string
  modelId: string
  displayName?: string
}

export type ModelResolutionSource =
  | 'flow-step-override'
  | 'agent-override'
  | 'session-selected'
  | 'fallback'

export type ProviderCapability =
  | 'native-tools'
  | 'native-text'
  | 'delegated'
  | 'unavailable'

export interface ModelResolutionInput {
  flowStepModel?: string
  agentModel?: string
  sessionModel?: RaptorModelRef
  fallbackModel?: string
  /** If true, an explicit provider that cannot be matched falls back instead of throwing ProviderError. Default false. */
  allowFallbackForExplicitProvider?: boolean
}
