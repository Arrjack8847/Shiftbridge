# ShiftBridge — Multi-device team chat & task management

ShiftBridge is a shared backend for small-business team communication with operational task management. Built for DORMATHON 2026 with WorkBuddy Agentic Solutions.

The **single group chat** is the home screen for employees and administrators. On mobile a large raised **Chat** button sits between **Tasks** and **Shift** buttons; administrators also have a **Manage** area.

## Architecture

- **Frontend**: Vanilla HTML/CSS/JavaScript (no React/Next.js)
- **Backend**: Node.js + Express + SQLite (better-sqlite3)
- **Real-time sync**: Server-Sent Events (SSE) + 2-second polling fallback
- **Database**: Single SQLite file at `server/shiftbridge.db`

The backend is the **single source of truth** for all shared data: messages, tasks, issues, workspaces, rules, shifts, and handovers. Each phone persists only its selected demo identity in localStorage.

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

## Multi-phone testing

1. Start the server on your Windows laptop: `npm run dev`
2. Note the IPv4 address printed (e.g. `172.20.10.3`)
3. On Phone A, open `http://172.20.10.3:3000` → select **Manager**
4. On Phone B, open the same URL → select **Jack**
5. On Phone C, open the same URL → select **Emma**
6. Manager sends "Jack, please check the oat milk stock."
7. Jack and Emma receive it automatically (SSE + 2s polling)
8. Jack replies "I checked it. Four cartons remaining."
9. All phones see Jack's reply
10. Manager creates a task and assigns it to Jack
11. Jack sees the task on his phone
12. Jack reports completion → Manager sees the updated status

## Demo identities

No authentication. Each phone picks a demo identity:

| Identity   | Role          |
|------------|---------------|
| Manager    | Administrator |
| Jack       | Employee      |
| Emma       | Employee      |
| Sarah      | Shift Lead    |
| Liam       | Employee      |

**⚠️ This is a simulated demo identity, NOT secure authentication. Do not expose this backend to the public internet.**

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workspaces` | List all workspaces with members & rules |
| POST | `/api/workspaces` | Create a new workspace |
| PUT | `/api/workspaces/:id` | Update workspace settings |
| GET | `/api/workspaces/:ws/messages` | List messages (supports `?since=timestamp`) |
| POST | `/api/workspaces/:ws/messages` | Send a message (idempotent by client ID) |
| GET | `/api/workspaces/:ws/tasks` | List all tasks |
| POST | `/api/workspaces/:ws/tasks` | Create a task (idempotent) |
| GET | `/api/tasks/:id` | Get a single task |
| PUT | `/api/tasks/:id` | Update task status/completion |
| GET | `/api/workspaces/:ws/issues` | List issues |
| GET | `/api/issues/:id` | Get a single issue |
| PUT | `/api/issues/:id` | Update issue (resolve, approve, etc.) |
| PUT | `/api/rules/:id` | Toggle a rule |
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
- `#/manage` — admin overview (administrator only)
- `#/manage/attention` — unresolved issues and review items
- `#/manage/all-work` — all workspace tasks and issues
- `#/manage/team` — members and shift coverage
- `#/manage/invites` — sample invite code
- `#/manage/rules` — AI auto-assignment permissions
- `#/manage/settings` — workspace details
- `#/manage/issue/:id` — evidence, inspection approval and resolution

## Development

```bash
npm run check          # Syntax-check all JS files
npm run test:backend   # Run backend integration tests
npm run seed           # Re-seed the database
```

## Project structure

```
├── index.html              # App mount point
├── styles.css             # All styling (mobile-first, responsive)
├── src/
│   ├── app.js             # Main app: routing, rendering, API integration
│   ├── api.js             # API client (fetch wrapper)
│   ├── data.js            # Demo people, helpers, identity storage
│   └── icons.js           # Inline SVG icons
├── server/
│   ├── index.js           # Express server (static + API + SSE)
│   ├── db.js              # SQLite schema and row mappers
│   ├── seed.js            # Initial demo data seeding
│   ├── rule-defaults.js   # Shared rule definitions
│   └── shiftbridge.db     # SQLite database (auto-created, gitignored)
├── scripts/
│   └── serve.mjs          # Legacy static-only server (unused)
└── assets/
    └── mark.svg            # ShiftBridge logo
```

## Known limitations

1. **No authentication** — demo identities are simulated and not secure
2. **No file uploads** — photo attachment button shows a notice
3. **LAN-only** — do not expose this backend to the public internet
4. **WorkBuddy MCP** — Phase 4 integration is manual, not continuous autonomous processing
5. **Safety-sensitive work** — equipment repairs, spending, and safety certification are never silently authorized
