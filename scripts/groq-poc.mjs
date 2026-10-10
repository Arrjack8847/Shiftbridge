/**
 * scripts/groq-poc.mjs — ShiftBridge + Groq API Proof of Concept
 *
 * This is a STANDALONE script that proves the Groq API can:
 *   1. Read workspace context from ShiftBridge (messages, tasks, rules, people)
 *   2. Analyze a new chat message using Groq's LLM
 *   3. Return structured JSON actions (propose task, flag issue, etc.)
 *   4. Validate the response format
 *
 * No application code is modified. This script only READS from the
 * ShiftBridge API and calls the Groq API — it does NOT execute any
 * returned actions. That's by design: prove the concept first, integrate later.
 *
 * Usage:
 *   set GROQ_API_KEY=gsk_xxx
 *   node scripts/groq-poc.mjs
 *
 * Or pass the key as an argument:
 *   node scripts/groq-poc.mjs gsk_xxx
 *
 * Requires: ShiftBridge backend running at http://localhost:3000
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY || process.argv[2];
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const SHIFTBRIDGE_API = process.env.SHIFTBRIDGE_API || 'http://localhost:3000/api';
const WORKSPACE = 'daily'; // Default workspace for the demo

// ────────────────────────────────────────────────────────────────────
// HTTP helper
// ────────────────────────────────────────────────────────────────────
async function apiGet(path) {
  const res = await fetch(`${SHIFTBRIDGE_API}${path}`);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ────────────────────────────────────────────────────────────────────
// Fetch workspace context
// ────────────────────────────────────────────────────────────────────
async function fetchWorkspaceContext(workspaceId) {
  console.log('[1/4] Fetching workspace context from ShiftBridge...\n');

  const [peopleRes, workspacesRes, messagesRes, tasksRes] = await Promise.all([
    apiGet('/people'),
    apiGet('/workspaces'),
    apiGet(`/workspaces/${workspaceId}/messages?limit=10`),
    apiGet(`/workspaces/${workspaceId}/tasks`),
  ]);

  // Extract rules for this workspace
  const ws = workspacesRes.workspaces?.find(w => w.id === workspaceId);
  const rules = ws?.rules || [];
  const members = ws?.members || [];

  // Messages are returned ORDER BY seq ASC (oldest first, newest last)
  const messages = messagesRes.messages || [];
  const latestMessage = messages[messages.length - 1] || null;

  // Get active tasks (not done)
  const tasks = (tasksRes.tasks || []).filter(t => t.status !== 'done');

  console.log(`  People:     ${peopleRes.length} team members`);
  console.log(`  Messages:   ${messages.length} recent messages`);
  console.log(`  Tasks:      ${tasks.length} active tasks (excluding done)`);
  console.log(`  Rules:      ${rules.length} workspace rules`);
  console.log(`  Members:    ${members.map(m => m.name).join(', ')}`);

  return { people: peopleRes, messages, tasks, rules, members, latestMessage };
}

// ────────────────────────────────────────────────────────────────────
// Build the system prompt
// ────────────────────────────────────────────────────────────────────
function buildSystemPrompt(context) {
  const { people, rules, members } = context;

  const peopleList = people.map(p => `${p.id} (${p.name}, ${p.role})`).join(', ');
  const rulesList = rules.map(r => `- ${r.id}: "${r.name}" — ${r.note} | allowed: ${r.allowed}${r.locked ? ' (LOCKED)' : ''}`).join('\n');

  return `You are ShiftBridge AI, an intelligent assistant for a small-business shift management platform.

## Your Role
You analyze chat messages from team members and determine what actions, if any, should be taken. You NEVER post messages to the chat yourself. You only PROPOSE actions for the backend to execute.

## Team Members
${peopleList}

## Workspace Rules (Safety Constraints)
${rulesList}

## CRITICAL SAFETY RULES
1. **Protected categories** (repairs, purchases, safety) are LOCKED and require qualified human verification. You may NOT auto-approve or auto-complete tasks in these categories. You can only create proposals that require manager review.
2. **Permissions**: Only the workspace manager (admin role) can create tasks directly, publish announcements, or archive announcements. Employees can report issues, claim task completion, and request help.
3. **No duplicate actions**: If a task or proposal already exists for a message, do not create another.
4. **You do not post to chat**: Your response is structured JSON only, processed by the backend.

## Available Action Types
Respond with a JSON object containing an "actions" array. Each action has one of these types:

1. **propose_task** — Propose a new task for manager review
   { "type": "propose_task", "name": "...", "description": "...", "assignee": "employee_id", "priority": "normal|urgent", "category": "inventory|cleaning|opening|routine", "due": "Today", "confidence": "high|medium|low", "reasoning": "..." }

2. **propose_completion** — An employee claims a task is complete
   { "type": "propose_completion", "taskId": "t_xxx", "messageId": "m_xxx", "reportingEmployee": "employee_id", "claimType": "completion|progress", "confidence": "high|medium|low", "reasoning": "..." }

3. **report_issue** — Flag an operational issue from a chat message
   { "type": "report_issue", "messageId": "m_xxx", "reporterId": "employee_id", "title": "...", "issueType": "equipment|supply|safety|staffing|general", "confidence": "high|medium|low", "reasoning": "..." }

4. **draft_announcement** — Suggest an announcement for the manager to review
   { "type": "draft_announcement", "title": "...", "body": "...", "announcementType": "notice|alert|reminder", "confidence": "high|medium|low", "reasoning": "..." }

5. **no_action** — The message doesn't require any action
   { "type": "no_action", "reasoning": "..." }

## Response Format
Respond with ONLY a JSON object (no markdown, no code fences, no explanation outside JSON):
{
  "actions": [
    {
      "type": "propose_task",
      "name": "Restock milk containers",
      "description": "Jack mentioned we are running low on milk",
      "assignee": "jack",
      "priority": "normal",
      "category": "inventory",
      "due": "Today",
      "confidence": "high",
      "reasoning": "Jack explicitly stated milk is running low. Inventory category is allowed."
    }
  ],
  "analysis": "Brief summary of what the messages indicate about the workspace state"
}

Analyze the latest messages and determine what actions should be taken. If no action is needed, return an empty actions array with an explanation in analysis.`;
}

// ────────────────────────────────────────────────────────────────────
// Build the user prompt with workspace context
// ────────────────────────────────────────────────────────────────────
function buildUserPrompt(context) {
  const { messages, tasks, people } = context;

  // Build a lookup map: userId -> { name, role }
  const peopleMap = new Map(people.map(p => [p.id, p]));

  const messagesText = messages.map(m => {
    const person = peopleMap.get(m.user) || {};
    const name = person.name || m.user;
    const role = person.role || 'unknown';
    return `[${m.seq}] ${name} (${role}): "${m.body}"${m.id ? ` (id: ${m.id})` : ''}`;
  }).join('\n');

  const tasksText = tasks.map(t =>
    `- ${t.id}: "${t.name}" | status: ${t.status} | assignee: ${t.assignee || 'unassigned'} | category: ${t.category || 'routine'} | verification: ${t.verification || 'self-report'}${t.protected ? ' [PROTECTED]' : ''}`
  ).join('\n');

  return `## Recent Chat Messages (newest last)
${messagesText || '(no messages)'}

## Active Tasks
${tasksText || '(no active tasks)'}

## Instructions
Analyze the LATEST message(s) and determine what actions should be taken. Focus on the most recent message. Consider the context of ongoing tasks and workspace rules.`;
}

// ────────────────────────────────────────────────────────────────────
// Call the Groq API
// ────────────────────────────────────────────────────────────────────
async function callGroqAPI(systemPrompt, userPrompt) {
  console.log('\n[2/4] Calling Groq API...\n');
  console.log(`  Model:    ${GROQ_MODEL}`);
  console.log(`  Endpoint: ${GROQ_API_URL}`);

  const requestBody = {
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,       // Low temperature for consistent, structured output
    max_tokens: 2048,
    response_format: { type: 'json_object' }, // Groq supports JSON mode
  };

  const startTime = Date.now();

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  const elapsed = Date.now() - startTime;

  if (!res.ok) {
    const errorText = await res.text();
    let errorJson;
    try { errorJson = JSON.parse(errorText); } catch { errorJson = { raw: errorText }; }
    throw new Error(`Groq API error ${res.status}: ${JSON.stringify(errorJson)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';

  console.log(`  Latency:  ${elapsed}ms`);
  console.log(`  Tokens:   ${data.usage?.total_tokens || 'N/A'} (prompt: ${data.usage?.prompt_tokens}, completion: ${data.usage?.completion_tokens})`);
  console.log(`  Model:    ${data.model || GROQ_MODEL}`);

  return { content, elapsed, usage: data.usage };
}

// ────────────────────────────────────────────────────────────────────
// Validate the Groq response
// ────────────────────────────────────────────────────────────────────
function validateResponse(content) {
  console.log('\n[3/4] Validating response...\n');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { valid: false, error: `Invalid JSON: ${e.message}`, raw: content };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, error: 'Response is not a JSON object', raw: content };
  }

  if (!Array.isArray(parsed.actions)) {
    return { valid: false, error: 'Missing or invalid "actions" array', raw: content };
  }

  const validTypes = ['propose_task', 'propose_completion', 'report_issue', 'draft_announcement', 'no_action'];
  const issues = [];

  for (let i = 0; i < parsed.actions.length; i++) {
    const action = parsed.actions[i];
    if (!action.type || !validTypes.includes(action.type)) {
      issues.push(`Action ${i}: invalid or missing "type" (got "${action.type}")`);
      continue;
    }
    if (!action.reasoning) {
      issues.push(`Action ${i} (${action.type}): missing "reasoning"`);
    }
    if (!action.confidence) {
      issues.push(`Action ${i} (${action.type}): missing "confidence"`);
    }

    // Type-specific validation
    switch (action.type) {
      case 'propose_task':
        if (!action.name) issues.push(`Action ${i} (propose_task): missing "name"`);
        if (action.category && ['repairs', 'purchases', 'safety'].includes(action.category)) {
          issues.push(`Action ${i} (propose_task): category "${action.category}" is PROTECTED — should not be auto-assigned`);
        }
        break;
      case 'propose_completion':
        if (!action.taskId) issues.push(`Action ${i} (propose_completion): missing "taskId"`);
        if (!action.messageId) issues.push(`Action ${i} (propose_completion): missing "messageId"`);
        if (!action.reportingEmployee) issues.push(`Action ${i} (propose_completion): missing "reportingEmployee"`);
        break;
      case 'report_issue':
        if (!action.messageId) issues.push(`Action ${i} (report_issue): missing "messageId"`);
        if (!action.reporterId) issues.push(`Action ${i} (report_issue): missing "reporterId"`);
        break;
      case 'draft_announcement':
        if (!action.title) issues.push(`Action ${i} (draft_announcement): missing "title"`);
        if (!action.body) issues.push(`Action ${i} (draft_announcement): missing "body"`);
        break;
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    parsed,
  };
}

// ────────────────────────────────────────────────────────────────────
// Display results
// ────────────────────────────────────────────────────────────────────
function displayResults(context, groqResult, validation) {
  console.log('\n[4/4] Results\n');
  console.log('═'.repeat(70));

  if (!validation.valid) {
    console.log('VALIDATION ISSUES:');
    for (const issue of validation.issues) {
      console.log(`  - ${issue}`);
    }
    console.log('\nRaw response:');
    console.log(validation.raw || groqResult.content);
    return false;
  }

  const { parsed } = validation;

  console.log(`Analysis: ${parsed.analysis || '(none provided)'}`);
  console.log(`Actions:   ${parsed.actions.length}`);
  console.log('─'.repeat(70));

  for (let i = 0; i < parsed.actions.length; i++) {
    const a = parsed.actions[i];
    console.log(`\n  Action ${i + 1}: ${a.type.toUpperCase()}`);
    console.log(`  Confidence: ${a.confidence || 'N/A'}`);
    console.log(`  Reasoning:  ${a.reasoning}`);

    switch (a.type) {
      case 'propose_task':
        console.log(`  Name:       ${a.name}`);
        console.log(`  Assignee:   ${a.assignee || 'unassigned'}`);
        console.log(`  Category:  ${a.category || 'routine'}`);
        console.log(`  Priority:  ${a.priority || 'normal'}`);
        console.log(`  Due:       ${a.due || 'Today'}`);
        console.log(`  Desc:      ${a.description || '(none)'}`);
        break;
      case 'propose_completion':
        console.log(`  Task ID:        ${a.taskId}`);
        console.log(`  Message ID:     ${a.messageId}`);
        console.log(`  Employee:       ${a.reportingEmployee}`);
        console.log(`  Claim Type:     ${a.claimType || 'completion'}`);
        break;
      case 'report_issue':
        console.log(`  Message ID:  ${a.messageId}`);
        console.log(`  Reporter:    ${a.reporterId}`);
        console.log(`  Title:       ${a.title || '(none)'}`);
        console.log(`  Issue Type:  ${a.issueType || 'general'}`);
        break;
      case 'draft_announcement':
        console.log(`  Title:  ${a.title}`);
        console.log(`  Type:   ${a.announcementType || 'notice'}`);
        console.log(`  Body:   ${a.body}`);
        break;
      case 'no_action':
        console.log(`  (no action needed)`);
        break;
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log('\nLatency breakdown:');
  console.log(`  Groq API call: ${groqResult.elapsed}ms`);
  console.log(`  Total tokens:  ${groqResult.usage?.total_tokens || 'N/A'}`);

  // Show the latest message that was analyzed
  const latest = context.latestMessage;
  if (latest) {
    const person = context.people.find(p => p.id === latest.user);
    const name = person?.name || latest.user;
    console.log(`\nLatest message analyzed:`);
    console.log(`  [${latest.seq}] ${name}: "${latest.body}"`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('POC STATUS: SUCCESS - Groq API returned valid structured actions');
  console.log('='.repeat(70));

  return true;
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(70));
  console.log('  ShiftBridge + Groq API — Proof of Concept');
  console.log('═'.repeat(70));
  console.log();

  // ── Validate prerequisites ────────────────────────────────────────
  if (!GROQ_API_KEY) {
    console.error('ERROR: No Groq API key provided.');
    console.error('Usage: set GROQ_API_KEY=gsk_xxx && node scripts/groq-poc.mjs');
    console.error('   or: node scripts/groq-poc.mjs gsk_xxx');
    process.exit(1);
  }

  // Check backend is running
  try {
    await apiGet('/health');
    console.log(`Backend: ${SHIFTBRIDGE_API} — healthy\n`);
  } catch {
    console.error(`ERROR: ShiftBridge backend is not running at ${SHIFTBRIDGE_API}`);
    console.error('Start it with: npm run dev');
    process.exit(1);
  }

  // ── 1. Fetch workspace context ───────────────────────────────────
  const context = await fetchWorkspaceContext(WORKSPACE);

  if (!context.latestMessage) {
    console.log('\nNo messages found in workspace. Sending a test message first...');

    // Send a test message to have something to analyze
    const testMsg = {
      id: `m_poc_${Date.now().toString(36)}`,
      user: 'jack',
      body: "Hey team, we're running low on oat milk. Can someone restock before the afternoon rush? Also, the espresso machine is making a weird noise again.",
    };

    const res = await fetch(`${SHIFTBRIDGE_API}/workspaces/${WORKSPACE}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testMsg),
    });

    if (res.ok) {
      console.log(`  Test message sent: "${testMsg.body}"`);
      // Refetch context
      const newMsgs = await apiGet(`/workspaces/${WORKSPACE}/messages?limit=10`);
      context.messages = (newMsgs.messages || []).reverse();
      context.latestMessage = context.messages[context.messages.length - 1];
    }
  }

  // ── 2. Build prompts ──────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(context);
  const userPrompt = buildUserPrompt(context);

  console.log(`\n  System prompt: ${systemPrompt.length} chars`);
  console.log(`  User prompt:   ${userPrompt.length} chars`);

  // ── 3. Call Groq API ──────────────────────────────────────────────
  const groqResult = await callGroqAPI(systemPrompt, userPrompt);

  // ── 4. Validate & display ─────────────────────────────────────────
  const validation = validateResponse(groqResult.content);
  const success = displayResults(context, groqResult, validation);

  process.exit(success ? 0 : 1);
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err.message);
  process.exit(1);
});
