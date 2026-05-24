import * as vscode from 'vscode'
import { createCliProvider, createClaudeCodeProviderConfig, type CliProviderRuntimeConfig } from './cli'
import type { ModelProvider } from './types'

export function createClaudeCodeProvider(config?: { model?: string; command?: string }): ModelProvider {
  const cliConfig = createClaudeCodeProviderConfig()
  
  const providerConfig: CliProviderRuntimeConfig = {}
  if (config?.model) providerConfig.defaultModel = config.model
  if (config?.command) providerConfig.command = config.command

  return createCliProvider(cliConfig, providerConfig)
}
