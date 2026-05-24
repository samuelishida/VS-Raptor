import * as vscode from 'vscode'
import { createCliProvider, createCodexProviderConfig, type CliProviderRuntimeConfig } from './cli'
import type { ModelProvider } from './types'

export function createCodexProvider(config?: { model?: string; command?: string }): ModelProvider {
  const cliConfig = createCodexProviderConfig()
  
  const providerConfig: CliProviderRuntimeConfig = {}
  if (config?.model) providerConfig.defaultModel = config.model
  if (config?.command) providerConfig.command = config.command

  return createCliProvider(cliConfig, providerConfig)
}
