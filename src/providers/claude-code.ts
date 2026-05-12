import * as vscode from 'vscode'
import { createCliProvider, createClaudeCodeProviderConfig, type CliProviderRuntimeConfig } from './cli'
import type { ModelProvider } from './types'

export function createClaudeCodeProvider(config?: { apiKey?: string; model?: string; command?: string }): ModelProvider {
  const cliConfig = createClaudeCodeProviderConfig()
  
  const providerConfig: CliProviderRuntimeConfig = {}
  if (config?.apiKey) providerConfig.apiKey = config.apiKey
  if (config?.model) providerConfig.defaultModel = config.model
  if (config?.command) providerConfig.command = config.command

  return createCliProvider(cliConfig, providerConfig)
}
