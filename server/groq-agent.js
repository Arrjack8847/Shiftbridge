/**
 * server/groq-agent.js — ShiftBridge Groq AI Agent
 *
 * Event-driven AI processing for ShiftBridge. When a new chat message
 * is saved, the server fires this agent asynchronously (non-blocking).
 * The agent:
 *   1. Fetches workspace context (messages, tasks, rules, people)
 *   2. Calls the Groq API (OpenAI-compatible format)
 *   3. Parses structured JSON actions from the LLM response
 *   4. Executes each action via the ShiftBridge REST API
 *   5. SSE pushes updates to all connected clients
 *   6. Logs results to ai_analysis_log + ai_jobs table
 *
 * Safety:
 *   - The system prompt enforces workspace rules and protected categories
 *   - All actions go through the existing API endpoints, which apply
 *     server-side validation, dedup, and permission checks
 *   - The AI NEVER posts to chat directly
 *
 * Reliability:
 *   - Failed jobs stay in the ai_jobs table for retry
 *   - The hourly automation can call processPendingJobs() as recovery
 *   - Max 3 retry attempts per job
 *
 * Configuration (environment variables):
 *   GROQ_API_KEY    — Required. API key from console.groq.com
 *   GROQ_MODEL      — Optional. Default: openai/gpt-oss-120b
 *   SHIFTBRIDGE_API — Optional. Default: http://localhost:3000/api
 *   GROQ_ENABLED    — Optional. Set to "0" to disable. Default: enabled
 */

import { getDB, bumpRevision, currentRevision } from './db.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const SHIFTBRIDGE_API = process.env.SHIFTBRIDGE_API || 'http://localhost:3000/api';
const GROQ_ENABLED = process.env.GROQ_ENABLED !== '0';

// Track in-flight jobs to prevent concurrent processing of the same message
const inFlight = new Set();

// ─── HTTP helper ──────────────────────────────────────────────────
async function apiRequest(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SHIFTBRIDGE_API}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function apiGet(path) {
  const { ok, json } = await apiRequest('GET', path);
  if (!ok) throw new Error(json.error || `HTTP ${json.status || 'error'}`);
  return json;
}

async function apiPost(path, body) {
  const { ok, json } = await apiRequest('POST', path, body);
  return { ok, json };
}

// ─── People cache ─────────────────────────────────────────────────
let peopleCache = null;
let peopleCacheAt = 0;

async function getPeople() {
  // Cache for 60 seconds to avoid repeated fetches
  if (peopleCache && Date.now() - peopleCacheAt < 60000) return peopleCache;
  try {
    const res = await apiGet('/people');
    peopleCache = res || [];
    peopleCacheAt = Date.now();
    return peopleCache;
  } catch {
    return peopleCache || [];
  }
}

// ─── Build system prompt ──────────────────────────────────────────
function buildSystemPrompt(people, rules) {
  const peopleList = people.map(p => `${p.id} (${p.name}, ${p.role})`).join(', ');
  const rulesList = rules.map(r =>
    `- ${r.id}: "${r.name}" — ${r.note} | allowed: ${r.allowed}${r.locked ? ' (LOCKED)' : ''}`
  ).join('\n');

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

1. **propose_task** — Propose a new task for manager review (use when a manager gives an instruction that maps to an allowed category)
   { "type": "propose_task", "name": "...", "description": "...", "assignee": "employee_id", "priority": "normal|urgent", "category": "inventory|cleaning|opening|routine", "due": "Today", "confidence": "high|medium|low", "reasoning": "..." }

2. **propose_completion** — An employee claims a task is complete (match the task by name or ID)
   { "type": "propose_completion", "taskId": "t_xxx", "messageId": "m_xxx", "reportingEmployee": "employee_id", "claimType": "completion|progress", "confidence": "high|medium|low", "reasoning": "..." }

3. **report_issue** — Flag an operational issue from a chat message (equipment, supply, safety, staffing)
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

Analyze the latest message and determine what actions should be taken. If no action is needed, return an empty actions array with an explanation in analysis.`;
}

// ─── Build user prompt ────────────────────────────────────────────
function buildUserPrompt(messages, tasks, people, newMessage) {
  const peopleMap = new Map(people.map(p => [p.id, p]));

  const messagesText = messages.map(m => {
    const person = peopleMap.get(m.user) || {};
    const name = person.name || m.user;
    const role = person.role || 'unknown';
    return `[${m.seq}] ${name} (${role}): "${m.body}" (id: ${m.id})`;
  }).join('\n');

  const tasksText = tasks.map(t =>
    `- ${t.id}: "${t.name}" | status: ${t.status} | assignee: ${t.assignee || 'unassigned'} | category: ${t.category || 'routine'} | verification: ${t.verification || 'self-report'}${t.protected ? ' [PROTECTED]' : ''}`
  ).join('\n');

  return `## Recent Chat Messages (newest last)
${messagesText || '(no messages)'}

## Active Tasks
${tasksText || '(no active tasks)'}

## NEW MESSAGE TO ANALYZE
From: ${newMessage.user} (${peopleMap.get(newMessage.user)?.role || 'unknown'})
Body: "${newMessage.body}"
Message ID: ${newMessage.id}

## Instructions
Analyze the NEW MESSAGE above and determine what actions should be taken. Consider the context of ongoing tasks and workspace rules.`;
}

// ─── Execute an action via the ShiftBridge API ────────────────────
async function executeAction(workspaceId, action, sourceMessageId) {
  try {
    let result;

    switch (action.type) {
      case 'propose_task': {
        // Create a manager task if the message is from the manager,
        // otherwise create an AI proposal for manager review.
        result = await apiPost(`/workspaces/${workspaceId}/manager-task`, {
          sourceMessageId,
          name: action.name,
          description: action.description || '',
          assignee: action.assignee || null,
          priority: action.priority || 'normal',
          category: action.category || 'routine',
          due: action.due || 'Today',
          reasoning: action.reasoning || '',
          createdBy: 'groq-ai',
        });

        // If manager-task fails (e.g., not from manager), fall back to proposal
        if (!result.ok && result.json?.error?.includes('not authored by the workspace manager')) {
          result = await apiPost(`/workspaces/${workspaceId}/proposals`, {
            type: 'task_proposal',
            summary: action.name,
            evidence: [action.description || ''],
            reasoning: action.reasoning || '',
            confidence: action.confidence || 'medium',
            proposedData: {
              name: action.name,
              description: action.description || '',
              assignee: action.assignee || null,
              priority: action.priority || 'normal',
              category: action.category || 'routine',
              due: action.due || 'Today',
            },
            sourceMessageId,
          });
        }
        break;
      }

      case 'propose_completion': {
        result = await apiPost(`/workspaces/${workspaceId}/chat-completion`, {
          taskId: action.taskId,
          messageId: action.messageId || sourceMessageId,
          reportingEmployee: action.reportingEmployee,
          claimType: action.claimType || 'completion',
        });
        break;
      }

      case 'report_issue': {
        result = await apiPost(`/workspaces/${workspaceId}/report-issue`, {
          messageId: action.messageId || sourceMessageId,
          reporterId: action.reporterId,
          title: action.title || '',
          issueType: action.issueType || 'general',
        });
        break;
      }

      case 'draft_announcement': {
        result = await apiPost(`/workspaces/${workspaceId}/announcements`, {
          title: action.title,
          body: action.body,
          type: action.announcementType || 'notice',
          status: 'draft',
          createdBy: 'groq-ai',
        });
        break;
      }

      case 'no_action':
        result = { ok: true, json: { message: 'No action needed' } };
        break;

      default:
        result = { ok: false, json: { error: `Unknown action type: ${action.type}` } };
    }

    return {
      type: action.type,
      ok: result.ok,
      status: result.ok ? 'executed' : 'failed',
      result: result.json,
    };
  } catch (err) {
    return {
      type: action.type,
      ok: false,
      status: 'error',
      error: err.message,
    };
  }
}

// ─── Create a job in the ai_jobs table ────────────────────────────
function createJob(workspaceId, messageId) {
  const d = getDB();
  const ts = Date.now();

  // Check for an existing job with this message_id first (unique index)
  const existing = d.prepare('SELECT id FROM ai_jobs WHERE message_id = ?').get(messageId);
  if (existing) return existing.id;

  // No existing job — create a new one
  const jobId = `aj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  d.prepare(
    `INSERT OR IGNORE INTO ai_jobs (id, workspace_id, message_id, status, attempts, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, 3, ?, ?)`,
  ).run(jobId, workspaceId, messageId, ts, ts);
  return jobId;
}

// ─── Update job status ────────────────────────────────────────────
function updateJob(jobId, updates) {
  const d = getDB();
  const ts = Date.now();
  const setClauses = ['updated_at = ?'];
  const params = [ts];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      setClauses.push(`${key} = ?`);
      params.push(value);
    }
  }
  params.push(jobId);
  d.prepare(`UPDATE ai_jobs SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
}

// ─── Main: process a single message ───────────────────────────────
export async function processMessage(workspaceId, messageId, messageUser, messageBody) {
  // Always create a job record first — even if Groq is disabled,
  // so the message can be retried later when the key becomes available.
  const jobId = createJob(workspaceId, messageId);
  const d = getDB();

  if (!GROQ_ENABLED) {
    updateJob(jobId, { status: 'pending', last_error: 'Groq AI is disabled (GROQ_ENABLED=0)' });
    return { skipped: true, reason: 'Groq AI is disabled (GROQ_ENABLED=0)', jobId };
  }
  if (!GROQ_API_KEY) {
    updateJob(jobId, { status: 'pending', last_error: 'No GROQ_API_KEY set' });
    return { skipped: true, reason: 'No GROQ_API_KEY set', jobId };
  }

  // Prevent concurrent processing of the same message
  if (inFlight.has(messageId)) {
    return { skipped: true, reason: 'Already processing this message' };
  }
  inFlight.add(messageId);

  const startTime = Date.now();

  try {
    // Update job to processing
    updateJob(jobId, { status: 'processing', attempts: 1 });

    // 1. Fetch workspace context in parallel
    const [people, workspacesRes, messagesRes, tasksRes] = await Promise.all([
      getPeople(),
      apiGet('/workspaces'),
      apiGet(`/workspaces/${workspaceId}/messages?limit=20`),
      apiGet(`/workspaces/${workspaceId}/tasks`),
    ]);

    const ws = workspacesRes.workspaces?.find(w => w.id === workspaceId);
    const rules = ws?.rules || [];
    const messages = messagesRes.messages || [];
    const tasks = (tasksRes.tasks || []).filter(t => t.status !== 'done');

    // 2. Build prompts
    const systemPrompt = buildSystemPrompt(people, rules);
    const newMessage = { id: messageId, user: messageUser, body: messageBody };
    const userPrompt = buildUserPrompt(messages, tasks, people, newMessage);

    // 3. Call Groq API
    const groqStart = Date.now();
    const groqRes = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
      }),
    });

    if (!groqRes.ok) {
      const errorText = await groqRes.text();
      let errorJson;
      try { errorJson = JSON.parse(errorText); } catch { errorJson = { raw: errorText }; }
      throw new Error(`Groq API ${groqRes.status}: ${JSON.stringify(errorJson).slice(0, 500)}`);
    }

    const groqData = await groqRes.json();
    const groqLatency = Date.now() - groqStart;
    const content = groqData.choices?.[0]?.message?.content || '';

    // 4. Parse JSON response
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error(`Invalid JSON from Groq: ${e.message}. Content: ${content.slice(0, 200)}`);
    }

    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    const analysis = parsed.analysis || '';

    // 5. Execute each action via the ShiftBridge API
    const executionResults = [];
    for (const action of actions) {
      if (action.type === 'no_action') continue;
      const execResult = await executeAction(workspaceId, action, messageId);
      executionResults.push(execResult);
    }

    const totalLatency = Date.now() - startTime;

    // 6. Log to ai_analysis_log
    const logId = `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const ts = Date.now();
    const proposalsCreated = executionResults.filter(r => r.type === 'propose_task' && r.ok).length;
    const completionClaims = executionResults.filter(r => r.type === 'propose_completion' && r.ok).length;
    const errors = executionResults.filter(r => !r.ok).map(r => `${r.type}: ${r.error || r.result?.error || 'unknown'}`).join('; ');

    d.prepare(
      `INSERT INTO ai_analysis_log (id, workspace_id, run_at, messages_total, messages_new, proposals_created, completion_claims, errors, last_message_seq, status, summary, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'success', ?, ?)`,
    ).run(
      logId, workspaceId, ts, messages.length, proposalsCreated, completionClaims,
      errors, messages.length > 0 ? messages[messages.length - 1].seq : 0,
      `Groq AI: ${analysis.slice(0, 200)} | Actions: ${actions.length}, Executed: ${executionResults.length}, Latency: ${totalLatency}ms`,
      ts,
    );

    bumpRevision();

    // 7. Update job to completed
    updateJob(jobId, {
      status: 'completed',
      last_error: '',
      actions_json: JSON.stringify(executionResults),
      latency_ms: totalLatency,
      model_used: groqData.model || GROQ_MODEL,
      tokens_used: groqData.usage?.total_tokens || 0,
      completed_at: ts,
    });

    return {
      ok: true,
      jobId,
      actions: executionResults,
      analysis,
      latency: totalLatency,
      groqLatency,
      tokens: groqData.usage?.total_tokens || 0,
    };

  } catch (err) {
    const totalLatency = Date.now() - startTime;
    const ts = Date.now();

    // Update job to failed (will be retried)
    const job = d.prepare('SELECT attempts FROM ai_jobs WHERE id = ?').get(jobId);
    const attempts = (job?.attempts || 0) + 1;
    const willRetry = attempts < 3;
    updateJob(jobId, {
      status: willRetry ? 'pending' : 'failed',
      attempts,
      last_error: err.message.slice(0, 1000),
      latency_ms: totalLatency,
    });

    // Log the error
    d.prepare(
      `INSERT INTO ai_analysis_log (id, workspace_id, run_at, messages_total, messages_new, proposals_created, completion_claims, errors, last_message_seq, status, summary, created_at)
       VALUES (?, ?, ?, 0, 1, 0, 0, ?, 0, 'error', ?, ?)`,
    ).run(
      `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId, ts, err.message.slice(0, 500),
      `Groq AI error: ${err.message.slice(0, 200)}`,
      ts,
    );

    bumpRevision();

    return {
      ok: false,
      jobId,
      error: err.message,
      latency: totalLatency,
      willRetry,
    };
  } finally {
    inFlight.delete(messageId);
  }
}

// ─── Recovery: process pending/failed jobs ────────────────────────
export async function processPendingJobs() {
  if (!GROQ_ENABLED || !GROQ_API_KEY) return { processed: 0, reason: 'Groq disabled or no API key' };

  const d = getDB();
  const pendingJobs = d.prepare(
    `SELECT * FROM ai_jobs WHERE status IN ('pending', 'failed') AND attempts < max_attempts ORDER BY created_at ASC LIMIT 10`,
  ).all();

  if (pendingJobs.length === 0) {
    return { processed: 0, reason: 'No pending jobs' };
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const job of pendingJobs) {
    // Get the message details
    const msg = d.prepare('SELECT * FROM messages WHERE id = ?').get(job.message_id);
    if (!msg) {
      updateJob(job.id, { status: 'failed', last_error: 'Source message not found', attempts: job.attempts + 1 });
      failed++;
      continue;
    }

    const result = await processMessage(job.workspace_id, job.message_id, msg.user_id, msg.body);
    processed++;

    if (result.ok) succeeded++;
    else failed++;
  }

  return { processed, succeeded, failed };
}

// ─── Get AI status for monitoring ────────────────────────────────
export function getGroqStatus(workspaceId) {
  const d = getDB();

  const pendingCount = d.prepare(
    `SELECT COUNT(*) as count FROM ai_jobs WHERE workspace_id = ? AND status = 'pending'`,
  ).get(workspaceId)?.count || 0;

  const failedCount = d.prepare(
    `SELECT COUNT(*) as count FROM ai_jobs WHERE workspace_id = ? AND status = 'failed'`,
  ).get(workspaceId)?.count || 0;

  const completedCount = d.prepare(
    `SELECT COUNT(*) as count FROM ai_jobs WHERE workspace_id = ? AND status = 'completed'`,
  ).get(workspaceId)?.count || 0;

  const recentJobs = d.prepare(
    `SELECT * FROM ai_jobs WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 5`,
  ).all(workspaceId).map(j => ({
    id: j.id,
    messageId: j.message_id,
    status: j.status,
    attempts: j.attempts,
    latencyMs: j.latency_ms,
    model: j.model_used,
    tokens: j.tokens_used,
    error: j.last_error?.slice(0, 100),
    completedAt: j.completed_at,
  }));

  return {
    enabled: GROQ_ENABLED && !!GROQ_API_KEY,
    model: GROQ_MODEL,
    pending: pendingCount,
    failed: failedCount,
    completed: completedCount,
    recentJobs,
  };
}
