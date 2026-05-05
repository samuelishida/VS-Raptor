# VS Raptor Extension

VS Raptor is an autonomous coding assistant for Visual Studio Code. It provides a chat participant with integrated file, terminal, memory, and LSP tools to help with code navigation, editing, and analysis.

## Features

- **Chat Participant**: Interact with the `@raptor` agent directly in VS Code's chat panel
- **File Tools**: Read, edit, and create files with semantic awareness
- **Terminal Tools**: Execute commands and capture output
- **Memory System**: Persistent global and project-scoped memory for cross-session context
- **LSP Integration**: Code navigation with go-to-definition, find references, and diagnostics
- **Workspace Profiling**: Automatic detection of project structure and configuration
- **Session History**: Track and resume previous conversations

## Setup

### Prerequisites

- Node.js and npm installed
- Visual Studio Code 1.102.0 or newer

### Installation

1. Clone or download this repository
2. Install dependencies:

```bash
npm install
```

## Build

### Compile TypeScript

Compile the extension to JavaScript:

```bash
npm run compile
```

This outputs compiled code to `dist/extension.js`.

### Watch Mode

For development, run TypeScript in watch mode:

```bash
npm run watch
```

### Package as VSIX

Create a distributable VSIX file:

```bash
npx vsce package --no-dependencies 2>&1
```

This generates `raptor-vscode-extension-0.2.0.vsix`.

### Install from VSIX

Install the extension into VS Code:

```bash
code --install-extension raptor-vscode-extension-0.2.0.vsix
```

Or manually:
1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Click "..." menu → "Install from VSIX..."
4. Select the `.vsix` file

## Usage

- Open the chat panel (Ctrl+Alt+I or Cmd+Option+I)
- Type `@raptor` to invoke the agent
- Use `/help` to see available commands
- Use `/memory` to view persistent memory
- Use `/todos` to see saved todos
- Use `/clearmemory` to reset all persistent data

## Project Structure

- `extension.ts` - Main extension file with core logic
- `src/` - Modular source files (chat, tools, config, utilities)
- `dist/` - Compiled JavaScript output
- `tsconfig.json` - TypeScript configuration
- `package.json` - Dependencies and metadata

## Development

The extension is modularized into:
- `src/chat/` - Chat participant and system prompt generation
- `src/tools/` - Tool definitions and implementations
- `src/config/` - Configuration and model selection
- `src/utils/` - Utility helpers for paths, logging, etc.
- `src/commands/` - VS Code command registration

## Configuration

Configure raptor in VS Code settings:

- `raptor.maxIterations`: Maximum agent loop iterations (default: 100)
- `raptor.spawnAgentMaxIterations`: Max iterations for sub-agents (default: 60)
- `raptor.model`: Fallback LLM model (default: claude-sonnet-4.6)
