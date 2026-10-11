# ShiftBridge + Supabase (safe rollout)

Database project: **hackathon** (`jpkobdggdsuinsquchxp`, ap-northeast-1).

## Status
- Cloud schema has 17 isolated `sb_*` tables matching the current SQLite model, including AI jobs, completion claims, audit history and announcements.
- Row level security is enabled on **all** cloud tables. Anonymous and authenticated browser roles have **no table privileges and no policies**.
- SQLite remains the live source of truth. Supabase is **not** wired to live API handlers yet.
- The existing frontend and tests continue to use Express and local SQLite. No auth is added for the hackathon demo.
- The data snapshot script is opt-in and not a realtime migration or two-way sync.

## Setup on your laptop

1. Open the [hackathon API settings](https://supabase.com/dashboard/project/jpkobdggdsuinsquchxp/settings/api-keys) and create/copy a **secret** API key (not publishable).
2. At project root, add the following to local `.env` (not tracked by Git):
   ```dotenv
   SUPABASE_URL=https://jpkobdggdsuinsquchxp.supabase.co
   SUPABASE_SECRET_KEY=YOUR_SERVER_SECRET_KEY
   ```
3. Run `npm run supabase:check`. This tests read-only connection.
4. To copy your existing SQLite rows up, add `SUPABASE_SYNC_CONFIRM=YES` to your local environment temporarily, then run `npm run supabase:sync`. Remove that flag afterwards.

The snapshot **upserts** rows by primary key, so existing remote rows with the same IDs can be overwritten. It does not delete remote records. Use it only when the local SQLite data is the data you intend to upload. The script may partially upload before failure; retry after correcting the issue.

## Why this is staged
The Express endpoints and MCP tools use **synchronous better-sqlite3 queries** in multiple modules. Replacing their database calls with asynchronous Supabase REST requests without a refactor would break task completion, manager approval, AI queue processing, and existing tests. This stage safely prepares the cloud data model and transfers a snapshot.

For **live shared deployment**, next build a Postgres-backed repository/data-access layer, convert routes and agent tools to async database calls, add transaction-safe task verification and job claiming, then switch the backend storage provider. Do not claim multiple-server real-time sync from this snapshot.

## Security before public deployment
The demo currently allows choosing someone else's identity, and role-specific endpoints trust demo identities. **Do not publish the Express API unprotected**. Before public deployment add real authentication and verify workspace membership and administrative role server-side; use RLS for user-scoped direct Supabase reads only after authentication is designed. Keep `SUPABASE_SECRET_KEY` and `GROQ_API_KEY` exclusively server-side, never in source code or the browser.

## Files
- `supabase/migrations/20261011030000_shiftbridge_supabase_foundation.sql`: initial cloud schema
- `server/supabase-check.js`: cloud connection test
- `server/supabase-sync.js`: explicit SQLite to Supabase snapshot

Supabase dashboard: https://supabase.com/dashboard/project/jpkobdggdsuinsquchxp
