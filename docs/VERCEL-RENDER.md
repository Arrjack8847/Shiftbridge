# Fixing Vercel `/api/*` 404 errors

The frontend is static HTML/JS on Vercel. Its API client calls same-origin `/api/*`. Express is hosted separately on Render, so Vercel will return `404 NOT_FOUND` unless those requests are forwarded.

This repository includes:

- `vercel.json`: rewrites `/api/:path*` to the same-origin Vercel Function `/api/proxy`.
- `api/proxy.js`: proxies GET/POST/PUT requests to the Express backend through the **server-side** Vercel environment variable `SHIFTBRIDGE_RENDER_URL`. It preserves query strings and JSON bodies.
- `/api/events` intentionally returns 204 from the Vercel proxy. The existing `/api/sync` polling remains active, since long-lived SSE is not reliable in standard serverless functions.

## Required Vercel configuration

In the **Vercel project serving `shiftbr.vercel.app`**, open Settings → Environment Variables, add:

```text
SHIFTBRIDGE_RENDER_URL=https://YOUR-RENDER-WEB-SERVICE.onrender.com
```

Do not append `/api` or a trailing path. Use the public **Render Web Service** URL, not the Supabase URL or your Vercel URL. Redeploy the **same Vercel project** from the GitHub `main` branch after adding the variable.

**Do not set `SUPABASE_SECRET_KEY` or `GROQ_API_KEY` in Vercel.** They belong on Render only.

Make sure the Render service:

1. Deploys `Arrjack8847/Shiftbridge` from `main`;
2. Has Build Command `npm ci` and Start Command `npm start`;
3. Returns JSON at `https://YOUR-RENDER-WEB-SERVICE.onrender.com/api/health`;
4. Holds `SHIFTBRIDGE_STORAGE=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AI_PROVIDER=groq`, and `GROQ_API_KEY` in its own environment if cloud persistence/AI is enabled.

## Validation

1. Open `https://shiftbr.vercel.app/api/health`. It should return JSON containing `ok: true` if both deployments are configured. If it returns `503 BACKEND_NOT_CONFIGURED`, set the Vercel environment variable and redeploy.
2. Open `https://shiftbr.vercel.app/api/workspaces`. It should return JSON (not a Vercel HTML 404 page).
3. Load the frontend in a new tab, send a test chat message, and confirm the POST `/api/workspaces/daily/messages` succeeds.
4. Verify the message on a second device and in Supabase after the next cloud sync.

If `/api/health` still returns Vercel `NOT_FOUND`, the Vercel project is likely not deploying the updated repository or is using the wrong Root Directory. The updated `vercel.json` and `api/proxy.js` must be at that project's deployment root.

**Security:** This is still an unauthenticated hackathon demo. Anyone with the URL can impersonate demo users. Restrict public access or add real authentication before handling real business data.
