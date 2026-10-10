/**
 * server/db.js — SQLite database setup, schema, and query helpers.
 *
 * Uses better-sqlite3 (synchronous, fast, zero-config).
 * The database file lives at server/shiftbridge.db.
 * On first run the schema is created and seed data is inserted.
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, 'shiftbridge.db');

/** @type {Database.Database} */
let db;

export function getDB() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function closeDB() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Create all tables if they don't exist.
 * Every shared entity is workspace-scoped (workspace_id FK) to enforce isolation.
 */
export function initSchema() {
  const d = getDB();

  d.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'Other business',
      zone          TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
      invite        TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id  TEXT NOT NULL,
      person_id     TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'employee',
      PRIMARY KEY (workspace_id, person_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      body          TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      seq           INTEGER,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_ws_time ON messages(workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(workspace_id, seq);

    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT DEFAULT '',
      assignee      TEXT,
      status        TEXT NOT NULL DEFAULT 'todo',
      priority      TEXT NOT NULL DEFAULT 'normal',
      category      TEXT NOT NULL DEFAULT 'routine',
      due           TEXT,
      source        TEXT,
      created_by    TEXT NOT NULL DEFAULT 'demo',
      verification  TEXT NOT NULL DEFAULT 'self-report',
      completion    TEXT DEFAULT '',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_ws ON tasks(workspace_id);

    CREATE TABLE IF NOT EXISTS issues (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT DEFAULT '',
      severity        TEXT NOT NULL DEFAULT 'normal',
      status          TEXT NOT NULL DEFAULT 'open',
      source          TEXT,
      created_by      TEXT NOT NULL DEFAULT 'demo',
      requires_approval INTEGER NOT NULL DEFAULT 0,
      approved        INTEGER NOT NULL DEFAULT 0,
      evidence        TEXT DEFAULT '',
      resolved_at     INTEGER,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_issues_ws ON issues(workspace_id);

    CREATE TABLE IF NOT EXISTS rules (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      name          TEXT NOT NULL,
      note          TEXT DEFAULT '',
      allowed       INTEGER NOT NULL DEFAULT 0,
      locked        INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_rules_ws ON rules(workspace_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      action        TEXT NOT NULL,
      entity_type  TEXT,
      entity_id    TEXT,
      actor        TEXT,
      details      TEXT DEFAULT '',
      created_at    INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_log(workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS shifts (
      workspace_id  TEXT PRIMARY KEY,
      person_id    TEXT NOT NULL,
      clocked_in   INTEGER NOT NULL DEFAULT 0,
      since         INTEGER,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS handovers (
      workspace_id  TEXT PRIMARY KEY,
      finished      TEXT DEFAULT '',
      problems      TEXT DEFAULT '',
      stock         TEXT DEFAULT '',
      next          TEXT DEFAULT '',
      unfinished    TEXT DEFAULT '',
      saved         INTEGER,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    -- Track the global revision counter for sync/polling.
    -- Incremented on every write so clients can poll "what changed since revision N".
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Initialize revision counter if not present.
  const row = d.prepare('SELECT value FROM meta WHERE key = ?').get('revision');
  if (!row) {
    d.prepare("INSERT INTO meta (key, value) VALUES ('revision', '0')").run();
  }
}

// ── Revision / sync helpers ──────────────────────────────────────────

/** Atomically increment and return the next revision number. */
export function bumpRevision() {
  const d = getDB();
  d.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'").run();
  return currentRevision();
}

export function currentRevision() {
  const d = getDB();
  const row = d.prepare("SELECT value FROM meta WHERE key = 'revision'").get();
  return row ? parseInt(row.value, 10) : 0;
}

// ── Row mappers ──────────────────────────────────────────────────────

export function mapWorkspace(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    zone: row.zone,
    invite: row.invite,
    members: [],
    rules: [],
  };
}

export function mapMessage(row) {
  return {
    id: row.id,
    ws: row.workspace_id,
    user: row.user_id,
    body: row.body,
    at: row.created_at,
    seq: row.seq,
  };
}

export function mapTask(row) {
  return {
    id: row.id,
    ws: row.workspace_id,
    name: row.name,
    description: row.description || '',
    assignee: row.assignee,
    status: row.status,
    priority: row.priority,
    category: row.category,
    due: row.due || 'Today',
    source: row.source,
    createdBy: row.created_by,
    verification: row.verification,
    completion: row.completion || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapIssue(row) {
  return {
    id: row.id,
    ws: row.workspace_id,
    title: row.title,
    description: row.description || '',
    severity: row.severity,
    status: row.status,
    source: row.source,
    createdBy: row.created_by,
    requiresApproval: row.requires_approval === 1,
    approved: row.approved === 1,
    evidence: row.evidence || '',
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

export function mapRule(row) {
  return {
    id: row.id,
    name: row.name,
    note: row.note || '',
    allowed: row.allowed === 1,
    locked: row.locked === 1,
  };
}

export function mapAudit(row) {
  return {
    id: row.id,
    ws: row.workspace_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actor: row.actor,
    details: row.details || '',
    createdAt: row.created_at,
  };
}
