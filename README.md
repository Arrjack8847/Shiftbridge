# ShiftBridge — Silent AI agent for team shift handover

ShiftBridge is a shared backend for small-business team communication with operational task management and a **Silent AI reasoning agent** that monitors workspace activity. Built for DORMATHON 2026 with WorkBuddy Agentic Solutions.

The **single group chat** is the home screen for employees and administrators. On mobile a large raised **Chat** button sits between **Tasks** and **Shift** buttons; administrators also have a **Manage** area with **Silent AI Proposals**.

## Architecture

- **Frontend**: Vanilla HTML/CSS/JavaScript (no React/Next.js)
- **Backend**: Node.js + Express + SQLite (better-sqlite3)
- **MCP Server**: Stdio transport server exposing 5 AI tools
- **Real-time sync**: Server-Sent Events (SSE) + 2-second polling fallback
- **Database**: Single SQLite file at `server/shiftbridge.db`

The backend is the **single source of truth** for all shared data: messages, tasks, issues, workspaces, rules, shifts, handovers, and AI proposals. Each phone persists only its selected demo identity in localStorage.

## Quick start

```bash
# Install dependencies
npm install

# Start the backend (serves both API and static frontend)
npm run dev
```

The server starts on `0.0.0.0:3000`. The console will print:
- `Local: http://localhost:3000`
- `Network: http://<your-laptop-ipv4>:3000` (for phone access)

Open `http://localhost:3000` on your laptop, and `http://<laptop-ip>:3000` on phones connected to the same Wi-Fi.

## Silent AI Agent (MCP Integration)

The Silent AI agent connects via **Model Context Protocol (MCP)** with stdio transport. It monitors workspace activity and creates proposals that managers review in the dashboard.

### Connecting WorkBuddy Desktop

The MCP config is at `~/.workbuddy-ai/mcp.json`:

```json
{
  "mcpServers": {
    "shiftbridge": {
      "command": "node",
      "args": ["C:\\path\\to\\server\\mcp-server.js"]
    }
  }
}
```

After adding the config, open WorkBuddy Desktop → Connectors → trust the new MCP server.

### MCP Tools (5)

| Tool | Description |
|------|-------------|
| `list_tasks` | List all tasks in a workspace with status, assignee, category, and verification |
| `propose_task` | Propose a new task with evidence and reasoning for manager review |
| `review_completion` | Review a completion claim, gather evidence, produce AI reasoning |
| `refuse_protected_work` | Create a refusal proposal for protected work lacking qualified verification |
| `get_audit_trail` | Retrieve the full audit log for a workspace |

### Protected Task Enforcement

Tasks in **repairs**, **purchases**, or **safety** categories automatically get `verification: 'qualified'`. When an employee tries to mark these as `done`, the server redirects the status to `review` instead — the completion claim is preserved but requires qualified review before final approval.

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
| PUT | `/api/proposals/:id/review` | Approve or reject a proposal (auto-applies side effects) |
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
npm run test:backend   # Run backend integration tests (17 tests)
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
│   ├── mcp-server.js      # MCP server (stdio transport, 5 tools for Silent AI agent)
│   ├── test.js            # 17 backend integration tests
│   └── shiftbridge.db     # SQLite database (auto-created, gitignored)
└── assets/
    └── mark.svg            # ShiftBridge logo
```

## Known limitations

1. **No authentication** — demo identities are simulated and not secure
2. **No file uploads** — photo attachment button shows a notice
3. **LAN-only** — do not expose this backend to the public internet
4. **Safety-sensitive work** — equipment repairs, spending, and safety certification are never silently authorized; server-side enforcement redirects `done` → `review` for protected tasks
