# ShiftBridge — Silent AI agent for team shift handover

ShiftBridge is a shared backend for small-business team communication with operational task management and a **Silent AI reasoning agent** that monitors workspace activity. Built for DORMATHON 2026 with WorkBuddy Agentic Solutions.

The **single group chat** is the home screen for employees and administrators. On mobile a large raised **Chat** button sits between **Tasks** and **Shift** buttons; administrators also have a **Manage** area with **Silent AI Proposals**.

## Architecture

- **Frontend**: Vanilla HTML/CSS/JavaScript (no React/Next.js)
- **Backend**: Node.js + Express 5 + SQLite (better-sqlite3)
- **MCP Server**: Official `@modelcontextprotocol/sdk` (v1.32.1), stdio transport, 8 AI tools
- **Real-time sync**: Server-Sent Events (SSE) + 2-second polling fallback
- **Database**: Single SQLite file at `server/shiftbridge.db`

The backend is the **single source of truth** for all shared data: messages, tasks, issues, workspaces, rules, shifts, handovers, and AI proposals. Each phone persists only its selected demo identity in localStorage.

## Quick start

```bash
# Install dependencies (includes MCP SDK)
npm install

# Start the backend (serves both API and static frontend)
npm run dev
```

The server starts on `0.0.0.0:3000`. The console will print:
- `Local: http://localhost:3000`
- `Network: http://<your-laptop-ipv4>:3000` (for phone access)

Open `http://localhost:3000` on your laptop, and `http://<laptop-ip>:3000` on phones connected to the same Wi-Fi.

For Vercel/Render deployment and diagnosing **chat typing or message send errors**, see [Chat connectivity and deployment checks](docs/chat-connectivity.md). The chat transport works independently of Groq/Tencent AI.

## Agent V2 now uses Groq API by default

**The default AI provider is `groq`, not Tencent CodeBuddy.** The existing AI features—contextual incident linking, warnings, hybrid completion claims, manager feedback and human verification—remain available. CodeBuddy is only a legacy opt-in fallback.

Setup: [docs/groq-agent-v2.md](docs/groq-agent-v2.md). Create a local `.env` from [`.env.example`](.env.example), insert your **private** Groq key, then run `npm run test:groq` and `npm run dev`. Never commit your API key.

## Agent V2 — contextual incident memory (development branch)

Agent V2 links source-backed chat messages to unresolved incidents, gives Groq recent incident history and manager-reviewed examples, and shows a reviewable incident conversation in the admin dashboard. It does **not** fine-tune Tencent weights, prove faults are real, or automatically clear protected work.

**Documentation and Windows test commands:** [docs/agent-v2.md](docs/agent-v2.md).

```powershell
npm run check
npm run test:agent-v2
```

## Fast task and warning routing (Tencent test branch)

For both providers (Groq is the default; Tencent is legacy opt-in):
- Clear operational reports such as "The printer is broken", "Machine 2 is leaking", "The POS is offline", or "Gas leak in the kitchen" are written immediately as **unverified, reported issues**. The source chat message, real author, timestamp and audit trail are preserved; safety reports receive high severity and still require a human check. No AI action authorizes repair or certifies safety.
- Simple, explicit, low-risk **manager** assignments such as "Emma, please restock the cups before 5 PM" use the already-validated `/manager-task` endpoint without starting the AI process. The endpoint enforces manager role, assignee membership and category rules. Complex work, repairs, spending and safety instructions still go to Tencent.
- Greetings/acknowledgments skip Tencent entirely.
- Unclear statements (for example "The machine is making a strange noise") still go to Tencent, which can use `report_chat_issue` to create a source-verified **unverified** issue. Question-only, hypothetical, resolved or negated incidents are not auto-reported by the fast detector.
- The agent never posts messages into the shared chat. A fast issue or task is announced to clients through the existing SSE stream. Work cannot be closed without the existing verification policy.

These are conservative recognition rules and examples, **not Tencent model fine-tuning**. Improve accuracy by reviewing managers' false-positive and false-negative examples, adding regression tests, and only then changing the rules or AI instructions. The current branch does not automatically retrain model weights.

Test the fast routing rules: `npm run test:messages`. Test Tencent's adapter: `npm run test:tencent`. The automated Tencent tests do not call a live AI account; validate genuine task/issue creation separately in the local running app. For live tool writes in the dedicated test repository set `CODEBUDDY_CLI_MCP_TARGET=http://127.0.0.1:3000/api` matching `SHIFTBRIDGE_API`, and `CODEBUDDY_CLI_ENABLE_WRITES=true`.

## Silent AI Agent (MCP Integration)

The Silent AI agent connects via **Model Context Protocol (MCP)** with stdio transport, using the official `@modelcontextprotocol/sdk`. It monitors workspace activity and creates proposals that managers review in the dashboard.

### Connecting WorkBuddy Desktop

The MCP config is at `~/.workbuddy-ai/mcp.json`:

```json
{
  "mcpServers": {
    "shiftbridge": {
      "command": "C:\\Users\\<user>\\.workbuddy-ai\\binaries\\node\\versions\\22.22.2-6\\node.exe",
      "args": ["C:\\<project-path>\\server\\mcp-server.js"]
    }
  }
}
```

After adding the config, open WorkBuddy Desktop → Connectors → trust the new MCP server.

### MCP Tools (8)

| Tool | Description |
|------|-------------|
| `get_recent_messages` | Read recent chat messages from a workspace (IDs, sender, body, timestamp) |
| `get_active_tasks` | List all tasks with status, assignee, category, verification, and protected flags |
| `get_workspace_rules` | Show permitted (self-report) and locked (qualified) categories per workspace |
| `list_tasks` | List all tasks in a workspace (alias of get_active_tasks) |
| `propose_task` | Propose a new task with evidence and AI reasoning for manager review |
| `propose_completion` | Review a completion claim, gather evidence, produce AI reasoning, create proposal |
| `refuse_protected_work` | Create a refusal proposal for protected work lacking qualified verification |
| `get_audit_trail` | Retrieve the full audit log for a workspace |

### Protected Task Enforcement

Tasks in **repairs**, **purchases**, or **safety** categories automatically get `verification: 'qualified'`. When an employee tries to mark these as `done`, the server redirects the status to `review` instead — the completion claim is preserved but requires qualified review before final approval.

### CRITICAL SAFETY: Qualified Verification Requirement

When a manager approves a `completion_review` proposal for a **protected task** (repairs, purchases, safety, or any task with `verification: 'qualified'`):

- **Without** qualified verification evidence → the task **remains in `review`** status. The approval is recorded, but a demo manager role alone is **NOT** qualified verification.
- **With** explicit qualified verification evidence (e.g., technician report, inspection certificate) → the task is marked `done`.

The manager dashboard prompts for qualified verification evidence when approving a protected completion review. The audit log records whether verification evidence was provided.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workspaces` | List all workspaces with members & rules |
| POST | `/api/workspaces` | Create a new workspace |
| PUT | `/api/workspaces/:id` | Update workspace settings |
| GET | `/api/workspaces/:ws/messages` | List messages (supports `?since=timestamp`) |
| POST | `/api/workspaces/:ws/messages` | Send a message (idempotent by client ID) |
| GET | `/api/workspaces/:ws/tasks` | List all tasks |
| POST | `/api/workspaces/:ws/tasks` | Create a task (auto-sets qualified verification for protected categories) |
| GET | `/api/tasks/:id` | Get a single task |
| PUT | `/api/tasks/:id` | Update task (server enforces review for protected tasks) |
| GET | `/api/workspaces/:ws/issues` | List issues |
| GET | `/api/issues/:id` | Get a single issue |
| PUT | `/api/issues/:id` | Update issue (resolve, approve, etc.) |
| PUT | `/api/rules/:id` | Toggle a rule (locked rules cannot be changed) |
| GET | `/api/workspaces/:ws/proposals` | List AI proposals (supports `?status=pending`) |
| GET | `/api/proposals/:id` | Get a single proposal |
| POST | `/api/workspaces/:ws/proposals` | Create an AI proposal (task_proposal, completion_review, refusal) |
| PUT | `/api/proposals/:id/review` | Approve or reject a proposal (with qualifiedVerification for protected tasks) |
| GET | `/api/workspaces/:ws/shift` | Get shift state |
| PUT | `/api/workspaces/:ws/shift` | Clock in/out |
| GET | `/api/workspaces/:ws/handover` | Get handover |
| PUT | `/api/workspaces/:ws/handover` | Save handover |
| GET | `/api/workspaces/:ws/audit` | Administrator review records (audit log) |
| GET | `/api/sync?workspace=X&revision=N` | Polling sync check |
| GET | `/api/events?workspace=X` | SSE real-time event stream |
| GET | `/api/people` | List demo people |
| GET | `/api/health` | Health check |
| POST | `/api/reset` | Reset database to seed data |

## Screens and URLs

- `#/chat` — one shared group conversation per workspace
- `#/tasks` and `#/task/:id` — My Tasks, task detail, status changes
- `#/shift`, `#/handover` — attendance and shift handover
- `#/profile` — demo identity, profile and workspace switcher
- `#/manage` — admin overview with Silent AI Proposals section
- `#/manage/attention` — unresolved issues and review items
- `#/manage/proposals` — all AI proposals (pending and reviewed)
- `#/manage/all-work` — all workspace tasks and issues
- `#/manage/team` — members and shift coverage
- `#/manage/invites` — sample invite code
- `#/manage/rules` — AI auto-assignment permissions
- `#/manage/settings` — workspace details
- `#/manage/issue/:id` — evidence, inspection approval and resolution

## Development

```bash
npm run check          # Syntax-check all JS files
npm run test:backend   # Run backend integration tests (19 tests)
npm run seed           # Re-seed the database
npm run mcp            # Start MCP server (for manual testing)
```

## Project structure

```
├── index.html              # App mount point
├── styles.css             # All styling (mobile-first, responsive)
├── src/
│   ├── app.js             # Main app: routing, rendering, API integration, proposals
│   ├── api.js             # API client (fetch wrapper, proposals methods)
│   ├── data.js            # Demo people, helpers, identity storage
│   └── icons.js           # Inline SVG icons
├── server/
│   ├── index.js           # Express server (static + API + SSE + proposals + enforcement)
│   ├── db.js              # SQLite schema and row mappers (includes ai_proposals table)
│   ├── seed.js            # Initial demo data seeding
│   ├── rule-defaults.js   # Shared rule definitions (locked: repairs, purchases, safety)
│   ├── mcp-server.js      # MCP server (official SDK, stdio transport, 8 tools)
│   ├── test.js            # 19 backend integration tests
│   └── shiftbridge.db     # SQLite database (auto-created, gitignored)
└── assets/
    └── mark.svg            # ShiftBridge logo
```

## Known limitations

1. **No authentication** — demo identities are simulated and not secure
2. **No file uploads** — photo attachment button shows a notice
3. **LAN-only** — do not expose this backend to the public internet
4. **Safety-sensitive work** — equipment repairs, spending, and safety certification are never silently authorized; server-side enforcement redirects `done` → `review` for protected tasks, and manager approval of completion reviews requires explicit qualified verification evidence to mark tasks done
5. **MCP connector trust** — the ShiftBridge MCP connector must be manually trusted in WorkBuddy Desktop before it can be invoked from chat
