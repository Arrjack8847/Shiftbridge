/**
 * server/index.js — ShiftBridge backend server.
 *
 * Serves:
 *   • Static frontend files (index.html, styles.css, src/*, assets/*)
 *   • REST API endpoints under /api/*
 *   • Server-Sent Events for real-time sync under /api/events
 *
 * Listens on 0.0.0.0:3000 so other phones on the same Wi-Fi can connect
 * using the laptop's IPv4 address.
 */

import express from 'express';
import cors from 'cors';
import { classifyIncomingMessage } from './message-intent.js';
import { normalizeEntityKey, findMatchingOpenIssue, linkMessageToIssue, issueMessages, workspaceIncidentContext } from './incident-memory.js';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  getDB,
  initSchema,
  closeDB,
  bumpRevision,
  currentRevision,
  mapMessage,
  mapTask,
  mapIssue,
  mapRule,
  mapAudit,
  mapProposal,
  mapCompletionClaim,
  mapAIAnalysisLog,
  mapAnnouncement,
  mapAnnouncementRevision,
} from './db.js';
import { seedDatabase } from './seed.js';
import { ruleDefaults } from './rule-defaults.js';
// ── AI Provider Selection ───────────────────────────────────────────
// AI_PROVIDER controls which AI backend is used:
//   "tencent-local" (default) → Tencent AI via CodeBuddy serve + MCP tools
//   "groq"                    → Legacy Groq API (code preserved in git)
//
// Groq code is kept in groq-agent.js and git history. When tencent-local
// is active, groq-agent.js is imported only for backward-compatible status.
import {
  processMessage as tencentProcessMessage,
  processPendingJobs as tencentProcessPending,
  getTencentStatus,
} from './tencent-agent.js';

// Legacy Groq agent — only loaded for backward-compatible status endpoint
// and the AI_PROVIDER=groq fallback path. Active code is tencent-agent.js.
import {
  processMessage as groqProcessMessage,
  processPendingJobs as groqProcessPending,
  getGroqStatus,
} from './groq-agent.js';

// Provider-agnostic dispatch (Phase D — prevent dual AI systems)
const AI_PROVIDER = process.env.AI_PROVIDER || 'tencent-local';
function dispatchProcessMessage(workspaceId, messageId, user, body) {
  if (AI_PROVIDER === 'groq') {
    // Legacy path — only used when AI_PROVIDER=groq is explicitly set
    return groqProcessMessage(workspaceId, messageId, user, body);
  }
  return tencentProcessMessage(workspaceId, messageId, user, body);
}
async function dispatchProcessPending() {
  if (AI_PROVIDER === 'groq') {
    return groqProcessPending();
  }
  return tencentProcessPending();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..'); // project root (parent of server/)
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

// ── Boot ──────────────────────────────────────────────────────────
initSchema();
seedDatabase();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── Static frontend ─────────────────────────────────────────────────
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// NOTE: API routes are registered below, BEFORE the static middleware and
// SPA fallback. This ensures /api/* paths are always handled by the API
// and never intercepted by static file serving or the SPA catch-all.

// ── SSE: real-time event stream ──────────────────────────────────────
const sseClients = new Map(); // workspaceId -> Set<res>

function addSSEClient(workspaceId, res) {
  if (!sseClients.has(workspaceId)) sseClients.set(workspaceId, new Set());
  sseClients.get(workspaceId).add(res);
}
function removeSSEClient(workspaceId, res) {
  const set = sseClients.get(workspaceId);
  if (set) {
    set.delete(res);
    if (set.size === 0) sseClients.delete(workspaceId);
  }
}
function notifySSE(workspaceId, payload) {
  const set = sseClients.get(workspaceId);
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
  }
}

app.get('/api/events', (req, res) => {
  const workspaceId = req.query.workspace;
  if (!workspaceId) return res.status(400).json({ error: 'workspace required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  res.write(`: connected to workspace ${workspaceId}\n\n`);

  addSSEClient(workspaceId, res);

  req.on('close', () => removeSSEClient(workspaceId, res));
});

// ── Demo people (static, no auth) ──────────────────────────────────
const DEMO_PEOPLE = [
  { id: 'jack', name: 'Jack', initials: 'J', hue: 'sea', role: 'Barista' },
  { id: 'emma', name: 'Emma', initials: 'E', hue: 'lavender', role: 'Barista' },
  { id: 'sarah', name: 'Sarah', initials: 'S', hue: 'rose', role: 'Shift lead' },
  { id: 'manager', name: 'Manager', initials: 'M', hue: 'orange', role: 'Administrator' },
  { id: 'liam', name: 'Liam', initials: 'L', hue: 'blue', role: 'Barista' },
];

app.get('/api/people', (_req, res) => {
  res.json(DEMO_PEOPLE);
});

// ── Protected task enforcement ─────────────────────────────────────
// These categories mirror the locked rules (repairs, purchases, safety).
// Tasks in these categories — or any task with verification='qualified' —
// cannot be marked 'done' directly. They must go through 'review' status,
// where the AI agent or a qualified human inspects the completion claim.
const PROTECTED_CATEGORIES = ['repairs', 'purchases', 'safety'];

/** Returns true if the task requires qualified verification before 'done'. */
function isProtectedTask(task) {
  return task.verification === 'qualified' || PROTECTED_CATEGORIES.includes(task.category);
}

// ── Helper: validate workspace exists ───────────────────────────────
function validateWorkspace(req, res, next) {
  const ws = req.params.workspace || req.body.workspace_id;
  if (!ws) return res.status(400).json({ error: 'workspace_id required' });
  const d = getDB();
  const row = d.prepare('SELECT id FROM workspaces WHERE id = ?').get(ws);
  if (!row) return res.status(404).json({ error: 'workspace not found' });
  req.workspaceId = ws;
  next();
}

// ── Workspaces ──────────────────────────────────────────────────────

/** GET /api/workspaces — list all workspaces with members + rules. */
app.get('/api/workspaces', (_req, res) => {
  const d = getDB();
  const workspaces = d.prepare('SELECT * FROM workspaces ORDER BY created_at').all();
  const result = workspaces.map((w) => {
    const members = d.prepare('SELECT person_id FROM workspace_members WHERE workspace_id = ?').all(w.id).map((m) => m.person_id);
    const rules = d.prepare('SELECT * FROM rules WHERE workspace_id = ?').all(w.id).map(mapRule);
    return {
      id: w.id,
      name: w.name,
      type: w.type,
      zone: w.zone,
      invite: w.invite,
      members,
      rules,
      createdAt: w.created_at,
    };
  });
  res.json({ workspaces: result, revision: currentRevision() });
});

/** POST /api/workspaces — create a new workspace. */
app.post('/api/workspaces', (req, res) => {
  const { name, type = 'Other business', zone = 'Asia/Kuala_Lumpur', creatorId = 'manager' } = req.body;
  const trimmed = String(name || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'name is required' });

  const id = `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const invite = Array.from(bytes, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 9).toUpperCase();
  const ts = Date.now();

  const d = getDB();
  const tx = d.transaction(() => {
    d.prepare('INSERT INTO workspaces (id, name, type, zone, invite, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, trimmed.slice(0, 65), String(type).slice(0, 50), zone, invite, ts);
    d.prepare('INSERT INTO workspace_members (workspace_id, person_id, role) VALUES (?, ?, ?)').run(id, creatorId, 'admin');
    for (const r of ruleDefaults) {
      d.prepare('INSERT OR IGNORE INTO rules (id, workspace_id, name, note, allowed, locked) VALUES (?, ?, ?, ?, ?, ?)').run(`${r.id}_${id}`, id, r.name, r.note, r.allowed ? 1 : 0, r.locked ? 1 : 0);
    }
    d.prepare('INSERT OR IGNORE INTO shifts (workspace_id, person_id, clocked_in, since) VALUES (?, ?, ?, ?)').run(id, creatorId, 0, null);
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, id, 'workspace_created', 'workspace', id, creatorId, `Created workspace "${trimmed}"`, ts,
    );
    bumpRevision();
  });
  tx();

  notifySSE(id, { type: 'workspace_created', workspaceId: id });
  res.status(201).json({ id, name: trimmed, type, zone, invite, createdAt: ts });
});

/** PUT /api/workspaces/:id — update workspace settings (admin only). */
app.put('/api/workspaces/:id', (req, res) => {
  const { id } = req.params;
  const { name, type } = req.body;
  const d = getDB();
  const ws = d.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });

  const updates = {};
  if (name !== undefined) updates.name = String(name).trim().slice(0, 65);
  if (type !== undefined) updates.type = String(type).slice(0, 50);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no fields to update' });

  const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  d.prepare(`UPDATE workspaces SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), id);
  bumpRevision();
  notifySSE(id, { type: 'workspace_updated', workspaceId: id });
  res.json({ id, ...updates });
});

// ── Messages ────────────────────────────────────────────────────────

/** GET /api/workspaces/:workspace/messages — list messages.
 *
 * Supports two filter modes:
 *   ?since=<timestamp>  — messages with created_at > timestamp (for live sync/polling)
 *   ?sinceSeq=<n>        — messages with seq > n, ordered by seq ASC (for checkpoint-based pagination)
 *
 * Both filters can be combined. Pagination via ?limit=<n> (default 100, max 500).
 * Response includes hasMore=true when more messages exist beyond the returned batch,
 * and nextSinceSeq for the caller to use as the next cursor.
 */
app.get('/api/workspaces/:workspace/messages', validateWorkspace, (req, res) => {
  const d = getDB();
  const since = req.query.since ? parseInt(req.query.since, 10) : 0;
  const sinceSeq = req.query.sinceSeq ? parseInt(req.query.sinceSeq, 10) : 0;
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));

  // latest=1 returns the newest batch in chronological order.
  // Existing since/sinceSeq pagination remains backward compatible.
  const latest = req.query.latest === '1' && !since && !sinceSeq;
  const rows = latest
    ? d.prepare('SELECT * FROM messages WHERE workspace_id = ? ORDER BY seq DESC LIMIT ?').all(req.workspaceId, limit + 1)
    : d.prepare('SELECT * FROM messages WHERE workspace_id = ? AND created_at > ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(req.workspaceId, since, sinceSeq, limit + 1);
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  if (latest) selected.reverse();
  const messages = selected.map(mapMessage);
  // sinceSeq pages forward; it cannot page backwards into a "latest" slice.
  const nextSinceSeq = !latest && hasMore && messages.length > 0
    ? messages[messages.length - 1].seq
    : null;

  res.json({
    messages,
    hasMore,
    nextSinceSeq,
    revision: currentRevision(),
  });
});


// ── Zero-model latency path: report explicit operational warnings ──
// A report is an unverified employee claim, NOT confirmation of damage/safety.
function recordAutoWarning(workspaceId, messageId, senderId, body, intent) {
  const d = getDB();
  const member = d.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND person_id = ?')
    .get(workspaceId, senderId);
  if (!member) return null; // Never attribute a detected report to a non-member.

  const existing = d.prepare('SELECT id FROM issues WHERE workspace_id = ? AND source = ?')
    .get(workspaceId, messageId);
  if (existing) return existing.id;

  const entityKey = normalizeEntityKey(body);
  const matched = findMatchingOpenIssue(d, workspaceId, entityKey);
  if (matched) {
    const linked = linkMessageToIssue(d, {
      workspaceId, issueId: matched.id, messageId,
      relation: 'report', actor: 'fast-warning', reason: 'Exact equipment identifier matched',
    });
    if (!linked.ok) throw new Error(linked.error);
    if (intent.issueType === 'safety') {
      d.prepare("UPDATE issues SET severity='high',requires_approval=1,issue_type='safety' WHERE id=? AND workspace_id=?")
        .run(matched.id, workspaceId);
    }
    bumpRevision();
    notifySSE(workspaceId, {type:'issue',action:'linked',id:matched.id,messageId});
    return matched.id;
  }

  const issueId = `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const title = `Possible ${intent.issueType} issue: ${body.replace(/\s+/g, ' ').slice(0, 130)}`;
  const ts = Date.now();
  const result = d.prepare(
    `INSERT OR IGNORE INTO issues
      (id, workspace_id, title, description, severity, status, source, created_by,
       reporter_id, requires_approval, approved, evidence, issue_type, created_at, entity_key, last_activity_at)
     VALUES (?, ?, ?, ?, ?, 'reported', ?, 'auto-warning-detector', ?, ?, 0, ?, ?, ?, ?, ?)`
  ).run(issueId, workspaceId, title.slice(0, 200), body, intent.severity,
    messageId, senderId, intent.issueType === 'safety' ? 1 : 0,
    'Unverified report from chat message; human inspection/confirmation required.',
    intent.issueType, ts, entityKey, ts);

  if (!result.changes) return d.prepare('SELECT id FROM issues WHERE workspace_id = ? AND source = ?')
    .get(workspaceId, messageId)?.id || null;
  const originalLink = linkMessageToIssue(d, {
    workspaceId, issueId, messageId, relation: 'report', actor: 'fast-warning',
    reason: 'Original source for unverified warning',
  });
  if (!originalLink.ok) throw new Error(originalLink.error);

  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      workspaceId, 'issue_auto_reported', 'issue', issueId, 'warning-detector',
      `Unverified warning from message ${messageId}, sent by ${senderId}; requires human review`, ts);
  bumpRevision();
  notifySSE(workspaceId, { type: 'issue', action: 'reported', id: issueId, messageId });
  return issueId;
}

/** Retrieve one source message for verified MCP issue reporting. */
app.get('/api/workspaces/:workspace/messages/:messageId', validateWorkspace, (req, res) => {
  const row = getDB().prepare('SELECT * FROM messages WHERE workspace_id = ? AND id = ?')
    .get(req.workspaceId, req.params.messageId);
  if (!row) return res.status(404).json({ error: 'Message not found in workspace' });
  res.json(mapMessage(row));
});

/** POST /api/workspaces/:workspace/messages — create a message (idempotent by client ID). */
app.post('/api/workspaces/:workspace/messages', validateWorkspace, (req, res) => {
  const { id, user, body } = req.body;
  if (!user) return res.status(400).json({ error: 'user is required' });
  const text = String(body || '').trim();
  if (!text) return res.status(400).json({ error: 'body is required' });

  const msgId = id || `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = Date.now();
  const d = getDB();

  // Idempotency: INSERT OR IGNORE — if the client already sent this ID, return the existing row.
  const maxSeqRow = d.prepare('SELECT MAX(seq) as maxSeq FROM messages WHERE workspace_id = ?').get(req.workspaceId);
  const seq = (maxSeqRow?.maxSeq || 0) + 1;

  const info = d.prepare(
    'INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(msgId, req.workspaceId, user, text.slice(0, 1500), ts, seq);

  if (info.changes > 0) {
    bumpRevision();
    notifySSE(req.workspaceId, { type: 'message', id: msgId, user, body: text.slice(0, 1500), at: ts });

    // Route obvious fault reports in milliseconds; avoid launching the full
    // CodeBuddy CLI for simple warnings and low-value acknowledgments.
    // Other language (including questions/ambiguous problems) goes to AI.
    const intent = AI_PROVIDER === 'tencent-local'
      ? classifyIncomingMessage(text.slice(0, 1500))
      : { route: 'ai' };
    if (intent.route === 'issue') {
      try {
        const issueId = recordAutoWarning(req.workspaceId, msgId, user, text.slice(0, 1500), intent);
        if (issueId) console.log(`[fast-warning] Reported unverified issue ${issueId} from ${msgId}`);
      } catch (err) {
        // Never lose the chat message due to warning classification failures.
        console.error('[fast-warning] Failed to record warning:', err.message);
      }
    }

    // The chat response is immediate; complex tasks and ambiguous messages
    // still receive Tencent semantic analysis in a non-blocking callback.
    // Very simple low-risk manager assignments can use the *existing*
    // validated manager-task endpoint directly, without CodeBuddy startup.
    // Server-side checks still enforce manager identity, member assignments,
    // category permissions, and source-message idempotency.
    if (intent.route === 'routine-task' && user === getWorkspaceManager(d, req.workspaceId)) {
      setImmediate(() => {
        fetch(`http://127.0.0.1:${PORT}/api/workspaces/${encodeURIComponent(req.workspaceId)}/manager-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceMessageId: msgId,
            ...intent.task,
            description: `Explicit manager assignment in message ${msgId}`,
            createdBy: 'fast-routine',
          }),
        }).then(async response => {
          if (!response.ok) throw new Error(`Direct task rejected (${response.status}): ${(await response.text()).slice(0, 200)}`);
          const task = await response.json();
          console.log(`[fast-task] Routine manager task ${task.id} created from ${msgId}`);
        }).catch(err => {
          console.error('[fast-task] Falling back to Tencent AI:', err.message);
          dispatchProcessMessage(req.workspaceId, msgId, user, text.slice(0, 1500))
            .catch(aiError => console.error('[fast-task] Tencent fallback failed:', aiError.message));
        });
      });
    } else if (intent.route === 'ai' || intent.route === 'routine-task' ||
               (intent.route === 'issue' && intent.needsAi)) setImmediate(() => {
      dispatchProcessMessage(req.workspaceId, msgId, user, text.slice(0, 1500))
        .then(result => {
          if (result.ok) {
            console.log(`[${AI_PROVIDER}] Processed message ${msgId}: ${result.actions?.length || 0} actions, ${result.latency}ms`);
            notifySSE(req.workspaceId, {
              type: 'ai_processed',
              messageId: msgId,
              actions: result.actions?.length || 0,
              analysis: result.analysis?.slice(0, 200) || '',
              latency: result.latency,
            });
          } else if (!result.skipped) {
            console.error(`[${AI_PROVIDER}] Failed for ${msgId}: ${result.error} (willRetry: ${result.willRetry})`);
          }
        })
        .catch(err => console.error(`[${AI_PROVIDER}] Unexpected error:`, err.message));
    });
  }

  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  res.status(201).json(mapMessage(row));
});

// ── Tasks ───────────────────────────────────────────────────────────

/** GET /api/workspaces/:workspace/tasks — list all tasks in a workspace. */
app.get('/api/workspaces/:workspace/tasks', validateWorkspace, (req, res) => {
  const d = getDB();
  const rows = d.prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json({ tasks: rows.map(mapTask), revision: currentRevision() });
});

/** GET /api/tasks/:id — get a single task. */
app.get('/api/tasks/:id', (req, res) => {
  const d = getDB();
  const row = d.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'task not found' });
  res.json(mapTask(row));
});

/** POST /api/workspaces/:workspace/tasks — create a task (idempotent by client ID). */
app.post('/api/workspaces/:workspace/tasks', validateWorkspace, (req, res) => {
  const {
    id, name, description = '', assignee = null, priority = 'normal',
    category = 'routine', due = 'Today', source = null, createdBy = 'manual',
    verification = 'self-report',
  } = req.body;

  const trimmedName = String(name || '').trim();
  if (!trimmedName) return res.status(400).json({ error: 'name is required' });

  // Enforce qualified verification for protected categories.
  let finalVerification = verification;
  if (PROTECTED_CATEGORIES.includes(category) && verification !== 'qualified') {
    finalVerification = 'qualified';
  }

  const taskId = id || `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = Date.now();
  const d = getDB();

  const info = d.prepare(
    `INSERT OR IGNORE INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, '', ?, ?)`,
  ).run(
    taskId, req.workspaceId, trimmedName.slice(0, 100),
    String(description).slice(0, 1000), assignee, priority, category,
    String(due).slice(0, 50), source, createdBy, finalVerification, ts, ts,
  );

  if (info.changes > 0) {
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, req.workspaceId, 'task_created', 'task', taskId, createdBy, `Created task "${trimmedName}"`, ts,
    );
    bumpRevision();
    notifySSE(req.workspaceId, { type: 'task', action: 'created', id: taskId });
  }

  const row = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  res.status(201).json(mapTask(row));
});

/** PUT /api/tasks/:id — update a task (status, completion, assignee, etc.). */
app.put('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const d = getDB();
  const row = d.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'task not found' });

  const allowed = ['status', 'completion', 'assignee', 'priority', 'name', 'description', 'due'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no updatable fields' });

  const ts = Date.now();
  const actor = req.body.actor || 'unknown';

  // ── Server-side enforcement: protected tasks cannot be marked 'done' directly.
  // If a task is protected (qualified verification or locked category) and someone
  // tries to set status='done', we redirect to 'review' instead. The completion
  // claim is preserved in the completion field and an audit entry is logged.
  // The AI agent (via MCP) will review the claim and either approve (→done) or
  // reject (→doing) the task.
  let enforced = false;
  if (updates.status === 'done' && isProtectedTask(row)) {
    updates.status = 'review';
    enforced = true;
  }

  // Also enforce: if a non-protected task is being created with category changes
  // that make it protected, upgrade verification automatically.
  if (updates.category && PROTECTED_CATEGORIES.includes(updates.category) && row.verification !== 'qualified') {
    updates.verification = 'qualified';
  }

  const setClauses = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  updates.id = id;
  updates._updated = ts;

  // Use named parameters for safety.
  const stmt = d.prepare(`UPDATE tasks SET ${setClauses}, updated_at = ${ts} WHERE id = @id`);
  const params = { ...updates };
  delete params.id;
  delete params._updated;
  params.id = id;
  stmt.run(params);

  // Record the enforcement action in audit log.
  if (enforced) {
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id, 'enforced_review', 'task', id, 'system', `Protected task: status redirected to 'review' instead of 'done'`, ts,
    );
  }

  // Record status changes in audit log.
  if (updates.status && updates.status !== row.status) {
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id, 'task_status_changed', 'task', id, actor, `${row.status} → ${updates.status}`, ts,
    );
  }
  if (updates.completion !== undefined && updates.completion !== row.completion) {
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id, 'completion_claim', 'task', id, actor, updates.completion, ts,
    );
  }

  bumpRevision();
  notifySSE(row.workspace_id, { type: 'task', action: 'updated', id, updates });

  const updated = d.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.json(mapTask(updated));
});

// ── Agent V2: inspect and link ongoing incident conversations ──
app.get('/api/workspaces/:workspace/incident-context', validateWorkspace, (req, res) => {
  const d = getDB();
  res.json({ incidents: workspaceIncidentContext(d, req.workspaceId, 10), revision: currentRevision() });
});

app.post('/api/workspaces/:workspace/incidents/:issueId/link-message', validateWorkspace, (req, res) => {
  const messageId = String(req.body.messageId || '').trim();
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  const relation = String(req.body.relation || 'update');
  if (!messageId || reason.length < 12) {
    return res.status(400).json({ error: 'A real messageId and contextual reason (12+ characters) are required' });
  }
  const result = linkMessageToIssue(getDB(), {
    workspaceId: req.workspaceId, issueId: req.params.issueId, messageId,
    relation, reason, actor: 'silent-ai',
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  if (!result.duplicate) {
    bumpRevision();
    notifySSE(req.workspaceId, {type:'issue',action:'linked',id:req.params.issueId,messageId});
  }
  res.status(result.duplicate ? 200 : 201).json(result);
});

// This is review data for regression tests and prompt iteration, not
// automatic model training or authority to resolve a protected incident.
const AI_FEEDBACK_VERDICTS = new Set(['correct_issue','false_alarm','wrong_link','correct_link','missed_context']);
app.post('/api/workspaces/:workspace/agent-feedback', validateWorkspace, (req, res) => {
  const d = getDB();
  const reviewerId = String(req.body.reviewerId || '');
  const verdict = String(req.body.verdict || '');
  const issueId = String(req.body.issueId || '');
  const messageId = String(req.body.messageId || '');
  const note = String(req.body.note || '').trim().slice(0, 600);
  if (reviewerId !== getWorkspaceManager(d, req.workspaceId)) {
    return res.status(403).json({ error: 'Only the workspace demo manager can review AI detections' });
  }
  if (!AI_FEEDBACK_VERDICTS.has(verdict) || !issueId || !messageId) {
    return res.status(400).json({ error: 'Valid verdict, issueId and messageId required' });
  }
  const linked = d.prepare('SELECT 1 FROM issue_message_links WHERE workspace_id=? AND issue_id=? AND message_id=?')
    .get(req.workspaceId, issueId, messageId);
  if (!linked) return res.status(404).json({ error: 'Feedback must reference a real linked incident message' });
  const ts = Date.now();
  const id = 'fb_' + ts.toString(36) + '_' + Math.random().toString(36).slice(2,8);
  d.prepare('INSERT INTO ai_feedback (id,workspace_id,issue_id,message_id,verdict,note,reviewer_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id,req.workspaceId,issueId,messageId,verdict,note,reviewerId,ts);
  d.prepare('INSERT INTO audit_log (id,workspace_id,action,entity_type,entity_id,actor,details,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('al_'+ts.toString(36)+'_'+Math.random().toString(36).slice(2,8),
      req.workspaceId,'ai_feedback_recorded','issue',issueId,reviewerId,verdict+' for message '+messageId,ts);
  bumpRevision();
  notifySSE(req.workspaceId,{type:'feedback',id,issueId});
  res.status(201).json({id,workspaceId:req.workspaceId,issueId,messageId,verdict,note,reviewerId,createdAt:ts});
});

app.get('/api/workspaces/:workspace/agent-feedback', validateWorkspace, (req, res) => {
  const d = getDB();
  if (String(req.query.reviewerId || '') !== getWorkspaceManager(d,req.workspaceId)) {
    return res.status(403).json({error:'Only workspace demo manager can view feedback'});
  }
  const rows = d.prepare('SELECT id,workspace_id AS workspaceId,issue_id AS issueId,message_id AS messageId,verdict,note,reviewer_id AS reviewerId,created_at AS createdAt FROM ai_feedback WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200')
    .all(req.workspaceId);
  res.json({feedback:rows,revision:currentRevision()});
});

// ── Issues ──────────────────────────────────────────────────────────

/** GET /api/workspaces/:workspace/issues — list issues. */
app.get('/api/workspaces/:workspace/issues', validateWorkspace, (req, res) => {
  const d = getDB();
  const rows = d.prepare('SELECT * FROM issues WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json({ issues: rows.map(row => ({...mapIssue(row), linkedMessages: issueMessages(d, req.workspaceId, row.id, 12)})), revision: currentRevision() });
});

/** GET /api/issues/:id — get a single issue. */
app.get('/api/issues/:id', (req, res) => {
  const d = getDB();
  const row = d.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'issue not found' });
  res.json({...mapIssue(row), linkedMessages: issueMessages(d, row.workspace_id, row.id, 30)});
});

/** PUT /api/issues/:id — update an issue (status, evidence, approved). */
app.put('/api/issues/:id', (req, res) => {
  const { id } = req.params;
  const d = getDB();
  const row = d.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'issue not found' });

  const allowed = ['status', 'evidence', 'approved', 'severity', 'title', 'description'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === 'approved') updates[key] = req.body[key] ? 1 : 0;
      else updates[key] = req.body[key];
    }
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no updatable fields' });

  const ts = Date.now();
  if (updates.status === 'resolved') {
    return res.status(403).json({error:'Issue resolution requires qualified-verifier route'});
  }

  const setClauses = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  updates.id = id;
  d.prepare(`UPDATE issues SET ${setClauses} WHERE id = @id`).run(updates);

  const actor = req.body.actor || 'unknown';
  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id, 'issue_updated', 'issue', id, actor, JSON.stringify(updates), ts,
  );

  bumpRevision();
  notifySSE(row.workspace_id, { type: 'issue', action: 'updated', id, updates });

  const updated = d.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  res.json(mapIssue(updated));
});

// ── Rules ───────────────────────────────────────────────────────────

/** PUT /api/rules/:id — toggle a rule's allowed state. */
app.put('/api/rules/:id', (req, res) => {
  const d = getDB();
  const row = d.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'rule not found' });
  if (row.locked) return res.status(403).json({ error: 'locked rules cannot be changed' });

  const allowed = req.body.allowed ? 1 : 0;
  d.prepare('UPDATE rules SET allowed = ? WHERE id = ?').run(allowed, req.params.id);
  bumpRevision();
  notifySSE(row.workspace_id, { type: 'rule', action: 'updated', id: req.params.id, allowed });
  res.json(mapRule(d.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id)));
});

// ── Shifts ──────────────────────────────────────────────────────────

/** GET /api/workspaces/:workspace/shift — get current shift state. */
app.get('/api/workspaces/:workspace/shift', validateWorkspace, (req, res) => {
  const d = getDB();
  const row = d.prepare('SELECT * FROM shifts WHERE workspace_id = ?').get(req.workspaceId);
  if (!row) return res.json({ on: false, since: null });
  res.json({ on: row.clocked_in === 1, since: row.since, personId: row.person_id });
});

/** PUT /api/workspaces/:workspace/shift — toggle clock in/out. */
app.put('/api/workspaces/:workspace/shift', validateWorkspace, (req, res) => {
  const { personId = 'jack' } = req.body;
  const d = getDB();
  const row = d.prepare('SELECT * FROM shifts WHERE workspace_id = ?').get(req.workspaceId);
  const newState = row ? (row.clocked_in === 1 ? 0 : 1) : 1;
  const since = newState === 1 ? Date.now() : null;
  const person = personId;

  if (row) {
    d.prepare('UPDATE shifts SET clocked_in = ?, since = ?, person_id = ? WHERE workspace_id = ?').run(newState, since, person, req.workspaceId);
  } else {
    d.prepare('INSERT INTO shifts (workspace_id, person_id, clocked_in, since) VALUES (?, ?, ?, ?)').run(req.workspaceId, person, newState, since);
  }
  bumpRevision();
  notifySSE(req.workspaceId, { type: 'shift', on: newState === 1, since });
  res.json({ on: newState === 1, since, personId: person });
});

// ── Handovers ───────────────────────────────────────────────────────

/** GET /api/workspaces/:workspace/handover — get current handover. */
app.get('/api/workspaces/:workspace/handover', validateWorkspace, (req, res) => {
  const d = getDB();
  const row = d.prepare('SELECT * FROM handovers WHERE workspace_id = ?').get(req.workspaceId);
  if (!row) return res.json({});
  res.json({
    finished: row.finished, problems: row.problems, stock: row.stock,
    next: row.next, unfinished: row.unfinished, saved: row.saved,
  });
});

/** PUT /api/workspaces/:workspace/handover — save handover. */
app.put('/api/workspaces/:workspace/handover', validateWorkspace, (req, res) => {
  const { finished = '', problems = '', stock = '', next = '', unfinished = '' } = req.body;
  const ts = Date.now();
  const d = getDB();
  const existing = d.prepare('SELECT workspace_id FROM handovers WHERE workspace_id = ?').get(req.workspaceId);
  if (existing) {
    d.prepare('UPDATE handovers SET finished = ?, problems = ?, stock = ?, next = ?, unfinished = ?, saved = ? WHERE workspace_id = ?').run(
      finished, problems, stock, next, unfinished, ts, req.workspaceId,
    );
  } else {
    d.prepare('INSERT INTO handovers (workspace_id, finished, problems, stock, next, unfinished, saved) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      req.workspaceId, finished, problems, stock, next, unfinished, ts,
    );
  }
  bumpRevision();
  notifySSE(req.workspaceId, { type: 'handover', saved: ts });
  res.json({ finished, problems, stock, next, unfinished, saved: ts });
});

// ── Audit Log (Administrator review records) ────────────────────────

/** GET /api/workspaces/:workspace/audit — list audit log entries. */
app.get('/api/workspaces/:workspace/audit', validateWorkspace, (req, res) => {
  const d = getDB();
  const since = req.query.since ? parseInt(req.query.since, 10) : 0;
  const rows = d.prepare('SELECT * FROM audit_log WHERE workspace_id = ? AND created_at > ? ORDER BY created_at ASC').all(req.workspaceId, since);
  res.json({ audit: rows.map(mapAudit), revision: currentRevision() });
});

// ── AI Proposals (Silent AI agent proposals for manager review) ─────

/** GET /api/workspaces/:workspace/proposals — list proposals, optionally filtered by status. */
app.get('/api/workspaces/:workspace/proposals', validateWorkspace, (req, res) => {
  const d = getDB();
  const status = req.query.status;
  let rows;
  if (status) {
    rows = d.prepare('SELECT * FROM ai_proposals WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC').all(req.workspaceId, status);
  } else {
    rows = d.prepare('SELECT * FROM ai_proposals WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  }
  res.json({ proposals: rows.map(mapProposal), revision: currentRevision() });
});

/** GET /api/proposals/:id — get a single proposal. */
app.get('/api/proposals/:id', (req, res) => {
  const d = getDB();
  const row = d.prepare('SELECT * FROM ai_proposals WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'proposal not found' });
  res.json(mapProposal(row));
});

/** POST /api/workspaces/:workspace/proposals — create a new AI proposal.
 *
 * Deduplication (Phase 5.1): If sourceMessageId is provided, the endpoint
 * checks for an existing proposal with the same workspace, source message,
 * type, and summary. If found, the existing proposal is returned (with
 * duplicate: true) instead of creating a new one. This prevents the
 * scheduled AI from creating duplicate proposals across repeated runs.
 * Proposals without a sourceMessageId are always created fresh.
 */
app.post('/api/workspaces/:workspace/proposals', validateWorkspace, (req, res) => {
  const {
    type, entityType = null, entityId = null, summary, evidence = [],
    reasoning = '', confidence = 'medium', proposedData = null,
    sourceMessageId = null,
  } = req.body;

  const validTypes = ['task_proposal', 'completion_review', 'refusal', 'chat_completion_claim'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'invalid proposal type' });
  const trimmedSummary = String(summary || '').trim();
  if (!trimmedSummary) return res.status(400).json({ error: 'summary is required' });

  const ts = Date.now();
  const d = getDB();

  // ── Deduplication check ──────────────────────────────────────────
  // If a sourceMessageId is provided, look for an existing proposal
  // with the same workspace_id + source_message_id + type + summary.
  // This prevents duplicate proposals from repeated AI analysis runs.
  // The check covers ALL statuses (pending, approved, rejected) —
  // once a proposal exists for a source message, it is not recreated.
  if (sourceMessageId) {
    const existing = d.prepare(
      `SELECT * FROM ai_proposals
       WHERE workspace_id = ? AND source_message_id = ? AND type = ? AND summary = ?
       ORDER BY created_at DESC LIMIT 1`,
    ).get(req.workspaceId, sourceMessageId, type, trimmedSummary.slice(0, 500));

    if (existing) {
      // Return the existing proposal with a duplicate flag.
      // Do NOT create a new proposal, audit entry, or bump revision.
      return res.status(200).json({
        ...mapProposal(existing),
        duplicate: true,
        message: 'A proposal with the same source message, type, and summary already exists.',
      });
    }
  }

  const proposalId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  d.prepare(
    `INSERT INTO ai_proposals (id, workspace_id, type, entity_type, entity_id, summary, evidence, reasoning, confidence, status, proposed_data, source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    proposalId, req.workspaceId, type, entityType, entityId,
    trimmedSummary.slice(0, 500),
    JSON.stringify(evidence),
    String(reasoning).slice(0, 4000),
    confidence,
    proposedData ? JSON.stringify(proposedData) : '',
    sourceMessageId,
    ts,
  );

  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, req.workspaceId, 'ai_proposal_created', 'proposal', proposalId, 'silent-ai', `${type}: ${trimmedSummary}`, ts,
  );

  bumpRevision();
  notifySSE(req.workspaceId, { type: 'proposal', action: 'created', id: proposalId });

  const row = d.prepare('SELECT * FROM ai_proposals WHERE id = ?').get(proposalId);
  res.status(201).json(mapProposal(row));
});

/** PUT /api/proposals/:id/review — approve or reject a proposal. */
app.put('/api/proposals/:id/review', (req, res) => {
  const { id } = req.params;
  const { decision, reviewer = 'manager' } = req.body;

  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
  }

  const d = getDB();
  const row = d.prepare('SELECT * FROM ai_proposals WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'proposal not found' });
  if (row.status !== 'pending') return res.status(409).json({ error: 'proposal already reviewed' });

  const ts = Date.now();
  const newStatus = decision === 'approve' ? 'approved' : 'rejected';

  const tx = d.transaction(() => {
    // Update proposal status.
    d.prepare('UPDATE ai_proposals SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(newStatus, reviewer, ts, id);

    // Log the review in audit.
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id, 'ai_proposal_reviewed', 'proposal', id, reviewer, `${decision}d: ${row.summary}`, ts,
    );

    // Apply side effects based on proposal type and decision.
    if (decision === 'approve') {
      if (row.type === 'task_proposal' && row.proposed_data) {
        // Create the actual task from the proposed data.
        const pd = JSON.parse(row.proposed_data);
        const taskId = pd.id || `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const finalVerification = (['repairs', 'purchases', 'safety'].includes(pd.category) && pd.verification !== 'qualified') ? 'qualified' : (pd.verification || 'self-report');
        d.prepare(
          `INSERT OR IGNORE INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, 'silent-ai', ?, '', ?, ?)`,
        ).run(
          taskId, row.workspace_id,
          String(pd.name || '').slice(0, 100),
          String(pd.description || '').slice(0, 1000),
          pd.assignee || null,
          pd.priority || 'normal',
          pd.category || 'routine',
          String(pd.due || 'Today').slice(0, 50),
          pd.source || 'ai-proposal',
          finalVerification, ts, ts,
        );
        d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id, 'task_created', 'task', taskId, 'silent-ai', `Created from approved proposal: ${pd.name}`, ts,
        );
      } else if (row.type === 'completion_review' && row.entity_id) {
        // ── CRITICAL SAFETY: Protected tasks cannot be marked 'done' just
        // because a manager approved the AI completion review. A demo
        // manager role is NOT qualified verification. Protected tasks
        // (repairs, purchases, safety, or verification='qualified')
        // remain in 'review' until explicit qualified verification
        // evidence is provided in the review body (qualifiedVerification).
        const taskRow = d.prepare('SELECT * FROM tasks WHERE id = ?').get(row.entity_id);
        if (taskRow) {
          const protectedTask = isProtectedTask(taskRow);
          const verificationEvidence = String(req.body.qualifiedVerification || '').trim();
          const hasQualifiedEvidence = verificationEvidence.length > 0;

          if (protectedTask && !hasQualifiedEvidence) {
            // Approval acknowledges the AI review, but the task REMAINS
            // in 'review' — qualified verification evidence is still required.
            d.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, row.entity_id);
            d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
              `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id, 'completion_review_approved_unverified', 'task', row.entity_id, reviewer, `Approved by ${reviewer} but task remains in review — protected work requires qualified verification evidence`, ts,
            );
          } else {
            // Non-protected task OR protected task WITH qualified evidence → done.
            d.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('done', ts, row.entity_id);
            const auditDetails = protectedTask
              ? `review → done (qualified verification by ${reviewer}: "${verificationEvidence}")`
              : `review → done (AI review approved by ${reviewer})`;
            d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
              `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id, 'task_status_changed', 'task', row.entity_id, reviewer, auditDetails, ts,
            );
          }
        }
      } else if (row.type === 'chat_completion_claim' && row.entity_id) {
        // Chat-derived completion claim: when approved, acknowledge.
        // When rejected, reopen the task to 'todo' status.
        const taskRow = d.prepare('SELECT * FROM tasks WHERE id = ?').get(row.entity_id);
        if (taskRow) {
          d.prepare('UPDATE tasks SET status = ?, completion = ?, updated_at = ? WHERE id = ?').run(
            'todo', '', ts, row.entity_id,
          );
          d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
            `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id, 'task_status_changed', 'task', row.entity_id, reviewer, `done → todo (chat completion claim rejected by ${reviewer})`, ts,
          );
        }
      }
      // For 'refusal' type: approval means the manager acknowledges the refusal.
      // The task stays in its current status (e.g., 'review') — no automatic change.
    } else {
      // Rejection: for completion_review, send task back to 'doing'.
      if (row.type === 'completion_review' && row.entity_id) {
        const taskRow = d.prepare('SELECT * FROM tasks WHERE id = ?').get(row.entity_id);
        if (taskRow && taskRow.status === 'review') {
          d.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('doing', ts, row.entity_id);
          d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
            `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id, 'task_status_changed', 'task', row.entity_id, reviewer, `review → doing (AI review rejected)`, ts,
          );
        }
      }
    }

    bumpRevision();
  });
  tx();

  notifySSE(row.workspace_id, { type: 'proposal', action: 'reviewed', id, decision });

  const updated = d.prepare('SELECT * FROM ai_proposals WHERE id = ?').get(id);
  res.json(mapProposal(updated));
});

// ── Chat-Derived Completion Claims (Phase 4) ────────────────────────
//
// The Silent AI detects completion claims in employee chat messages and
// submits them through this endpoint. The server:
//   1. Validates the source message exists in the workspace.
//   2. Validates the task exists in the same workspace.
//   3. Checks the reporting employee matches the task assignee.
//   4. Prevents duplicate processing (unique task_id + message_id).
//   5. Applies the workspace verification policy:
//      - Routine (self-report permitted) → task marked 'done', claim recorded
//        as self-attestation (NOT independent proof).
//      - Protected (repairs/purchases/safety) → task moved to 'review',
//        requires qualified human verification before 'done'.
//   6. Records the claim in completion_claims table.
//   7. Creates an ai_proposal for manager visibility.
//   8. Logs to audit trail.
//   9. Never posts to the shared chat.

/** GET /api/workspaces/:workspace/completion-claims — list all claims in a workspace. */
app.get('/api/workspaces/:workspace/completion-claims', validateWorkspace, (req, res) => {
  const d = getDB();
  const rows = d.prepare('SELECT * FROM completion_claims WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json({ claims: rows.map(mapCompletionClaim), revision: currentRevision() });
});

/** GET /api/tasks/:id/completion-claims — list claims for a specific task. */
app.get('/api/tasks/:id/completion-claims', (req, res) => {
  const d = getDB();
  const rows = d.prepare('SELECT * FROM completion_claims WHERE task_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ claims: rows.map(mapCompletionClaim) });
});

/** POST /api/workspaces/:workspace/chat-completion — process a chat-derived completion claim. */
app.post('/api/workspaces/:workspace/chat-completion', validateWorkspace, (req, res) => {
  const { taskId, messageId, reportingEmployee, claimType = 'completion' } = req.body;

  // ── Validate required fields ────────────────────────────────────
  if (!taskId) return res.status(400).json({ error: 'taskId is required' });
  if (!messageId) return res.status(400).json({ error: 'messageId is required' });
  if (!reportingEmployee) return res.status(400).json({ error: 'reportingEmployee is required' });

  const d = getDB();
  const ws = req.workspaceId;

  // ── 1. Validate source message exists in this workspace ─────────
  const msgRow = d.prepare('SELECT * FROM messages WHERE id = ? AND workspace_id = ?').get(messageId, ws);
  if (!msgRow) {
    return res.status(404).json({
      error: 'Source message not found in this workspace',
      messageId,
      workspace: ws,
    });
  }

  // ── 2. Validate task exists in this workspace ───────────────────
  const taskRow = d.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, ws);
  if (!taskRow) {
    return res.status(404).json({
      error: 'Task not found in this workspace',
      taskId,
      workspace: ws,
    });
  }

  // Validate that the claimed reporter really authored the source chat message.
  // Otherwise one employee's message can be used to complete someone else's task.
  if (msgRow.user_id !== reportingEmployee) {
    return res.status(403).json({
      error: 'Reporting employee must match the source message sender',
      messageId,
      messageSender: msgRow.user_id,
      reportingEmployee,
    });
  }
  if (!['completion', 'progress', 'ambiguous'].includes(claimType)) {
    return res.status(400).json({ error: 'Invalid claimType' });
  }

  // ── 3. Check reporting employee matches task assignee ───────────
  if (taskRow.assignee !== reportingEmployee) {
    // Record the rejected claim attempt for audit purposes.
    const claimId = `cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const ts = Date.now();
    d.prepare(
      `INSERT OR IGNORE INTO completion_claims (id, workspace_id, task_id, message_id, reporting_employee, claim_text, claim_type, status, verification_applied, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'rejected', 'none', ?)`,
    ).run(claimId, ws, taskId, messageId, reportingEmployee, msgRow.body, claimType, ts);

    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'chat_completion_rejected', 'task', taskId, 'silent-ai',
      `Rejected: ${reportingEmployee} is not the assignee of task ${taskId} (assignee: ${taskRow.assignee || 'unassigned'})`, ts,
    );
    bumpRevision();

    return res.status(403).json({
      error: 'Wrong employee: the reporting employee does not match the task assignee',
      taskId,
      taskAssignee: taskRow.assignee,
      reportingEmployee,
      messageId,
    });
  }

  // ── 4. Prevent duplicate processing ─────────────────────────────
  const existing = d.prepare('SELECT * FROM completion_claims WHERE task_id = ? AND message_id = ?').get(taskId, messageId);
  if (existing) {
    return res.status(409).json({
      error: 'Duplicate: this message has already been processed as a completion claim for this task',
      existingClaim: mapCompletionClaim(existing),
      taskId,
      messageId,
    });
  }

  // ── 5. Apply workspace verification policy ──────────────────────
  const protectedTask = isProtectedTask(taskRow);
  const taskCategory = taskRow.category;
  const taskVerification = taskRow.verification;
  const claimText = msgRow.body;
  const ts = Date.now();
  const claimId = `cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // Progress-only and ambiguous messages must never be interpreted as
  // completed work. Record them as evidence without altering the task.
  if (claimType === 'progress' || claimType === 'ambiguous') {
    const tx2 = d.transaction(() => {
      d.prepare(
        `INSERT OR IGNORE INTO completion_claims (id, workspace_id, task_id, message_id, reporting_employee, claim_text, claim_type, status, verification_applied, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'recorded', 'none', ?)`,
      ).run(claimId, ws, taskId, messageId, reportingEmployee, claimText, claimType, ts);

      d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'chat_progress_report', 'task', taskId, 'silent-ai',
        `Non-completion chat report from chat: ${reportingEmployee} reported "${claimText.slice(0, 100)}" (msg ${messageId}). Task status unchanged.`, ts,
      );
      bumpRevision();
    });
    tx2();

    notifySSE(ws, { type: 'proposal', action: 'created', id: claimId });

    const task2 = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    const claim2 = d.prepare('SELECT * FROM completion_claims WHERE id = ?').get(claimId);
    return res.status(201).json({
      message: 'Progress or ambiguous claim recorded — task status unchanged',
      claim: mapCompletionClaim(claim2),
      task: mapTask(task2),
      verificationApplied: 'none',
      finalTaskStatus: task2.status,
      protectedTask,
      sourceMessage: { id: msgRow.id, user: msgRow.user_id, body: msgRow.body },
    });
  }

  // Determine the final task status and verification applied.
  let finalTaskStatus;
  let verificationApplied;
  let claimStatus;
  let proposalType;
  let proposalSummary;
  let proposalReasoning;
  let proposalConfidence;

  if (protectedTask) {
    // Protected task (repairs, purchases, safety, or verification=qualified):
    // Move to 'review' — requires qualified human verification.
    // AI cannot mark this done. Manager approval alone is NOT sufficient.
    finalTaskStatus = 'review';
    verificationApplied = 'qualified';
    claimStatus = 'pending_review';
    proposalType = 'completion_review';
    proposalSummary = `Chat-derived completion claim for "${taskRow.name}" — requires qualified verification`;
    proposalReasoning =
      `Employee ${reportingEmployee} reported task completion in chat message ${messageId}: ` +
      `"${claimText}". This task is in the "${taskCategory}" category with verification="${taskVerification}", ` +
      `which requires qualified human verification. The task has been moved to 'review' status. ` +
      `The chat message is recorded as evidence of the employee's self-attestation, NOT as independent proof ` +
      `of completion. A qualified human must verify this work before it can be marked 'done'. ` +
      `CRITICAL: If the manager approves this review, they MUST provide explicit qualified verification evidence. ` +
      `Without it, the task will remain in 'review' status.`;
    proposalConfidence = 'medium';
  } else {
    // Routine task with self-report permitted:
    // Mark as 'done' — this is a self-attestation, not independent proof.
    finalTaskStatus = 'done';
    verificationApplied = 'self-report';
    claimStatus = 'processed';
    proposalType = 'chat_completion_claim';
    proposalSummary = `Chat-derived completion: "${taskRow.name}" marked done by ${reportingEmployee}'s self-report`;
    proposalReasoning =
      `Employee ${reportingEmployee} reported task completion in chat message ${messageId}: ` +
      `"${claimText}". This is a routine task in the "${taskCategory}" category with self-report verification permitted. ` +
      `The task has been marked as 'done' based on the employee's self-attestation. ` +
      `IMPORTANT: This is a self-reported claim, NOT independent proof of completion. ` +
      `The source chat message is preserved as evidence. The manager can review and reopen if needed.`;
    proposalConfidence = 'high';
  }

  // ── 6. Execute all changes in a transaction ─────────────────────
  const tx = d.transaction(() => {
    // Record the completion claim.
    d.prepare(
      `INSERT OR IGNORE INTO completion_claims (id, workspace_id, task_id, message_id, reporting_employee, claim_text, claim_type, status, verification_applied, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(claimId, ws, taskId, messageId, reportingEmployee, claimText, claimType, claimStatus, verificationApplied, ts);

    // Update the task status and completion field.
    const completionText = `Chat-reported by ${reportingEmployee}: "${claimText.slice(0, 200)}" [Source: ${messageId}]`;
    d.prepare('UPDATE tasks SET status = ?, completion = ?, updated_at = ? WHERE id = ?').run(
      finalTaskStatus, completionText, ts, taskId,
    );

    // Create an AI proposal for manager visibility.
    const proposalId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const evidence = [
      `Source message ID: ${messageId}`,
      `Message text: "${claimText}"`,
      `Message sender: ${msgRow.user_id}`,
      `Task: ${taskRow.name} (ID: ${taskId})`,
      `Task category: ${taskCategory}`,
      `Task verification: ${taskVerification}`,
      `Reporting employee: ${reportingEmployee}`,
      `Task assignee: ${taskRow.assignee}`,
      `Verification applied: ${verificationApplied}`,
      `Claim type: ${claimType}`,
    ];
    if (protectedTask) {
      evidence.push('PROTECTED: Requires qualified human verification before done');
    } else {
      evidence.push('ROUTINE: Self-report permitted — self-attestation recorded, not independent proof');
    }

    d.prepare(
      `INSERT INTO ai_proposals (id, workspace_id, type, entity_type, entity_id, summary, evidence, reasoning, confidence, status, proposed_data, source_message_id, created_at)
       VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(
      proposalId, ws, proposalType, taskId, proposalSummary,
      JSON.stringify(evidence), proposalReasoning, proposalConfidence,
      JSON.stringify({ claimId, taskId, messageId, reportingEmployee, finalTaskStatus, verificationApplied }),
      messageId,
      ts,
    );

    // Audit log entries.
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'chat_completion_claim', 'task', taskId, 'silent-ai',
      `Completion claim from chat: ${reportingEmployee} reported "${claimText.slice(0, 100)}" (msg ${messageId}). Task → ${finalTaskStatus}. Verification: ${verificationApplied}`, ts,
    );

    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'task_status_changed', 'task', taskId, 'silent-ai',
      `${taskRow.status} → ${finalTaskStatus} (chat-derived completion claim)`, ts,
    );

    bumpRevision();
  });
  tx();

  // ── 7. Notify SSE clients ───────────────────────────────────────
  notifySSE(ws, { type: 'task', action: 'updated', id: taskId, status: finalTaskStatus });
  notifySSE(ws, { type: 'proposal', action: 'created', id: claimId });

  // ── 8. Return the result ────────────────────────────────────────
  const updatedTask = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const proposal = d.prepare('SELECT * FROM ai_proposals WHERE entity_id = ? AND created_at = ?').get(taskId, ts);
  const claim = d.prepare('SELECT * FROM completion_claims WHERE id = ?').get(claimId);

  res.status(201).json({
    message: protectedTask
      ? 'Completion claim recorded. Task moved to review — qualified verification required.'
      : 'Completion claim processed. Task marked done (self-attestation, not independent proof).',
    claim: mapCompletionClaim(claim),
    task: mapTask(updatedTask),
    proposal: proposal ? mapProposal(proposal) : null,
    verificationApplied,
    finalTaskStatus,
    protectedTask,
    sourceMessage: { id: msgRow.id, user: msgRow.user_id, body: msgRow.body },
  });
});

// ── Silent AI Analysis Log (Phase 5) ─────────────────────────────────
//
// These endpoints let the scheduled Silent AI automation record each
// analysis run and let managers monitor when the AI last ran, how many
// messages it analyzed, what it proposed, and whether any errors occurred.
//
// GET  /api/workspaces/:workspace/ai-status — latest run + aggregate stats
// POST /api/workspaces/:workspace/ai-log   — record a new analysis run

/** GET /api/workspaces/:workspace/ai-status — monitoring status for managers. */
app.get('/api/workspaces/:workspace/ai-status', validateWorkspace, (req, res) => {
  const d = getDB();

  // Latest analysis run.
  const latest = d.prepare(
    'SELECT * FROM ai_analysis_log WHERE workspace_id = ? ORDER BY run_at DESC LIMIT 1',
  ).get(req.workspaceId);

  // Aggregate stats across all runs.
  const agg = d.prepare(
    `SELECT
       COUNT(*)                    as total_runs,
       COALESCE(SUM(messages_new), 0)      as total_messages_analyzed,
       COALESCE(SUM(proposals_created), 0)  as total_proposals,
       COALESCE(SUM(completion_claims), 0)  as total_claims,
       MAX(run_at)                 as last_run_at
     FROM ai_analysis_log WHERE workspace_id = ?`,
  ).get(req.workspaceId);

  // Check for stalled monitoring: no run in the last 2 hours.
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const lastRunAt = latest?.run_at || 0;
  const stalled = lastRunAt > 0 && lastRunAt < twoHoursAgo;

  // Detect running / stale-running state (Fix 4).
  const isRunning = latest?.status === 'running';
  const runningSince = isRunning ? latest.run_at : null;
  const staleRunning = isRunning && (Date.now() - latest.run_at) >= STALE_RUN_MS;

  res.json({
    latest: latest ? mapAIAnalysisLog(latest) : null,
    aggregates: {
      totalRuns: agg.total_runs || 0,
      totalMessagesAnalyzed: agg.total_messages_analyzed || 0,
      totalProposalsCreated: agg.total_proposals || 0,
      totalCompletionClaims: agg.total_claims || 0,
      lastRunAt: agg.last_run_at || null,
    },
    stalled,
    running: isRunning,
    runningSince,
    staleRunning,
    revision: currentRevision(),
  });
});

/** POST /api/workspaces/:workspace/ai-log — record a Silent AI analysis run. */
app.post('/api/workspaces/:workspace/ai-log', validateWorkspace, (req, res) => {
  const {
    messagesTotal = 0,
    messagesNew = 0,
    proposalsCreated = 0,
    completionClaims = 0,
    errors = '',
    lastMessageSeq = 0,
    status = 'success',
    summary = '',
  } = req.body;

  // Validate status enum — 'running' and 'interrupted' are used by the
  // new ai-run/* lifecycle endpoints (Fix 4); the legacy one-shot POST
  // /ai-log can also accept them for backward compatibility.
  const validStatuses = ['success', 'partial', 'error', 'stalled', 'running', 'interrupted'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  const logId = `ail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = Date.now();
  const d = getDB();

  d.prepare(
    `INSERT INTO ai_analysis_log (id, workspace_id, run_at, messages_total, messages_new, proposals_created, completion_claims, errors, last_message_seq, status, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    logId, req.workspaceId, ts,
    Math.max(0, parseInt(messagesTotal, 10) || 0),
    Math.max(0, parseInt(messagesNew, 10) || 0),
    Math.max(0, parseInt(proposalsCreated, 10) || 0),
    Math.max(0, parseInt(completionClaims, 10) || 0),
    String(errors).slice(0, 2000),
    Math.max(0, parseInt(lastMessageSeq, 10) || 0),
    status,
    String(summary).slice(0, 2000),
    ts,
  );

  // Log to audit trail for traceability.
  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, req.workspaceId, 'ai_analysis_run', 'ai_log', logId, 'silent-ai',
    `Analysis run: ${messagesNew} new msgs, ${proposalsCreated} proposals, ${completionClaims} claims. Status: ${status}${errors ? '. Errors: ' + String(errors).slice(0, 200) : ''}`,
    ts,
  );

  bumpRevision();
  notifySSE(req.workspaceId, { type: 'ai_log', action: 'recorded', id: logId });

  const row = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(logId);
  res.status(201).json(mapAIAnalysisLog(row));
});

// ── AI Integration Endpoints ─────────────────────────────────────────
//
// Tencent AI (default provider):
//   GET  /api/workspaces/:workspace/tencent-status — Tencent agent status
//   POST /api/tencent/retry-pending                — Recovery: retry pending jobs
//
// Legacy Groq AI (backward compat, disabled when AI_PROVIDER=tencent-local):
//   GET  /api/workspaces/:workspace/groq-status    — Groq agent status
//   POST /api/groq/retry-pending                   — Recovery: retry pending jobs

/** GET /api/workspaces/:workspace/tencent-status — Tencent agent monitoring. */
app.get('/api/workspaces/:workspace/tencent-status', validateWorkspace, (req, res) => {
  res.json(getTencentStatus(req.workspaceId));
});

/** POST /api/tencent/retry-pending — recovery endpoint for failed/pending jobs. */
app.post('/api/tencent/retry-pending', async (_req, res) => {
  const result = await dispatchProcessPending();
  res.json(result);
});

// ── WorkBuddy Automation Path (Phase D supplement) ──────────────────
//
// When CodeBuddy serve is not available, pending AI jobs can be
// processed by the WorkBuddy Desktop AI session via MCP tools.
// The hourly automation sends a prompt to the AI, which:
//   1. Calls GET /api/tencent/pending-jobs to fetch unprocessed jobs
//   2. Reads each message and analyzes it
//   3. Uses MCP tools (create_manager_task, propose_completion, etc.)
//      to take real actions in the ShiftBridge database
//   4. Calls POST /api/tencent/jobs/:jobId/complete to mark each job
//      as completed with the actions taken
//
// This is the GENUINE Tencent AI processing path — the WorkBuddy AI
// (running in an authenticated Tencent session) processes messages
// directly via MCP tools, not simulated.

/** GET /api/tencent/pending-jobs — fetch pending AI jobs with message context. */
app.get('/api/tencent/pending-jobs', (_req, res) => {
  const d = getDB();
  const jobs = d.prepare(
    `SELECT j.id as jobId, j.workspace_id, j.message_id, j.status, j.attempts,
            j.created_at, m.user_id as messageUser, m.body as messageBody, m.seq as messageSeq
     FROM ai_jobs j
     LEFT JOIN messages m ON m.id = j.message_id
     WHERE j.status = 'pending' AND j.attempts < j.max_attempts
     ORDER BY j.created_at ASC
     LIMIT 20`
  ).all();

  res.json({ pendingJobs: jobs, count: jobs.length });
});

/** POST /api/tencent/jobs/:jobId/complete — mark a job completed after MCP tool processing. */
app.post('/api/tencent/jobs/:jobId/complete', (req, res) => {
  // Manual WorkBuddy completion is a separate, explicitly opted-in route.
  // Otherwise anyone on the demo LAN could fabricate successful AI actions.
  const secret = process.env.SHIFTBRIDGE_MANUAL_AI_TOKEN;
  if (!secret) {
    return res.status(503).json({ error: 'Manual AI completion disabled; use the event-driven agent' });
  }
  if (req.get('Authorization') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Authorized agent required' });
  }
  const { jobId } = req.params;
  const { actions, analysis, model } = req.body;
  if (!Array.isArray(actions)) {
    return res.status(400).json({ error: 'actions must be an array' });
  }
  const d = getDB();
  const ts = Date.now();

  const job = d.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  if (job.status === 'completed') {
    return res.status(409).json({ error: 'Job already completed' });
  }
  // Do not accept an unverified claim that a manager task was created.
  for (const action of actions) {
    if (action.type === 'create_manager_task' && action.ok === true) {
      const found = d.prepare(
        'SELECT id FROM tasks WHERE workspace_id = ? AND source = ? LIMIT 1',
      ).get(job.workspace_id, job.message_id);
      if (!found) {
        return res.status(409).json({ error: 'Claimed manager task has no matching persisted task' });
      }
    }
  }

  // Update job to completed
  d.prepare(
    `UPDATE ai_jobs SET status = 'completed', last_error = '',
     actions_json = ?, latency_ms = ?, model_used = ?,
     completed_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(actions || []),
    Date.now() - job.created_at,
    model || 'tencent-workbuddy-mcp',
    ts, ts, jobId,
  );

  // Log to ai_analysis_log
  const logId = `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const proposalsCreated = (actions || []).filter(a => a.type === 'create_manager_task' && a.ok).length;
  const completionClaims = (actions || []).filter(a => a.type === 'propose_completion' && a.ok).length;
  const errors = (actions || []).filter(a => !a.ok).map(a => `${a.type}: ${a.error || 'failed'}`).join('; ');

  d.prepare(
    `INSERT INTO ai_analysis_log (id, workspace_id, run_at, messages_total, messages_new,
     proposals_created, completion_claims, errors, last_message_seq, status, summary, created_at)
     VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, 'success', ?, ?)`,
  ).run(
    logId, job.workspace_id, ts, proposalsCreated, completionClaims,
    errors, req.body.messageSeq || 0,
    `Tencent AI (WorkBuddy MCP): ${analysis || 'Processed via MCP tools'} | Actions: ${(actions || []).length}`,
    ts,
  );

  bumpRevision();
  notifySSE(job.workspace_id, {
    type: 'ai_processed',
    messageId: job.message_id,
    actions: (actions || []).length,
    analysis: (analysis || '').slice(0, 200),
    latency: Date.now() - job.created_at,
  });

  res.json({ ok: true, jobId, status: 'completed', actions: actions || [] });
});

/** GET /api/workspaces/:workspace/groq-status — Legacy Groq agent monitoring. */
app.get('/api/workspaces/:workspace/groq-status', validateWorkspace, (req, res) => {
  res.json(getGroqStatus(req.workspaceId));
});

/** POST /api/groq/retry-pending — legacy recovery endpoint (kept for backward compat). */
app.post('/api/groq/retry-pending', async (_req, res) => {
  const result = await dispatchProcessPending();
  res.json(result);
});

// ── Silent AI Run Lifecycle (Phase 5.1 — Fix 4) ──────────────────────
//
// The legacy POST /ai-log endpoint records a completed run in one shot.
// The new three-step lifecycle (start → checkpoint → finish) supports:
//   • Overlap prevention — ai-run/start refuses if another run is active
//     (stale runs older than 5 min are auto-finalized as 'interrupted').
//   • Mid-run checkpointing — ai-run/checkpoint advances last_message_seq
//     after each message or batch, so interrupted runs don't lose progress.
//   • Per-message error quarantine — failed messages are recorded in
//     processing_errors[] without blocking the checkpoint from advancing.
//   • Clean finish — ai-run/finish finalizes status/summary/errors.

const STALE_RUN_MS = 5 * 60 * 1000; // 5 minutes — overlap threshold

/** POST /api/workspaces/:workspace/ai-run/start — begin a new analysis run. */
app.post('/api/workspaces/:workspace/ai-run/start', validateWorkspace, (req, res) => {
  const d = getDB();
  const ts = Date.now();

  // Check for an existing 'running' entry in this workspace.
  const active = d.prepare(
    `SELECT * FROM ai_analysis_log
     WHERE workspace_id = ? AND status = 'running'
     ORDER BY run_at DESC LIMIT 1`,
  ).get(req.workspaceId);

  if (active) {
    const elapsed = ts - active.run_at;
    if (elapsed < STALE_RUN_MS) {
      // Overlap: another run is in progress and hasn't gone stale.
      return res.status(409).json({
        error: 'A run is already in progress for this workspace.',
        activeRun: mapAIAnalysisLog(active),
        retryAfterMs: STALE_RUN_MS - elapsed,
      });
    }
    // Stale run: auto-finalize as 'interrupted' so we can start a new one.
    d.prepare(
      `UPDATE ai_analysis_log
       SET status = 'interrupted',
           summary = COALESCE(summary, '') || ' [Auto-finalized: run exceeded 5 min without completion]'
       WHERE id = ?`,
    ).run(active.id);
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, req.workspaceId,
      'ai_run_stale_finalize', 'ai_log', active.id, 'silent-ai',
      `Stale run (elapsed ${Math.round(elapsed / 1000)}s) auto-finalized as interrupted.`,
      ts,
    );
  }

  // Starting checkpoint: latest non-running entry's last_message_seq.
  const prev = d.prepare(
    `SELECT last_message_seq FROM ai_analysis_log
     WHERE workspace_id = ? AND status != 'running'
     ORDER BY run_at DESC LIMIT 1`,
  ).get(req.workspaceId);
  const startSeq = prev?.last_message_seq || 0;

  // Create a new 'running' entry.
  const logId = `ail_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  d.prepare(
    `INSERT INTO ai_analysis_log
       (id, workspace_id, run_at, messages_total, messages_new,
        proposals_created, completion_claims, errors, last_message_seq,
        status, summary, processing_errors, created_at)
     VALUES (?, ?, ?, 0, 0, 0, 0, '', ?, 'running', '', '[]', ?)`,
  ).run(logId, req.workspaceId, ts, startSeq, ts);

  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, req.workspaceId,
    'ai_run_start', 'ai_log', logId, 'silent-ai',
    `Analysis run started. Starting checkpoint: seq ${startSeq}.`,
    ts,
  );

  bumpRevision();
  notifySSE(req.workspaceId, { type: 'ai_run', action: 'started', id: logId });

  const row = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(logId);
  res.status(201).json({ ...mapAIAnalysisLog(row), startSeq });
});

/** PATCH /api/workspaces/:workspace/ai-run/checkpoint — advance mid-run progress. */
app.patch('/api/workspaces/:workspace/ai-run/checkpoint', validateWorkspace, (req, res) => {
  const d = getDB();
  const active = d.prepare(
    `SELECT * FROM ai_analysis_log
     WHERE workspace_id = ? AND status = 'running'
     ORDER BY run_at DESC LIMIT 1`,
  ).get(req.workspaceId);

  if (!active) {
    return res.status(404).json({ error: 'No active run to checkpoint.' });
  }

  const {
    lastMessageSeq,
    proposalsCreated,
    completionClaims,
    messagesNew,
    processingErrors,
  } = req.body;

  // Advance only forward — never let the checkpoint go backward.
  const newSeq = Math.max(
    active.last_message_seq,
    Math.max(0, parseInt(lastMessageSeq, 10) || 0),
  );

  // Merge processing errors into the existing JSON array (quarantine).
  let errorsArr = [];
  try { errorsArr = JSON.parse(active.processing_errors || '[]'); } catch { /* keep empty */ }
  if (Array.isArray(processingErrors)) {
    errorsArr = [...errorsArr, ...processingErrors];
  }

  d.prepare(
    `UPDATE ai_analysis_log
     SET last_message_seq = ?,
         proposals_created = ?,
         completion_claims = ?,
         messages_new = ?,
         processing_errors = ?
     WHERE id = ?`,
  ).run(
    newSeq,
    Math.max(active.proposals_created, Math.max(0, parseInt(proposalsCreated, 10) || 0)),
    Math.max(active.completion_claims, Math.max(0, parseInt(completionClaims, 10) || 0)),
    Math.max(active.messages_new, Math.max(0, parseInt(messagesNew, 10) || 0)),
    JSON.stringify(errorsArr),
    active.id,
  );

  const row = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(active.id);
  res.json(mapAIAnalysisLog(row));
});

/** POST /api/workspaces/:workspace/ai-run/finish — finalize an analysis run. */
app.post('/api/workspaces/:workspace/ai-run/finish', validateWorkspace, (req, res) => {
  const d = getDB();
  const active = d.prepare(
    `SELECT * FROM ai_analysis_log
     WHERE workspace_id = ? AND status = 'running'
     ORDER BY run_at DESC LIMIT 1`,
  ).get(req.workspaceId);

  if (!active) {
    return res.status(404).json({ error: 'No active run to finalize.' });
  }

  const {
    messagesTotal = active.messages_new,
    messagesNew = active.messages_new,
    proposalsCreated = active.proposals_created,
    completionClaims = active.completion_claims,
    lastMessageSeq = active.last_message_seq,
    errors = '',
    status = 'success',
    summary = '',
    processingErrors,
  } = req.body;

  const validFinal = ['success', 'partial', 'error', 'interrupted'];
  if (!validFinal.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${validFinal.join(', ')}`,
    });
  }

  // Merge any final processing errors.
  let errorsArr = [];
  try { errorsArr = JSON.parse(active.processing_errors || '[]'); } catch { /* keep empty */ }
  if (Array.isArray(processingErrors)) {
    errorsArr = [...errorsArr, ...processingErrors];
  }

  const ts = Date.now();
  d.prepare(
    `UPDATE ai_analysis_log
     SET messages_total = ?,
         messages_new = ?,
         proposals_created = ?,
         completion_claims = ?,
         last_message_seq = ?,
         errors = ?,
         status = ?,
         summary = ?,
         processing_errors = ?
     WHERE id = ?`,
  ).run(
    Math.max(0, parseInt(messagesTotal, 10) || 0),
    Math.max(0, parseInt(messagesNew, 10) || 0),
    Math.max(0, parseInt(proposalsCreated, 10) || 0),
    Math.max(0, parseInt(completionClaims, 10) || 0),
    Math.max(active.last_message_seq, Math.max(0, parseInt(lastMessageSeq, 10) || 0)),
    String(errors).slice(0, 2000),
    status,
    String(summary).slice(0, 2000),
    JSON.stringify(errorsArr),
    active.id,
  );

  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, req.workspaceId,
    'ai_run_finish', 'ai_log', active.id, 'silent-ai',
    `Analysis run finalized. Status: ${status}. ${messagesNew} new msgs, ${proposalsCreated} proposals, ${completionClaims} claims. ${errorsArr.length > 0 ? errorsArr.length + ' quarantined errors.' : ''}`,
    ts,
  );

  bumpRevision();
  notifySSE(req.workspaceId, { type: 'ai_run', action: 'finished', id: active.id });

  const row = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(active.id);
  res.json(mapAIAnalysisLog(row));
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: Direct Task Assignment, Issue Reporting & Announcements
// ═══════════════════════════════════════════════════════════════════════

// ── Helper: check if a user is a workspace member ───────────────────
function isWorkspaceMember(d, workspaceId, personId) {
  if (!personId) return false;
  const row = d.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND person_id = ?').get(workspaceId, personId);
  return !!row;
}

// ── Helper: get the manager (admin) of a workspace ─────────────────
function getWorkspaceManager(d, workspaceId) {
  const row = d.prepare('SELECT person_id FROM workspace_members WHERE workspace_id = ? AND role = ?').get(workspaceId, 'admin');
  return row?.person_id || null;
}

// ── Workflow A: Direct Manager Task Assignment ─────────────────────

/** POST /api/workspaces/:workspace/manager-task — create a routine task
 *  directly from a verified manager instruction. No proposal needed.
 *
 *  Server-side validation:
 *    1. Source message must exist in this workspace.
 *    2. Source message author must be the workspace manager (admin).
 *    3. Assignee must be a workspace member.
 *    4. Category must be allowed (not protected: repairs, purchases, safety).
 *    5. Idempotency: (workspace_id, source, name) unique index prevents duplicates.
 */
app.post('/api/workspaces/:workspace/manager-task', validateWorkspace, (req, res) => {
  const d = getDB();
  const {
    sourceMessageId, name, description = '', assignee = null,
    priority = 'normal', category = 'routine', due = 'Today',
    reasoning = '', createdBy = 'silent-ai',
  } = req.body;

  // 1. Validate required fields.
  if (!sourceMessageId) return res.status(400).json({ error: 'sourceMessageId is required — must link to a real chat message' });
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return res.status(400).json({ error: 'name is required' });

  // 2. Verify the source message exists in this workspace.
  const msg = d.prepare('SELECT * FROM messages WHERE id = ? AND workspace_id = ?').get(sourceMessageId, req.workspaceId);
  if (!msg) return res.status(404).json({ error: 'Source message not found in this workspace', messageId: sourceMessageId });

  // 3. Verify the source message author is the workspace manager.
  const managerId = getWorkspaceManager(d, req.workspaceId);
  if (!managerId) return res.status(403).json({ error: 'No manager (admin) found for this workspace' });
  if (msg.user_id !== managerId) {
    return res.status(403).json({
      error: 'Source message was not authored by the workspace manager',
      messageAuthor: msg.user_id,
      managerId,
    });
  }

  // 4. Verify the assignee is a workspace member (if provided).
  if (assignee && !isWorkspaceMember(d, req.workspaceId, assignee)) {
    return res.status(403).json({ error: `Assignee "${assignee}" is not a member of this workspace` });
  }

  // 5. Verify the category is not protected.
  if (PROTECTED_CATEGORIES.includes(category)) {
    return res.status(403).json({
      error: `Category "${category}" is protected — requires qualified verification, cannot be auto-assigned`,
      protected: true,
    });
  }

  // 6. Check workspace rules — is this category allowed?
  const ruleRow = d.prepare('SELECT * FROM rules WHERE workspace_id = ? AND id = ?').get(req.workspaceId, category);
  if (ruleRow && !ruleRow.allowed) {
    return res.status(403).json({
      error: `Category "${category}" is not allowed for automatic assignment in this workspace`,
    });
  }

  // 7. Idempotency: check for existing task with same (workspace, source, name).
  const existing = d.prepare(
    'SELECT * FROM tasks WHERE workspace_id = ? AND source = ? AND name = ?',
  ).get(req.workspaceId, sourceMessageId, trimmedName.slice(0, 100));

  if (existing) {
    return res.status(200).json({
      ...mapTask(existing),
      duplicate: true,
      message: 'A task with the same source message and name already exists.',
    });
  }

  // 8. Create the task directly — no proposal needed.
  const taskId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = Date.now();

  d.prepare(
    `INSERT INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, 'self-report', '', ?, ?)`,
  ).run(taskId, req.workspaceId, trimmedName.slice(0, 100), String(description).slice(0, 1000),
    assignee, priority, category, String(due).slice(0, 50),
    sourceMessageId, `${createdBy}-manager`, ts, ts);

  // 9. Audit entry.
  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, req.workspaceId,
    'manager_task_created', 'task', taskId, createdBy,
    `Direct task from manager instruction (msg ${sourceMessageId}): "${trimmedName}" assigned to ${assignee || 'unassigned'}. Reasoning: ${reasoning.slice(0, 200)}`,
    ts,
  );

  bumpRevision();
  notifySSE(req.workspaceId, { type: 'task', action: 'created', id: taskId, direct: true });

  const row = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  res.status(201).json({ ...mapTask(row), direct: true, message: 'Task created directly from manager instruction.' });
});

// ── Workflow B: Employee Reports Chat Message as Issue ─────────────

/** POST /api/workspaces/:workspace/report-issue — flag a chat message as
 *  an operational issue. Creates the issue immediately — no AI needed.
 *
 *  Idempotency: unique index on (workspace_id, source) prevents duplicate
 *  issues from the same message. If an issue already exists, returns it.
 */
app.post('/api/workspaces/:workspace/report-issue', validateWorkspace, (req, res) => {
  const d = getDB();
  const { messageId, reporterId, title = '', issueType = 'general', detectedByAi = false } = req.body;

  if (!messageId) return res.status(400).json({ error: 'messageId is required' });
  if (!reporterId) return res.status(400).json({ error: 'reporterId is required' });

  // Verify the message exists in this workspace.
  const msg = d.prepare('SELECT * FROM messages WHERE id = ? AND workspace_id = ?').get(messageId, req.workspaceId);
  if (!msg) return res.status(404).json({ error: 'Message not found in this workspace', messageId });

  // Verify the reporter is a workspace member.
  if (!isWorkspaceMember(d, req.workspaceId, reporterId)) {
    return res.status(403).json({ error: 'Reporter is not a member of this workspace' });
  }

  // AI-reported incidents must be tied to the actual author of the message.
  // This cannot prove the incident is true; it only verifies attribution.
  if (detectedByAi && reporterId !== msg.user_id) {
    return res.status(403).json({ error: 'AI report must attribute the source message to its actual author' });
  }
  if (detectedByAi && !['equipment', 'inventory', 'safety', 'general'].includes(issueType)) {
    return res.status(400).json({ error: 'Invalid AI issue type' });
  }

  // Idempotency: check for existing issue with same (workspace, source).
  const existing = d.prepare(
    'SELECT * FROM issues WHERE workspace_id = ? AND source = ?',
  ).get(req.workspaceId, messageId);

  if (existing) {
    return res.status(200).json({
      ...mapIssue(existing),
      duplicate: true,
      message: 'An issue has already been reported for this message.',
    });
  }

  // Merge explicitly identified equipment reports with the same unresolved
  // incident. Do NOT infer links from words like "it" or generic "machine".
  const entityKey = normalizeEntityKey(msg.body);
  const matched = findMatchingOpenIssue(d, req.workspaceId, entityKey);
  if (matched) {
    const link = linkMessageToIssue(d, {
      workspaceId:req.workspaceId, issueId:matched.id, messageId, relation:'report',
      actor:detectedByAi ? 'silent-ai' : reporterId,
      reason:'Existing active incident with exact matching equipment identifier',
    });
    if (!link.ok) return res.status(link.status).json({error:link.error});
    if (issueType === 'safety') {
      d.prepare("UPDATE issues SET severity='high',requires_approval=1,issue_type='safety' WHERE id=? AND workspace_id=?")
        .run(matched.id,req.workspaceId);
    }
    bumpRevision();
    notifySSE(req.workspaceId,{type:'issue',action:'linked',id:matched.id,messageId});
    const row = d.prepare('SELECT * FROM issues WHERE id=?').get(matched.id);
    return res.status(200).json({...mapIssue(row),linked:true,duplicate:false});
  }

  // Create the issue.
  const issueId = `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = Date.now();
  const issueTitle = title.trim() || `Reported issue from ${msg.user_id}'s message`;

  d.prepare(
    `INSERT INTO issues (id, workspace_id, title, description, severity, status, source, created_by, reporter_id, requires_approval, approved, evidence, issue_type, created_at, entity_key, last_activity_at)
     VALUES (?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).run(issueId, req.workspaceId, issueTitle.slice(0, 200),
    msg.body, detectedByAi && issueType === 'safety' ? 'high' : 'normal',
    messageId, detectedByAi ? 'silent-ai' : reporterId, reporterId,
    detectedByAi && issueType === 'safety' ? 1 : 0,
    detectedByAi
      ? `Unverified AI-detected claim in message ${messageId}; requires human confirmation.`
      : `Source message: "${msg.body.slice(0, 200)}"`,
    issueType, ts, entityKey, ts);

  const link = linkMessageToIssue(d, {
    workspaceId:req.workspaceId,issueId,messageId,relation:'report',
    actor:detectedByAi ? 'silent-ai' : reporterId,reason:'Original source message for incident',
  });
  if (!link.ok) throw new Error(link.error);

  // Audit entry.
  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, req.workspaceId,
    detectedByAi ? 'issue_ai_reported' : 'issue_reported', 'issue', issueId,
    detectedByAi ? 'silent-ai' : reporterId,
    detectedByAi
      ? `AI identified possible problem in message ${messageId}; source author ${reporterId}; needs verification`
      : `Employee ${reporterId} flagged message ${messageId} as an issue: "${msg.body.slice(0, 150)}"`,
    ts,
  );

  bumpRevision();
  notifySSE(req.workspaceId, { type: 'issue', action: 'reported', id: issueId, messageId });

  const row = d.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
  res.status(201).json(mapIssue(row));
});

// ── Workflow C: Manager-Controlled Announcements ───────────────────

/** POST /api/workspaces/:workspace/announcements — create or publish an announcement.
 *
 *  Body:
 *    title, body, type ('general'|'important'|'safety'), status ('draft'|'active'),
 *    publisherId (must be workspace manager/admin),
 *    linkedIssueId (optional — for AI drafts responding to a flagged issue)
 */
app.post('/api/workspaces/:workspace/announcements', validateWorkspace, (req, res) => {
  const d = getDB();
  const { title, body, type = 'general', status = 'active', publisherId, linkedIssueId = null } = req.body;

  const trimmedTitle = String(title || '').trim();
  const trimmedBody = String(body || '').trim();
  if (!trimmedTitle) return res.status(400).json({ error: 'title is required' });
  if (!trimmedBody) return res.status(400).json({ error: 'body is required' });

  // Validate type.
  const validTypes = ['general', 'important', 'safety'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });

  // Validate status.
  const validStatuses = ['draft', 'active'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: `status must be 'draft' or 'active'` });

  // If publishing (status=active), verify publisher is the workspace manager.
  let publisher = null;
  if (status === 'active') {
    if (!publisherId) return res.status(400).json({ error: 'publisherId is required to publish an announcement' });
    const managerId = getWorkspaceManager(d, req.workspaceId);
    if (!managerId || publisherId !== managerId) {
      return res.status(403).json({ error: 'Only the workspace manager can publish announcements' });
    }
    publisher = publisherId;
  }

  // If linkedIssueId provided, verify it exists in this workspace.
  if (linkedIssueId) {
    const issue = d.prepare('SELECT id FROM issues WHERE id = ? AND workspace_id = ?').get(linkedIssueId, req.workspaceId);
    if (!issue) return res.status(404).json({ error: 'Linked issue not found in this workspace' });
  }

  const annId = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = Date.now();

  d.prepare(
    `INSERT INTO announcements (id, workspace_id, title, body, type, status, publisher_id, linked_issue_id, created_by, created_at, published_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(annId, req.workspaceId, trimmedTitle.slice(0, 200), trimmedBody.slice(0, 2000),
    type, status, publisher, linkedIssueId,
    status === 'active' ? publisherId : (publisherId || 'silent-ai'),
    ts, status === 'active' ? ts : null);

  // Audit entry.
  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, req.workspaceId,
    status === 'active' ? 'announcement_published' : 'announcement_draft_created',
    'announcement', annId,
    publisherId || 'silent-ai',
    `${status === 'active' ? 'Published' : 'Drafted'} announcement "${trimmedTitle.slice(0, 80)}" (type: ${type})${linkedIssueId ? ` linked to issue ${linkedIssueId}` : ''}`,
    ts,
  );

  bumpRevision();
  notifySSE(req.workspaceId, { type: 'announcement', action: status === 'active' ? 'published' : 'drafted', id: annId });

  const row = d.prepare('SELECT * FROM announcements WHERE id = ?').get(annId);
  res.status(201).json(mapAnnouncement(row));
});

/** GET /api/workspaces/:workspace/announcements — list announcements.
 *  ?status=active|draft|archived (default: all)
 */
app.get('/api/workspaces/:workspace/announcements', validateWorkspace, (req, res) => {
  const d = getDB();
  const statusFilter = req.query.status;
  let rows;
  if (statusFilter) {
    rows = d.prepare('SELECT * FROM announcements WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC').all(req.workspaceId, statusFilter);
  } else {
    rows = d.prepare('SELECT * FROM announcements WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  }

  const announcements = rows.map((row) => {
    const ann = mapAnnouncement(row);
    // Include acknowledgment count for each announcement.
    const ackCount = d.prepare('SELECT COUNT(*) as c FROM announcement_acknowledgments WHERE announcement_id = ?').get(row.id);
    ann.acknowledgmentCount = ackCount?.c || 0;
    return ann;
  });

  res.json({ announcements, revision: currentRevision() });
});

/** GET /api/workspaces/:workspace/announcements/active — get active pinned notices. */
app.get('/api/workspaces/:workspace/announcements/active', validateWorkspace, (req, res) => {
  const d = getDB();
  const rows = d.prepare('SELECT * FROM announcements WHERE workspace_id = ? AND status = ? ORDER BY published_at DESC').all(req.workspaceId, 'active');

  const announcements = rows.map((row) => {
    const ann = mapAnnouncement(row);
    const ackCount = d.prepare('SELECT COUNT(*) as c FROM announcement_acknowledgments WHERE announcement_id = ?').get(row.id);
    ann.acknowledgmentCount = ackCount?.c || 0;
    // Get list of members who acknowledged.
    const acks = d.prepare('SELECT person_id, acknowledged_at FROM announcement_acknowledgments WHERE announcement_id = ?').all(row.id);
    ann.acknowledgedBy = acks.map((a) => a.person_id);
    return ann;
  });

  res.json({ announcements, revision: currentRevision() });
});

/** GET /api/announcements/:id — get a single announcement with details. */
app.get('/api/announcements/:id', (req, res) => {
  const d = getDB();
  const row = d.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'announcement not found' });

  const ann = mapAnnouncement(row);
  // Include acknowledgment list.
  const acks = d.prepare('SELECT person_id, acknowledged_at FROM announcement_acknowledgments WHERE announcement_id = ?').all(req.params.id);
  ann.acknowledgments = acks;
  ann.acknowledgmentCount = acks.length;

  // Include revision history.
  const revs = d.prepare('SELECT * FROM announcement_revisions WHERE announcement_id = ? ORDER BY edited_at ASC').all(req.params.id);
  ann.revisions = revs.map(mapAnnouncementRevision);

  res.json(ann);
});

/** PUT /api/announcements/:id — edit an announcement (creates revision record). */
app.put('/api/announcements/:id', (req, res) => {
  const d = getDB();
  const { id } = req.params;
  const { title, body, editorId } = req.body;

  const row = d.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'announcement not found' });

  // Verify editor is the workspace manager.
  const managerId = getWorkspaceManager(d, row.workspace_id);
  if (!managerId || editorId !== managerId) {
    return res.status(403).json({ error: 'Only the workspace manager can edit announcements' });
  }

  const ts = Date.now();
  const newTitle = title !== undefined ? String(title).trim().slice(0, 200) : row.title;
  const newBody = body !== undefined ? String(body).trim().slice(0, 2000) : row.body;

  // Create revision record.
  if (title !== undefined || body !== undefined) {
    d.prepare(
      'INSERT INTO announcement_revisions (id, announcement_id, old_title, new_title, old_body, new_body, editor_id, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `rev_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, id,
      row.title, newTitle, row.body, newBody, editorId, ts,
    );
  }

  // Update the announcement.
  d.prepare('UPDATE announcements SET title = ?, body = ? WHERE id = ?').run(newTitle, newBody, id);

  // Audit entry.
  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id,
    'announcement_edited', 'announcement', id, editorId,
    `Edited announcement "${newTitle.slice(0, 80)}"`,
    ts,
  );

  bumpRevision();
  notifySSE(row.workspace_id, { type: 'announcement', action: 'edited', id });

  const updated = d.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  res.json(mapAnnouncement(updated));
});

/** PUT /api/announcements/:id/archive — archive an announcement.
 *  Safety warnings linked to protected issues cannot be archived until
 *  the issue is resolved with qualified clearance.
 */
app.put('/api/announcements/:id/archive', (req, res) => {
  const d = getDB();
  const { id } = req.params;
  const { archiverId } = req.body;

  const row = d.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'announcement not found' });
  if (row.status === 'archived') return res.status(400).json({ error: 'announcement is already archived' });

  // Verify archiver is the workspace manager.
  const managerId = getWorkspaceManager(d, row.workspace_id);
  if (!managerId || archiverId !== managerId) {
    return res.status(403).json({ error: 'Only the workspace manager can archive announcements' });
  }

  // Safety check: if this is a safety announcement linked to an unresolved issue,
  // prevent archiving until the issue is resolved.
  if (row.type === 'safety' && row.linked_issue_id) {
    const issue = d.prepare('SELECT status, verified_at FROM issues WHERE id = ?').get(row.linked_issue_id);
    if (issue && issue.status !== 'resolved' && !issue.verified_at) {
      return res.status(403).json({
        error: 'Cannot archive a safety warning linked to an unresolved issue. The issue must be resolved with qualified clearance first.',
        linkedIssueId: row.linked_issue_id,
        issueStatus: issue.status,
      });
    }
  }

  const ts = Date.now();
  d.prepare('UPDATE announcements SET status = ?, archived_at = ? WHERE id = ?').run('archived', ts, id);

  // Audit entry.
  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id,
    'announcement_archived', 'announcement', id, archiverId,
    `Archived announcement "${row.title.slice(0, 80)}"`,
    ts,
  );

  bumpRevision();
  notifySSE(row.workspace_id, { type: 'announcement', action: 'archived', id });

  const updated = d.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  res.json(mapAnnouncement(updated));
});

/** POST /api/announcements/:id/acknowledge — employee acknowledges a notice.
 *  Idempotent: PRIMARY KEY (announcement_id, person_id) prevents duplicates.
 */
app.post('/api/announcements/:id/acknowledge', (req, res) => {
  const d = getDB();
  const { id } = req.params;
  const { personId } = req.body;

  if (!personId) return res.status(400).json({ error: 'personId is required' });

  const ann = d.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!ann) return res.status(404).json({ error: 'announcement not found' });
  if (ann.status !== 'active') return res.status(400).json({ error: 'can only acknowledge active announcements' });

  // Verify person is a workspace member.
  if (!isWorkspaceMember(d, ann.workspace_id, personId)) {
    return res.status(403).json({ error: 'Only workspace members can acknowledge announcements' });
  }

  // Idempotent insert (INSERT OR IGNORE — if already acknowledged, that's fine).
  const ts = Date.now();
  const info = d.prepare(
    'INSERT OR IGNORE INTO announcement_acknowledgments (announcement_id, person_id, acknowledged_at) VALUES (?, ?, ?)',
  ).run(id, personId, ts);

  if (info.changes > 0) {
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ann.workspace_id,
      'announcement_acknowledged', 'announcement', id, personId,
      `Acknowledged by ${personId}`,
      ts,
    );
    bumpRevision();
    notifySSE(ann.workspace_id, { type: 'announcement', action: 'acknowledged', id, personId });
  }

  // Return updated acknowledgment count.
  const ackCount = d.prepare('SELECT COUNT(*) as c FROM announcement_acknowledgments WHERE announcement_id = ?').get(id);
  res.json({ acknowledged: true, acknowledgmentCount: ackCount?.c || 0, personId });
});

// ── Issue Resolution with Qualified Clearance ──────────────────────

/** PUT /api/issues/:id/resolve — resolve an issue with qualified clearance.
 *
 *  Records:
 *    - qualifiedVerifier (who provided clearance)
 *    - verificationEvidence (evidence reference)
 *    - verifiedAt (timestamp)
 *
 *  AI cannot independently resolve issues — this must be called by a human
 *  (manager or designated qualified person).
 */
app.put('/api/issues/:id/resolve', (req, res) => {
  const d = getDB();
  const { id } = req.params;
  const { qualifiedVerifier, verificationEvidence, resolvedBy } = req.body;

  const row = d.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'issue not found' });
  if (row.status === 'resolved') return res.status(400).json({ error: 'issue is already resolved' });

  if (!qualifiedVerifier) return res.status(400).json({ error: 'qualifiedVerifier is required' });
  if (!verificationEvidence) return res.status(400).json({ error: 'verificationEvidence is required' });

  const ts = Date.now();
  d.prepare(
    `UPDATE issues SET status = 'resolved', resolved_at = ?, qualified_verifier = ?, verification_evidence = ?, verified_at = ? WHERE id = ?`,
  ).run(ts, qualifiedVerifier, String(verificationEvidence).slice(0, 2000), ts, id);

  // Audit entry.
  d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, row.workspace_id,
    'issue_resolved', 'issue', id, resolvedBy || qualifiedVerifier,
    `Issue resolved. Qualified verifier: ${qualifiedVerifier}. Evidence: ${String(verificationEvidence).slice(0, 200)}`,
    ts,
  );

  bumpRevision();
  notifySSE(row.workspace_id, { type: 'issue', action: 'resolved', id });

  const updated = d.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  res.json(mapIssue(updated));
});

// ── Sync endpoint (for polling) ─────────────────────────────────────

/** GET /api/sync?workspace=X&revision=N — returns whether data changed since revision N. */
app.get('/api/sync', (req, res) => {
  const workspaceId = req.query.workspace;
  const clientRev = req.query.revision ? parseInt(req.query.revision, 10) : 0;
  const serverRev = currentRevision();
  res.json({
    workspaceId,
    changed: serverRev > clientRev,
    revision: serverRev,
  });
});

// ── Reset endpoint (for demo reset) ─────────────────────────────────

/** POST /api/reset — wipe and reseed the database. */
app.post('/api/reset', (_req, res) => {
  const d = getDB();
  d.exec(`
    DELETE FROM announcement_acknowledgments;
    DELETE FROM announcement_revisions;
    DELETE FROM announcements;
    DELETE FROM ai_feedback;
    DELETE FROM issue_message_links;
    DELETE FROM ai_jobs;
    DELETE FROM ai_analysis_log;
    DELETE FROM completion_claims;
    DELETE FROM ai_proposals;
    DELETE FROM audit_log;
    DELETE FROM handovers;
    DELETE FROM shifts;
    DELETE FROM rules;
    DELETE FROM issues;
    DELETE FROM tasks;
    DELETE FROM messages;
    DELETE FROM workspace_members;
    DELETE FROM workspaces;
  `);
  d.prepare("UPDATE meta SET value = '0' WHERE key = 'revision'").run();
  seedDatabase();
  // Notify all connected clients.
  for (const [wsId] of sseClients) {
    notifySSE(wsId, { type: 'reset' });
  }
  res.json({ ok: true, message: 'Database reset and reseeded.' });
});

// ── Health check ────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, revision: currentRevision() });
});

// ── Static frontend & SPA fallback (registered LAST so API routes win) ─
app.use(express.static(ROOT, {
  setHeaders: (res, path) => {
    res.setHeader('Content-Type', STATIC_TYPES[extname(path)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// SPA fallback: any non-file, non-API path returns index.html.
app.use((req, res) => {
  res.sendFile(join(ROOT, 'index.html'));
});

// ── Error handler (catches JSON parse errors, validation errors, etc.) ──
// Must be registered LAST (after all routes and middleware). Without this,
// a malformed JSON body (e.g., truncated request) crashes the process.
app.use((err, req, res, _next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON in request body', detail: err.message });
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// ── AI Provider Fast-Poll Loop ──────────────────────────────────────
//
// Checks for pending AI jobs every 30 seconds and processes them.
// This provides ~30s recovery latency instead of relying solely on
// the hourly automation. Combined with the instant setImmediate()
// trigger on new messages, this gives us:
//   • Instant attempt: setImmediate → processMessage (if CodeBuddy
//     serve is available, <10s; if not, job goes to pending)
//   • Fast recovery: 30s poll → processPending (catches any jobs
//     that couldn't be processed instantly)
//   • Hourly backup: automation → /api/tencent/retry-pending
const AI_POLL_INTERVAL_MS = 30_000; // 30 seconds
let aiPollRunning = false;

setInterval(async () => {
  if (aiPollRunning) return; // Prevent overlapping polls
  aiPollRunning = true;
  try {
    const d = getDB();
    const pendingCount = d.prepare(
      `SELECT COUNT(*) as count FROM ai_jobs WHERE status = 'pending' AND attempts < max_attempts`,
    ).get()?.count || 0;
    if (pendingCount > 0) {
      console.log(`[ai-poll] Found ${pendingCount} pending job(s), attempting recovery...`);
      const result = await dispatchProcessPending();
      if (result.processed > 0) {
        console.log(`[ai-poll] Processed ${result.processed} job(s), failed: ${result.failed || 0}`);
      }
    }
  } catch (err) {
    // Silent — don't crash the server on poll errors
    console.error('[ai-poll] Error:', err.message);
  } finally {
    aiPollRunning = false;
  }
}, AI_POLL_INTERVAL_MS);

// ── Start ───────────────────────────────────────────────────────────
const server = app.listen(PORT, HOST, () => {
  console.log(`\n  ShiftBridge backend running on http://${HOST}:${PORT}`);
  console.log(`  Local:    http://localhost:${PORT}`);
  // Show IPv4 addresses for phone access.
  try {
    const ifaces = networkInterfaces();
    const ipv4s = [];
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ipv4s.push(`${name}: http://${iface.address}:${PORT}`);
        }
      }
    }
    if (ipv4s.length) {
      console.log(`  Network:  ${ipv4s.join('\n            ')}`);
    }
  } catch { /* ignore */ }
  console.log(`\n  API:       http://${HOST}:${PORT}/api/workspaces`);
  console.log(`  SSE:       http://${HOST}:${PORT}/api/events?workspace=daily`);
  console.log(`  AI:        provider=${AI_PROVIDER}, poll=30s${AI_PROVIDER === 'tencent-local' ? ', CodeBuddy serve=' + (process.env.CODEBUDDY_SERVE_URL || 'http://127.0.0.1:8080') : ''}`);
  console.log('');
});

// Graceful shutdown.
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close();
  closeDB();
  process.exit(0);
});

export { app, server };
