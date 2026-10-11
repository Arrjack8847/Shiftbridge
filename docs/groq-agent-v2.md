# ShiftBridge Agent V2 — Groq API

**Default provider:** Groq-hosted LLM through an OpenAI-compatible Chat Completions API. Tencent CodeBuddy is no longer required and is an optional legacy provider.

## Configure the API key privately

1. Open [Groq Console](https://console.groq.com/keys), create an API key, and keep it private.
2. Clone or update the `feat/agent-v2-groq-20261011` branch.
3. From PowerShell in the repository root:

```powershell
Copy-Item .env.example .env
notepad .env
```

Replace `replace_with_your_groq_api_key` with your real key inside **your local** `.env`. Never commit the `.env` file or paste the key into chat.

Default configuration:

```dotenv
AI_PROVIDER=groq
GROQ_API_KEY=your_private_key_here
GROQ_MODEL=openai/gpt-oss-120b
GROQ_TIMEOUT_MS=25000
SHIFTBRIDGE_API=http://127.0.0.1:3000/api
```

Node uses `--env-file-if-exists=.env`. Set `GROQ_MODEL=openai/gpt-oss-20b` if you want to compare model latency/price; check Groq's current model support before changing again. Groq requests are server-side only.

## Check and start

```powershell
npm ci
npm run check
npm run test:messages
npm run test:agent-v2
npm run test:groq
npm run dev
```

Open http://localhost:3000 and select the **Manager** demo identity. No CodeBuddy process or MCP server is required.

## What changed

- Groq is the default `AI_PROVIDER`. The fast deterministic detector still handles simple warnings and clear manager tasks without calling any paid model.
- Ambiguous messages trigger one Groq API call with recent chat (latest messages, not oldest), open incident links, active tasks, workspace members/rules and up to six manager-reviewed examples.
- Groq must return JSON actions; the backend validates action types, limits actions to three, and checks real database identities. Model prose never counts as an executed action.
- Routine manager actions may create tasks; protected work creates review proposals. Employee completion statements are **claims**, processed under existing verification rules.
- Clear or model-detected faults are stored as unverified incidents. Follow-up chat can link to an existing issue; manager-disputed links are excluded from future AI memory.
- AI never posts to the shared workplace chat or publishes announcements.

## Simulated demo conversation

Use Daily Brew Café's one shared chat:

1. Manager: `Emma, please restock the paper cups before 5 PM.` — fast routine task.
2. Emma: `The printer sounds awful and keeps making a grinding noise.` — Groq analyzes an indirect warning and may file a **reported**, unverified issue.
3. Emma: `It's still making the same grinding noise.` — Groq should use recent context to link it to the existing printer issue.
4. Manager: `Sarah, arrange a qualified inspection of the broken printer.` — protected work requires review, no repair authorization.
5. Open **Manage → Needs Attention** to view linked incident messages and mark correct/wrong detections.

The model's semantic decisions depend on the API response and must be tested with your live key. Manager feedback currently supplies labeled examples in later prompts; it **does not retrain** Groq or update model weights.

## Diagnostics

- `GET /api/workspaces/daily/groq-status` — current model and pending/completed/failed jobs.
- `POST /api/groq/retry-pending` — manually retry eligible pending jobs.
- `npm run test:groq` — isolated end-to-end test with a LOCAL mock Groq API and temporary SQLite database. No real API key or remote network call.
- `npm run test:agent-v2` — contextual memory, incident linking, manager feedback and safety rules.
- Groq API errors may indicate key, quota, rate-limit, unavailable model, network connectivity, or model format problems. Check server output for error details.

## Security

This hackathon demo has simulated identities, not authentication. Do not expose it on the public Internet or use it for real sensitive operational data. Store API keys only in server-side environment variables. Human verification is mandatory for sensitive repairs, spending and safety clearance.
