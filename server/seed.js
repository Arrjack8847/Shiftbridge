/**
 * server/seed.js — Seeds the database with initial demo data.
 *
 * Mirrors the initialState() from the original data.js so that the
 * existing frontend can render identically after the backend switch.
 *
 * Run with:  node server/seed.js   (or automatically on first server start)
 */

import { getDB, initSchema, bumpRevision, closeDB } from './db.js';
import { ruleDefaults } from './rule-defaults.js';

const now = Date.now();

function safeID(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function seedWorkspaces(d) {
  // Check if already seeded.
  const existing = d.prepare('SELECT COUNT(*) as c FROM workspaces').get();
  if (existing.c > 0) {
    console.log('[seed] Database already has data — skipping seed.');
    return false;
  }

  console.log('[seed] Seeding initial demo data...');

  // ── Workspace: Daily Brew Café ──────────────────────────────────
  const dailyMembers = ['jack', 'emma', 'sarah', 'manager', 'liam'];
  d.prepare(
    `INSERT INTO workspaces (id, name, type, zone, invite, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('daily', 'Daily Brew Café', 'Café / Restaurant', 'Asia/Kuala_Lumpur', 'K7PX-42MA', now);

  const memberStmt = d.prepare(
    `INSERT OR IGNORE INTO workspace_members (workspace_id, person_id, role) VALUES (?, ?, ?)`,
  );
  for (const pid of dailyMembers) {
    memberStmt.run('daily', pid, pid === 'manager' ? 'admin' : 'employee');
  }

  // Seed rules for Daily Brew.
  const ruleStmt = d.prepare(
    `INSERT OR IGNORE INTO rules (id, workspace_id, name, note, allowed, locked) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const r of ruleDefaults) {
    ruleStmt.run(r.id, 'daily', r.name, r.note, r.allowed ? 1 : 0, r.locked ? 1 : 0);
  }

  // Seed shift for Daily Brew (Jack clocked in).
  d.prepare(
    `INSERT OR IGNORE INTO shifts (workspace_id, person_id, clocked_in, since) VALUES (?, ?, ?, ?)`,
  ).run('daily', 'jack', 1, now - 85 * 60000);

  // ── Workspace: Riverside Bakery ─────────────────────────────────
  const riversideMembers = ['jack', 'sarah', 'manager'];
  d.prepare(
    `INSERT INTO workspaces (id, name, type, zone, invite, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('riverside', 'Riverside Bakery', 'Bakery', 'Asia/Kuala_Lumpur', 'RB4K-8M2Z', now);

  for (const pid of riversideMembers) {
    memberStmt.run('riverside', pid, pid === 'manager' ? 'admin' : 'employee');
  }
  for (const r of ruleDefaults) {
    ruleStmt.run(`${r.id}_rb`, 'riverside', r.name, r.note, r.allowed ? 1 : 0, r.locked ? 1 : 0);
  }
  d.prepare(
    `INSERT OR IGNORE INTO shifts (workspace_id, person_id, clocked_in, since) VALUES (?, ?, ?, ?)`,
  ).run('riverside', 'jack', 0, null);

  // ── Messages ────────────────────────────────────────────────────
  const msgStmt = d.prepare(
    `INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const messages = [
    { id: 'm1', ws: 'daily', user: 'emma', body: 'Machine 2 is leaking again. Please don\u2019t use it until someone checks.', at: now - 36 * 60000 },
    { id: 'm2', ws: 'daily', user: 'sarah', body: 'We may be running low on oat milk.', at: now - 33 * 60000 },
    { id: 'm3', ws: 'daily', user: 'manager', body: 'Could someone check the storage room before opening?', at: now - 29 * 60000 },
    { id: 'm4', ws: 'daily', user: 'jack', body: "I'll check the oat milk stock now.", at: now - 26 * 60000 },
    { id: 'm5', ws: 'daily', user: 'jack', body: 'Checked storage. Four cartons are left.', at: now - 15 * 60000 },
    { id: 'm6', ws: 'riverside', user: 'sarah', body: 'Bread trays have arrived for the morning bake.', at: now - 25 * 60000 },
    { id: 'm7', ws: 'riverside', user: 'jack', body: 'Great. I\u2019ll prepare the display counter.', at: now - 12 * 60000 },
  ];
  let seq = 0;
  for (const m of messages) {
    msgStmt.run(m.id, m.ws, m.user, m.body, m.at, ++seq);
  }

  // ── Tasks ────────────────────────────────────────────────────────
  const taskStmt = d.prepare(
    `INSERT OR IGNORE INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tasks = [
    { id: 't1', ws: 'daily', name: 'Check oat milk stock', description: 'Check storage and record the remaining number of cartons.', assignee: 'jack', status: 'todo', priority: 'high', category: 'inventory', due: '10:00 AM', source: 'm3', createdBy: 'demo', verification: 'self-report', completion: '' },
    { id: 't2', ws: 'daily', name: 'Prepare serving counter', description: 'Arrange the clean cups and prepare the serving counter for opening.', assignee: 'jack', status: 'todo', priority: 'normal', category: 'opening', due: '9:00 AM', source: null, createdBy: 'demo', verification: 'self-report', completion: '' },
    { id: 't3', ws: 'daily', name: 'Clean kitchen surfaces', description: 'Wipe down food-preparation surfaces.', assignee: 'jack', status: 'done', priority: 'normal', category: 'cleaning', due: '8:30 AM', source: null, createdBy: 'demo', verification: 'self-report', completion: 'Self-reported done' },
    { id: 't4', ws: 'daily', name: 'Check paper cup delivery', description: 'Confirm quantity against the delivery note.', assignee: 'emma', status: 'doing', priority: 'normal', category: 'inventory', due: '11:00 AM', source: null, createdBy: 'demo', verification: 'self-report', completion: '' },
    { id: 't5', ws: 'daily', name: 'Inspect machine 2', description: 'Qualified technician inspection required before reuse.', assignee: null, status: 'review', priority: 'high', category: 'repairs', due: 'Today', source: 'm1', createdBy: 'demo', verification: 'qualified', completion: '' },
    { id: 't6', ws: 'riverside', name: 'Prepare bakery display', description: 'Arrange morning bakery products for display.', assignee: 'jack', status: 'todo', priority: 'normal', category: 'opening', due: '9:30 AM', source: 'm7', createdBy: 'demo', verification: 'self-report', completion: '' },
  ];
  for (const t of tasks) {
    taskStmt.run(t.id, t.ws, t.name, t.description, t.assignee, t.status, t.priority, t.category, t.due, t.source, t.createdBy, t.verification, t.completion, now, now);
  }

  // ── Issues ───────────────────────────────────────────────────────
  d.prepare(
    `INSERT OR IGNORE INTO issues (id, workspace_id, title, description, severity, status, source, created_by, requires_approval, approved, evidence, resolved_at, created_at, entity_key, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'i1', 'daily', 'Machine 2 is leaking',
    'Reported repeatedly. Inspection and safe-to-use sign-off are required.',
    'high', 'open', 'm1', 'demo', 1, 0, '', null, now, 'machine-2', now,
  );

  bumpRevision();
  console.log('[seed] Seed complete. 2 workspaces, 7 messages, 6 tasks, 1 issue.');
  return true;
}

// ── Main ──────────────────────────────────────────────────────────
export function seedDatabase() {
  const d = getDB();
  initSchema();
  seedWorkspaces(d);
  bumpRevision();
}

// Allow running directly:  node server/seed.js
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  try {
    seedDatabase();
  } catch (err) {
    console.error('[seed] Error:', err);
    process.exit(1);
  } finally {
    closeDB();
  }
}
