# ShiftBridge chat connectivity: local, Vercel, and Render

## Expected behavior

- The chat input stays focused and keeps the unsent draft across SSE, polling, and view updates.
- Sending a message stores it via `POST /api/workspaces/:workspace/messages`. A failed request restores the draft and shows an error. Neither Groq nor Tencent AI is needed for ordinary chat.
- If the backend is unavailable, the chat shows an offline banner. You can still type, but messages cannot be delivered until the API works.

## Test locally first

From the repository root:

```powershell
npm ci
npm run dev
```

Open `http://localhost:3000/api/health` and `http://localhost:3000/api/workspaces`. Both must respond with JSON. Open `http://localhost:3000/#/chat`, choose a demo identity and send a message.

For old Tencent CodeBuddy, set `AI_PROVIDER=tencent-local` in your local `.env`. This affects AI analysis, not basic chat transport. For local testing `SHIFTBRIDGE_STORAGE=sqlite` avoids needing remote Supabase tables.

## Deploy as two services

**Render (Express API + database)**

1. Deploy the root of this repository as a Render Web Service.
2. Build command: `npm ci`; start command: `npm start`. The server listens on `0.0.0.0` and `process.env.PORT`.
3. Verify `https://YOUR-ACTUAL-RENDER-SERVICE.onrender.com/api/health` and `/api/workspaces` both respond with JSON *before* configuring Vercel.
4. Configure any Groq, Tencent, and optional Supabase environment variables only on the backend. If `SHIFTBRIDGE_STORAGE=supabase`, the matching `sb_*` persistence tables and server-side Supabase credentials must exist. A missing cloud schema can prevent the server from starting.
5. This demo uses simulated identities without authentication; do not deploy it for real sensitive operational data.

**Vercel (static UI + same-origin API proxy)**

1. Connect this repository and set project **Root Directory** to the repository root (the folder with `vercel.json`, `index.html`, and `api/proxy.js`).
2. In **Vercel → Project Settings → Environment Variables**, set `SHIFTBRIDGE_RENDER_URL` to **exactly** your Render HTTPS service origin (for example `https://my-service.onrender.com`, without `/api`).
3. Apply that variable to the intended Production/Preview environments and **redeploy** after saving it. Environment variable changes do not fix an already-built deployment by themselves.
4. Open `https://YOUR-VERCEL-DOMAIN/api/health`, `/api/workspaces`, and `/api/sync?workspace=daily&revision=0` in a browser. Expect JSON, not a Vercel NOT_FOUND HTML page. `/api/events` intentionally returns **204** on Vercel; polling handles live updates.
5. Send a message as Manager, then check the same workspace from another demo identity.

## Diagnose errors

| What you see | Meaning / next action |
| --- | --- |
| Vercel HTML `404 NOT_FOUND` on `/api/workspaces` | Vercel did not route to `api/proxy.js`: check correct project, branch, root directory, current deployment, and `vercel.json` |
| JSON `503 BACKEND_NOT_CONFIGURED` | Set `SHIFTBRIDGE_RENDER_URL` in Vercel, then redeploy |
| JSON `502 BACKEND_UNAVAILABLE` | Render service could not be reached; check service health and URL |
| JSON `502 BACKEND_ROUTE_NOT_FOUND` | Render is serving HTML 404 instead of Express API; check the service repository and start command |
| JSON `404 workspace not found` | Backend is online, but requested workspace has not been seeded/created |
| Draft comes back with a send error | Message was not confirmed; check `/api/health` and retry without losing what you typed |

Never put `SUPABASE_SECRET_KEY` or AI API secrets into the frontend or commit them to Git.
