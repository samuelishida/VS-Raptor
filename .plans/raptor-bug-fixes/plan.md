# Raptor Bug Fixes Plan

## Context
Fix 7 bugs identified in the code audit: unsafe type casting, missing null checks, silent error swallowing, array bounds issues, and potential race conditions. These bugs affect reliability and debuggability of the Raptor VS Code extension.

## Architectural decisions
- Decision: Fix bugs in severity order (High → Medium → Low). Rationale: Address critical failures first.
- Decision: Use existing `logToOutput` utility for error logging. Rationale: Reuse established patterns, minimal churn.
- Decision: Config cache race condition is acceptable for VS Code extensions (single-threaded event loop). Rationale: VS Code extensions run in a single process with cooperative scheduling.
- Alternatives rejected: Adding a full mutex library for config cache (overkill for extension context).

## Assumptions and answers from code
- Decision: `logToOutput` is available in extension.ts. Source: code @ extension.ts:234.
- Decision: `ProviderError` class exists for model resolution errors. Source: code @ src/providers/types.ts.
- Assumption: Silent errors in persistence functions should log to output channel. Source: default engineering practice.

## Risks accepted
- Config cache race condition: Accept; revisit if users report stale config issues in multi-workspace scenarios.
- Type assertions remain unchecked: Accept; data sources are internal (VS Code API, parsed JSON), not external untrusted input.

## Increment DAG
- Inc 1 — Missing null check (H) — depends on: none — unblocks: 2, 3
- Inc 2 — Silent error logging (M) — depends on: 1 — unblocks: 4
- Inc 3 — Array bounds checks (L) — depends on: 1 — unblocks: 4
- Inc 4 — Type casting guards (M) — depends on: 2, 3 — unblocks: 5
- Inc 5 — Config cache review (L) — depends on: 4 — unblocks: none

## Increments

### Inc 1 — Missing null check in pickModelByVendorAndId (H)
**Depends on:** none
**Unblocks:** 2, 3
**Done criteria:** `pickModelByVendorAndId` throws descriptive error when no models match.

#### Files to touch
##### src/providers/registry.ts
- What changes: Add null check after `pickModelByVendorAndId`, throw `ProviderError`
- Function(s): `pickModelByVendorAndId`, `resolveExplicitProviderModel`
- Data shapes: `pickModelByVendorAndId(models: RaptorModel[], spec: string): RaptorModel | undefined`
- Integration points: Called by `resolveInternal` for model resolution
- Error paths: Throw `ProviderError` with message "Model '${spec}' not found in provider '${providerId}'"

#### Edge cases
- Empty models array: Already logs warning, now throws error
- Model spec not found: Throw with helpful message including available models

#### Verification
- Run: `npm run compile`
- Tests: Manual — run `/models` with no providers configured, verify error message
- Done: No undefined propagation from `pickModelByVendorAndId`

### Inc 2 — Silent error logging in persistence functions (M)
**Depends on:** 1
**Unblocks:** 4
**Done criteria:** All catch blocks in persistence functions log errors to output channel.

#### Files to touch
##### extension.ts
- What changes: Replace `/* silent */` and `/* non-fatal */` comments with `logToOutput` calls
- Function(s): `saveSessionSummary`, `saveConversationHistory`, `extractAndStoreMemories`, `generateSessionSummary`
- Data shapes: N/A
- Integration points: Uses `logToOutput` from src/utils/logging
- Error paths: Log error message + stack trace to output channel

#### Edge cases
- Output channel not initialized: Guard with `if (outputChannel)` check
- Recursive logging failures: Wrap logging itself in try-catch

#### Verification
- Run: `npm run compile`
- Tests: Manual — force persistence failure (e.g., readonly disk), verify error appears in output
- Done: No silent failures in persistence code paths

### Inc 3 — Array bounds checks (L)
**Depends on:** 1
**Unblocks:** 4
**Done criteria:** All array accesses verify length or use optional chaining consistently.

#### Files to touch
##### src/config/model.ts
- What changes: Add `models.length > 0` check before `models[0]` access
- Function(s): `pickPreferredChatModel`, `resolveModelForRequest`
- Data shapes: `vscode.LanguageModelChat[]`
- Integration points: Called by VS Code provider
- Error paths: Return `{ model: undefined, source: 'none' }` when array empty

##### extension.ts
- What changes: Add bounds check for `chatContext.history[i]` access
- Function(s): `inferActiveAgent`, `inferActiveModel`
- Data shapes: `vscode.ChatContext['history']`
- Integration points: Called during chat request handling
- Error paths: Return default agent/model when history empty

#### Edge cases
- Empty arrays: Return graceful defaults
- Negative indices: Not possible with current loop patterns

#### Verification
- Run: `npm run compile`
- Tests: Manual — run with no chat history, verify no crashes
- Done: No unchecked array accesses

### Inc 4 — Type casting guards (M)
**Depends on:** 2, 3
**Unblocks:** 5
**Done criteria:** Type assertions on dynamic values include runtime validation.

#### Files to touch
##### extension.ts
- What changes: Add runtime validation before `as const` assertions on role values
- Function(s): `buildRuntimeMessages`, `saveConversationHistory`
- Data shapes: `RaptorMessage['role']`, `ConversationSnapshot['messages']`
- Integration points: Message adapter, history persistence
- Error paths: Default to 'assistant' for unknown roles, log warning

#### Edge cases
- Unexpected role values: Default to safe value + log warning
- Null/undefined inputs: Guard with nullish coalescing

#### Verification
- Run: `npm run compile`
- Tests: Manual — inspect generated messages for correct role values
- Done: No unsafe type assertions on external data

### Inc 5 — Config cache race condition review (L)
**Depends on:** 4
**Unblocks:** none
**Done criteria:** Document why race condition is acceptable or add guard if needed.

#### Files to touch
##### src/config/loader.ts
- What changes: Add comment explaining why race condition is acceptable, or add simple guard
- Function(s): `getConfig`, `computeConfigSignature`
- Data shapes: `CacheEntry`
- Integration points: Called by chat participant on each request
- Error paths: If race detected, reload config (safe but redundant)

#### Edge cases
- Simultaneous requests: Both may reload config (inefficient but safe)
- Signature computation during file write: May detect stale cache, triggers reload

#### Verification
- Run: `npm run compile`
- Tests: Code review — verify comment explains VS Code's single-threaded model
- Done: Race condition documented or guarded

## Cross-cutting verification
- Run `npm run compile` after all increments
- Verify no TypeScript errors
- Test `/models` command with various configurations
- Test chat participant with no history
- Check output channel for error logs during forced failures

## Standards / common-mistakes referenced
- `.agents/standards/error-handling.md` — log errors, don't swallow silently
- `.agents/common-mistakes/null-checks.md` — validate at system boundaries
- `.agents/common-mistakes/array-access.md` — verify array length before access

## Open questions (CONSIDER from review)
- Should we add a test suite for model resolution edge cases?
- Should persistence failures trigger a user notification, or is logging sufficient?

## Out of scope
- Refactoring unrelated code patterns
- Adding new features or utilities
- Performance optimizations beyond bug fixes
