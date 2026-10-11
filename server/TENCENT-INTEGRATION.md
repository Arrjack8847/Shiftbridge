# ShiftBridge Tencent AI adapter: verification and safe operation

This branch repairs the adapter's failure reporting and retry logic. **It does not
claim that the CodeBuddy HTTP Serve tool-dispatch bug has been fixed**.

## Modes

- `CODEBUDDY_EXECUTION_MODE=cli` (default): launches the global CodeBuddy
  JavaScript CLI entry point with `spawn()`. This is the execution path that
  previously worked in external Windows PowerShell.
- `CODEBUDDY_EXECUTION_MODE=serve` (opt-in): kept for diagnosis, but **fails
  closed** when the Gateway only reports `active: false`. That status alone
  proves neither success nor an MCP invocation.

Required for CLI mode: a signed-in CodeBuddy CLI, a configured ShiftBridge MCP
server in the CLI user's account, the running ShiftBridge REST backend, and an
available Node.js executable. Set `SHIFTBRIDGE_API=http://127.0.0.1:3000/api`.

The Windows CLI script is resolved from `%APPDATA%\npm\node_modules\
@tencent-ai\codebuddy-code\bin\codebuddy` unless explicitly set with
`CODEBUDDY_CLI_SCRIPT`. If needed, set `CODEBUDDY_NODE_BIN` to the Node.js
executable. These are **paths**, not passwords.

For isolated tests, set both `SHIFTBRIDGE_API` and
`CODEBUDDY_CLI_MCP_TARGET` to `http://127.0.0.1:3001/api`. The child
receives a dedicated `CODEBUDDY_MCP_CONFIG` pointing to the MCP script
in this test checkout and that exact local backend. The two URLs must match.
Write-enabled CLI calls refuse to start unless the explicit target is set.

The adapter strips WorkBuddy Desktop-specific CLI environment overrides from
the child process without changing global environment variables. If an inherited
HTTP proxy triggers startup failures, use `CODEBUDDY_CLI_CLEAR_PROXY=true`
only for that child process after confirming that a proxy is not required.

## Permissions

By default CLI mode is **read-only**. No task-creation tools are exposed.
It starts with an explicit `--tools` availability list composed of
`NoDefer(mcp__shiftbridge__...)` entries and `--permission-mode dontAsk`.
The `--allowedTools` option by itself is **not** a tool availability whitelist.

Only for an isolated, policy-checked Test 2, deliberately opt in using
`CODEBUDDY_CLI_ENABLE_WRITES=true`. This exposes a **small predefined set**
of ShiftBridge MCP tools, including `create_manager_task`, but no arbitrary
shell, editing, or file-write tools. The backend must still verify that the
source message was sent by the workspace manager and that its category
is not protected. Employee completion remains subject to existing rules.

Do not use `bypassPermissions`, `acceptEdits`, or broad shell permissions.

## What counts as a successful run?

- A successful CodeBuddy final `stream-json` result.
- A **structured** `tool_use` for a ShiftBridge MCP tool.
- A matching **successful** `tool_result` for that tool-use ID.
- No recorded MCP error results.
- For `create_manager_task`, a persisted task linked to the source message.

Text such as `<tool_call>TaskList`, `active:false`, an accepted Gateway
run ID, or a model's description of an action is **not evidence of execution**.

The parser assumes the documented message/tool-block `stream-json` shape; this
still needs validation with an actual locally captured CLI stream, as output
formats can vary across CodeBuddy versions. If actual CLI events differ, adjust
the parser *based on real events*, not generated text.

## Jobs and retries

The job attempt counter is incremented at the start of each execution and is
not reset on failure. Completed/exhausted jobs are not reprocessed.
Interrupted `processing` jobs older than the configured run timeout can
be reclaimed by the retry poller.

Job success means CodeBuddy performed verified MCP operations or an authenticated
read-only analysis; it does not always mean a new task was created.
The API returns verified write actions separately.

## Manual desktop-automation fallback

`POST /api/tencent/jobs/:jobId/complete` is disabled unless
`SHIFTBRIDGE_MANUAL_AI_TOKEN` is set, and then requires
`Authorization: Bearer <token>`. The endpoint also verifies reported
manager-task creation against a persisted source-linked task.

This opt-in is **not general user authentication**. The demonstration UI has
no production login. Keep the backend on a trusted network and do not publish
the internal API to the Internet.

## Testing

Run `npm run test:tencent` for isolated parser/retry/config-validation unit tests.
They **do not access port 3000 or modify SQLite**. Their passing status is
not an end-to-end Tencent AI claim.

For an E2E test:
1. Use a **separate test database path** and its own backend instance, not
   `server/shiftbridge.db`. Keep backups of demo data.
2. Verify the standalone `codebuddy -p` read-only MCP call.
3. Run one queued read-only chat analysis using CLI mode and confirm real
   tool-use / tool-result events.
4. In the isolated environment, opt in to allowed write tools, send a manager
   instruction, and verify a new task's source ID and assignee in SQLite.
5. Confirm no duplicate on retry and protected work is still blocked or
   requires qualified human review.

WorkBuddy Desktop and CodeBuddy Code are distinct Tencent products.
Confirm competition eligibility separately if the track requires WorkBuddy.
