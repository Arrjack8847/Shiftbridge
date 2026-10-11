# ShiftBridge Supabase integration

**Project:** [hackathon](https://supabase.com/dashboard/project/jpkobdggdsuinsquchxp), `https://jpkobdggdsuinsquchxp.supabase.co`.

## Two modes

- Default `SHIFTBRIDGE_STORAGE=sqlite`: identical existing local behavior.
- Opt-in `SHIFTBRIDGE_STORAGE=supabase`: one-instance hackathon persistence adapter. The app runs existing SQLite transactions and mirrors all 19 tables to Supabase approximately every 3 seconds, and restores cloud state before serving requests on subsequent boot. **Not** native Postgres transactions or multi-instance-safe replication. Cloud backups are eventually consistent, and in-flight changes may be lost on crash. Never run two backend instances at once.

All `sb_*` tables have RLS enabled and no public grants. The user-provided publishable key is NOT enough for backend writes.

## Render Environment

```dotenv
SHIFTBRIDGE_STORAGE=supabase
SUPABASE_URL=https://jpkobdggdsuinsquchxp.supabase.co
SUPABASE_SECRET_KEY=your_sb_secret_key_from_supabase_dashboard
SUPABASE_SYNC_INTERVAL_MS=3000
AI_PROVIDER=groq
GROQ_API_KEY=your_groq_key
```

**Only** set `SUPABASE_SECRET_KEY` in Render's environment settings, not in source, frontend, GitHub, or a chat message. [Supabase secret key dashboard](https://supabase.com/dashboard/project/jpkobdggdsuinsquchxp/settings/api-keys).

Startup will fail rather than accidentally serve an empty demo if configured cloud access fails. Once started, `GET /api/health` includes `persistence` mode, last successful sync and last error. Test with a message, a task update, then inspect the matching `sb_messages` and `sb_tasks` tables in Supabase.

To run locally, add the same values to gitignored `.env`, then `npm run dev`.

## Architecture caveats

- No authentication in the demo. Anyone with access to the public API can impersonate demo users; **do not expose the app with sensitive data** without adding backend access controls.
- One backend writer only. SQLite provides existing task verification transactions locally, but Supabase snapshots are not an atomic remote transaction. Never scale Render to multiple instances with this adapter.
- Cloud sync is a snapshot mechanism, not a guaranteed durable queue. For genuine production use, migrate operations and protected-work verification to native Postgres transactions, implement real authentication/authorization and a durable job queue.
- Existing snapshot utility `npm run supabase:sync` is an explicit one-time manual copy; the opt-in runtime adapter is separate.
- Table additions for Agent V2: `sb_issue_message_links`, `sb_ai_feedback`, plus issue entity fields.
