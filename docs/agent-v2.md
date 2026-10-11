# ShiftBridge Agent V2 — Context, Incident Memory and Manager Feedback

This is a hackathon/demo implementation. **No authentication** is present: identities are simulated. Never expose this backend to the public Internet or process real sensitive workplace records without adding authentication and authorization.

## Improvements

1. **Recent context:** the agent and frontend use \`GET /api/workspaces/:workspace/messages?latest=1&limit=20\` to retrieve the **newest** messages, sorted chronologically. Existing forward-cursor pagination is unchanged.
2. **Incident memory:** a new \`issue_message_links\` table links multiple real messages to one active incident. Every source message is validated in the same workspace, audited and deduplicated. Resolved incidents cannot be reopened by the AI.
3. **Fast same-equipment linking:** messages that explicitly name the same equipment (e.g., "Machine 2") link to its existing unresolved issue. Vague pronouns ("it") are not automatically linked. They go to Tencent for contextual reasoning.
4. **Tencent context:** the model gets current tasks, last 20 chat messages, unresolved incidents with linked evidence, and the latest manager-reviewed examples. It can use \`get_incident_context\` and \`link_incident_message\` MCP tools. A successful tool call must leave an actual database link, not just a textual success claim.
5. **Manager feedback:** the Manage > Needs Attention > Issue screen records "Correct report" or "False alarm" examples in \`ai_feedback\`, linked to real message/issue IDs. Reviewed examples help subsequent AI prompts and can be used for offline evaluations; **model weights are not fine-tuned or automatically retrained**.
6. **Safety:** all fault reports are **unverified claims**; inspection scheduled and "technician fixed it" are never evidence of verified clearance. A direct \`PUT /api/issues/:id\` cannot resolve incidents; the designated qualified-verification endpoint must be used.

## Data model

- \`issues.entity_key\`: conservative equipment identifier (e.g., \`machine-2\`); nullable when ambiguous.
- \`issues.last_activity_at\`: date/time of newest linked evidence.
- \`issue_message_links\`: workspace / incident / original message / relation / reviewer provenance / reason / time.
- \`ai_feedback\`: workspace / issue / original message / manager verdict / note / time.

SQLite migrations apply when the backend starts. Do **not** use the demo reset endpoint unless you intend to erase local demo data.

## New endpoints

- \`GET /api/workspaces/:workspace/incident-context\` — currently unresolved incidents and recent manager feedback examples.
- \`POST /api/workspaces/:workspace/incidents/:issueId/link-message\` — requires \`messageId\`, \`relation\`, and an evidence-backed \`reason\`; checks workspace isolation.
- \`POST /api/workspaces/:workspace/agent-feedback\` — source-linked manager verdict.
- \`GET /api/workspaces/:workspace/agent-feedback?reviewerId=manager\` — recent reviewed examples.
- Existing issue endpoints now return \`linkedMessages\` for an incident timeline.

## Isolated automated tests

\`\`\`powershell
cd "$env:USERPROFILE\Shiftbridge-Tencent-Test"
git fetch origin
git switch --track origin/feat/agent-v2-context-memory-20261011
npm ci
npm run check
npm run test:messages
npm run test:tencent
npm run test:agent-v2
\`\`\`

\`test:agent-v2\` spawns a backend on a temporary port with a temporary SQLite database, **does not call CodeBuddy**, and checks recent-message ordering, incident reuse, source linking, duplicate prevention, workspace isolation, safety escalation, anti-bypass policy, feedback, and manager example retrieval.

GitHub Actions also runs these checks on the V2 branch. CodeBuddy live E2E still requires an authenticated installation and explicit CLI write configuration.

## Local Tencent demo

After tests complete, run this from the test folder:

\`\`\`powershell
$env:AI_PROVIDER = "tencent-local"
$env:CODEBUDDY_EXECUTION_MODE = "cli"
$env:SHIFTBRIDGE_API = "http://127.0.0.1:3000/api"
$env:CODEBUDDY_CLI_MCP_TARGET = "http://127.0.0.1:3000/api"
$env:CODEBUDDY_CLI_ENABLE_WRITES = "true"
npm run dev
\`\`\`

Use http://localhost:3000 in a browser. In the **Daily Brew Café** workspace, test one continuous conversation:

1. Emma: "Machine 2 is leaking again." → reported, unverified incident.
2. Jack: "Machine 2 is still leaking." → one existing incident with two linked messages, not two issues.
3. Jack: "There's water under it again." → Tencent should consider previous context and, if unambiguous, attach the update to the incident. This step exercises **live** CodeBuddy; it is not covered by the fake/isolated adapter test.
4. Manager: "Sarah, arrange a qualified technician inspection of Machine 2." → protected category / review policy applies.
5. Sarah: "Technician is coming tomorrow." → progress evidence, **not** verified repair or closure.
6. Go to Manage > Needs Attention > the issue. Confirm chronological timeline, and choose Correct report or False alarm. Future Tencent analysis receives recent manager-reviewed labels.

This branch aims to reduce redundant full-model runs and context misreads. Actual latency and semantic accuracy require measurement with your local CodeBuddy session. Never claim every case is correctly understood until a real-device test proves it.
