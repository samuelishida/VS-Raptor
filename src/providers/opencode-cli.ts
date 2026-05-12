import * as vscode from 'vscode'
import { createCliProvider, createOpenCodeProviderConfig, type CliProviderRuntimeConfig } from './cli'
import type { ModelProvider } from './types'

export function createOpenCodeProvider(config?: { apiKey?: string; model?: string; command?: string }): ModelProvider {
  const cliConfig = createOpenCodeProviderConfig()
  
  const providerConfig: CliProviderRuntimeConfig = {}
  if (config?.apiKey) providerConfig.apiKey = config.apiKey
  if (config?.model) providerConfig.defaultModel = config.model
  if (config?.command) providerConfig.command = config.command

  return createCliProvider(cliConfig, providerConfig)
}
