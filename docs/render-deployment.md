# Deploy ShiftBridge on Render (demo only)

ShiftBridge's frontend and Express API run in one Node web service. The live
database is still SQLite; the existing Supabase scripts only check connectivity
and copy snapshots. **Do not treat Supabase as the live database yet.**

## Option A: Render Blueprint (recommended for this demo)

1. Merge the Render deployment PR into `main`.
2. Open https://dashboard.render.com/blueprints and create a new Blueprint.
3. Connect your GitHub account and select `Arrjack8847/Shiftbridge`.
4. Let Render read the root `render.yaml` file.
5. Enter your private `GROQ_API_KEY` when prompted. Keep it in Render's
   secret environment, never in GitHub or a client-side file.
6. Apply the Blueprint; Render will run `npm ci` and `npm start`.
7. Check `https://<your-service>.onrender.com/api/health` for JSON with
   `"ok": true`, then open the root URL for the ShiftBridge UI.

The Blueprint pins Node 22, selects the Groq backend, uses the existing
`/api/health` route and binds `PORT=3000`. This specific port matters
because `server/groq-agent.js` currently uses `localhost:3000` as its
default internal API address. If you change `PORT` later, also set
`SHIFTBRIDGE_API=http://127.0.0.1:<PORT>/api`.

## Option B: Manual Render Web Service

Create a **Web Service** (not Static Site) from the repository. Use:

- Runtime: Node
- Branch: `main` (after merging this PR)
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/api/health`
- Instance: Free for disposable demonstrations
- Environment variables: `NODE_VERSION=22.22.0`, `PORT=3000`,
  `AI_PROVIDER=groq`, `GROQ_ENABLED=1`,
  `GROQ_MODEL=openai/gpt-oss-120b`, plus a secret `GROQ_API_KEY`.

The server listens on `0.0.0.0` and serves both UI and APIs, so a separate
frontend deployment and CORS origin configuration are not needed.

## Testing after deployment

1. Open `/api/health`. If it is unreachable, check Build/Runtime logs.
2. Open `/api/workspaces`. Initial seeded demo workspaces should appear.
3. In the UI, select the demo manager and send a clear **routine** task,
   such as "Emma, please restock cups before 5 PM." Confirm a task appears.
4. Test an ambiguous message that needs the AI, then inspect
   `/api/workspaces/daily/groq-status` for recent jobs. A model call
   requires a valid API key, supported model, and remaining provider quota.
5. From two browsers, check that messages propagate via SSE/polling.

## Important deployment limitations

**SQLite data will disappear** when a Render Free web service sleeps, restarts,
or redeploys. It is suitable for an intentionally disposable demo, not for
real team collaboration. For durability either migrate the runtime to
Supabase/Postgres (not yet implemented) or switch to a paid Render instance
with a persistent disk and set `SHIFTBRIDGE_DB_PATH` to a path on that disk.

**This app has demo identities, not authentication or access control for a
public internet service.** Anyone with the URL can access the app and its
unprotected administrative API routes, including the reset endpoint. Do not
enter real business, employee, or customer data and do not promote this
deployment to production without access control, authenticated API
authorization, abuse protection, and persistent storage.

Render Free services spin down after idle periods and may take time to wake.
The AI's background polling only runs while the web process is running.
