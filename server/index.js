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
} from './db.js';
import { seedDatabase } from './seed.js';
import { ruleDefaults } from './rule-defaults.js';

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

/** GET /api/workspaces/:workspace/messages — list messages (optionally since a timestamp). */
app.get('/api/workspaces/:workspace/messages', validateWorkspace, (req, res) => {
  const d = getDB();
  const since = req.query.since ? parseInt(req.query.since, 10) : 0;
  const rows = d.prepare('SELECT * FROM messages WHERE workspace_id = ? AND created_at > ? ORDER BY created_at ASC').all(req.workspaceId, since);
  res.json({ messages: rows.map(mapMessage), revision: currentRevision() });
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

// ── Issues ──────────────────────────────────────────────────────────

/** GET /api/workspaces/:workspace/issues — list issues. */
app.get('/api/workspaces/:workspace/issues', validateWorkspace, (req, res) => {
  const d = getDB();
  const rows = d.prepare('SELECT * FROM issues WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json({ issues: rows.map(mapIssue), revision: currentRevision() });
});

/** GET /api/issues/:id — get a single issue. */
app.get('/api/issues/:id', (req, res) => {
  const d = getDB();
  const row = d.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'issue not found' });
  res.json(mapIssue(row));
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
  if (updates.status === 'resolved') updates.resolved_at = ts;

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

/** POST /api/workspaces/:workspace/proposals — create a new AI proposal. */
app.post('/api/workspaces/:workspace/proposals', validateWorkspace, (req, res) => {
  const {
    type, entityType = null, entityId = null, summary, evidence = [],
    reasoning = '', confidence = 'medium', proposedData = null,
  } = req.body;

  const validTypes = ['task_proposal', 'completion_review', 'refusal', 'chat_completion_claim'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'invalid proposal type' });
  const trimmedSummary = String(summary || '').trim();
  if (!trimmedSummary) return res.status(400).json({ error: 'summary is required' });

  const proposalId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = Date.now();
  const d = getDB();

  d.prepare(
    `INSERT INTO ai_proposals (id, workspace_id, type, entity_type, entity_id, summary, evidence, reasoning, confidence, status, proposed_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    proposalId, req.workspaceId, type, entityType, entityId,
    trimmedSummary.slice(0, 500),
    JSON.stringify(evidence),
    String(reasoning).slice(0, 4000),
    confidence,
    proposedData ? JSON.stringify(proposedData) : '',
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

  // For progress-only messages, the task status does NOT change.
  // The claim is recorded for audit purposes but the task remains as-is.
  if (claimType === 'progress') {
    const tx2 = d.transaction(() => {
      d.prepare(
        `INSERT OR IGNORE INTO completion_claims (id, workspace_id, task_id, message_id, reporting_employee, claim_text, claim_type, status, verification_applied, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'recorded', 'none', ?)`,
      ).run(claimId, ws, taskId, messageId, reportingEmployee, claimText, claimType, ts);

      d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'chat_progress_report', 'task', taskId, 'silent-ai',
        `Progress report from chat: ${reportingEmployee} reported "${claimText.slice(0, 100)}" (msg ${messageId}). Task status unchanged.`, ts,
      );
      bumpRevision();
    });
    tx2();

    notifySSE(ws, { type: 'proposal', action: 'created', id: claimId });

    const task2 = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    const claim2 = d.prepare('SELECT * FROM completion_claims WHERE id = ?').get(claimId);
    return res.status(201).json({
      message: 'Progress report recorded — task status unchanged',
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
      `INSERT INTO ai_proposals (id, workspace_id, type, entity_type, entity_id, summary, evidence, reasoning, confidence, status, proposed_data, created_at)
       VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      proposalId, ws, proposalType, taskId, proposalSummary,
      JSON.stringify(evidence), proposalReasoning, proposalConfidence,
      JSON.stringify({ claimId, taskId, messageId, reportingEmployee, finalTaskStatus, verificationApplied }),
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

  // Validate status enum.
  const validStatuses = ['success', 'partial', 'error', 'stalled'];
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
  console.log(`  SSE:       http://${HOST}:${PORT}/api/events?workspace=daily\n`);
});

// Graceful shutdown.
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close();
  closeDB();
  process.exit(0);
});

export { app, server };
