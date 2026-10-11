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
const DB_PATH = process.env.SHIFTBRIDGE_DB_PATH || resolve(__dirname, 'shiftbridge.db');

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

    -- AI Proposals: proposals created by the Silent AI agent (via MCP).
    -- The AI creates proposals for task creation, completion review, and
    -- protected-work refusals. Managers review these in the dashboard.
    CREATE TABLE IF NOT EXISTS ai_proposals (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      type          TEXT NOT NULL,
      entity_type   TEXT,
      entity_id     TEXT,
      summary       TEXT NOT NULL,
      evidence      TEXT DEFAULT '[]',
      reasoning     TEXT DEFAULT '',
      confidence    TEXT NOT NULL DEFAULT 'medium',
      status        TEXT NOT NULL DEFAULT 'pending',
      proposed_data TEXT DEFAULT '',
      reviewed_by   TEXT,
      reviewed_at   INTEGER,
      created_at    INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_proposals_ws ON ai_proposals(workspace_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_proposals_entity ON ai_proposals(entity_type, entity_id);

    -- Track chat-derived completion claims. Each row links a chat message
    -- to a task, recording who reported it, what verification policy was
    -- applied, and whether it was processed, rejected, or is pending review.
    -- The (task_id, message_id) pair is unique — prevents duplicate processing
    -- of the same chat message for the same task.
    CREATE TABLE IF NOT EXISTS completion_claims (
      id                  TEXT PRIMARY KEY,
      workspace_id        TEXT NOT NULL,
      task_id             TEXT NOT NULL,
      message_id          TEXT NOT NULL,
      reporting_employee  TEXT NOT NULL,
      claim_text          TEXT NOT NULL,
      claim_type          TEXT NOT NULL DEFAULT 'completion',
      status              TEXT NOT NULL DEFAULT 'processed',
      verification_applied TEXT NOT NULL DEFAULT 'self-report',
      created_at          INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_task_msg ON completion_claims(task_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_claims_ws ON completion_claims(workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_claims_task ON completion_claims(task_id);

    -- Phase 5: Silent AI analysis log. Each row records one scheduled
    -- analysis run: how many messages were examined, how many proposals
    -- and completion claims were created, and whether any errors occurred.
    -- The last_message_seq column doubles as a processing checkpoint —
    -- the automation reads the most recent row to know where it left off.
    CREATE TABLE IF NOT EXISTS ai_analysis_log (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      run_at          INTEGER NOT NULL,
      messages_total  INTEGER NOT NULL DEFAULT 0,
      messages_new    INTEGER NOT NULL DEFAULT 0,
      proposals_created     INTEGER NOT NULL DEFAULT 0,
      completion_claims     INTEGER NOT NULL DEFAULT 0,
      errors          TEXT DEFAULT '',
      last_message_seq INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'success',
      summary         TEXT DEFAULT '',
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ai_log_ws ON ai_analysis_log(workspace_id, run_at);
  `);

  // ── Phase 5.1 Migration: add source_message_id to ai_proposals ────
  // This column tracks which chat message a proposal was derived from,
  // enabling deduplication: the AI should not create duplicate proposals
  // for the same message + type + intent across repeated analysis runs.
  // The unique index enforces this at the database level as a backstop
  // to the application-level check in POST /api/.../proposals.
  {
    const cols = d.prepare("PRAGMA table_info(ai_proposals)").all();
    const hasSourceMsgId = cols.some((c) => c.name === 'source_message_id');
    if (!hasSourceMsgId) {
      d.exec('ALTER TABLE ai_proposals ADD COLUMN source_message_id TEXT');
    }
    // Unique index: prevents duplicate proposals from the same source
    // message with the same type and summary. Only applies when
    // source_message_id is not null (manual/legacy proposals are exempt).
    d.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_dedup
      ON ai_proposals(workspace_id, source_message_id, type, summary)
      WHERE source_message_id IS NOT NULL
    `);
  }

  // ── Phase 5.1 Migration: add processing_errors to ai_analysis_log ─
  // This column stores a JSON array of per-message processing errors,
  // serving as a quarantine record for failed messages. Each entry has
  // { messageId, seq, error, timestamp }. The checkpoint advances past
  // both successful and failed messages, so failed messages don't block
  // the queue — they're recorded for later review or retry.
  {
    const logCols = d.prepare("PRAGMA table_info(ai_analysis_log)").all();
    const hasProcessingErrors = logCols.some((c) => c.name === 'processing_errors');
    if (!hasProcessingErrors) {
      d.exec("ALTER TABLE ai_analysis_log ADD COLUMN processing_errors TEXT DEFAULT '[]'");
    }
  }

  // ── Phase 6: Announcements, Issues, and Direct Task Assignment ───

  // Announcements table: manager-published notices and AI-generated drafts.
  // status: 'draft' (unpublished, AI or manager created) → 'active' (published)
  //         → 'archived' (withdrawn/resolved).
  // type: 'general' | 'important' | 'safety'.
  // linked_issue_id: optional reference to an issues row when the announcement
  //   was created in response to a flagged issue (e.g., equipment warning).
  d.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      title           TEXT NOT NULL,
      body            TEXT NOT NULL,
      type            TEXT NOT NULL DEFAULT 'general',
      status          TEXT NOT NULL DEFAULT 'draft',
      publisher_id    TEXT,
      linked_issue_id TEXT,
      created_by      TEXT NOT NULL DEFAULT 'demo',
      created_at      INTEGER NOT NULL,
      published_at    INTEGER,
      archived_at     INTEGER,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_announcements_ws ON announcements(workspace_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_announcements_issue ON announcements(linked_issue_id);
  `);

  // Announcement revision history: every edit to a published announcement
  // is recorded here so safety instructions are never silently overwritten.
  d.exec(`
    CREATE TABLE IF NOT EXISTS announcement_revisions (
      id              TEXT PRIMARY KEY,
      announcement_id TEXT NOT NULL,
      old_title       TEXT,
      new_title       TEXT,
      old_body        TEXT,
      new_body        TEXT,
      editor_id       TEXT NOT NULL,
      edited_at       INTEGER NOT NULL,
      FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_ann ON announcement_revisions(announcement_id, edited_at);
  `);

  // Employee acknowledgments: one per employee per announcement.
  // The PRIMARY KEY enforces uniqueness — repeated acks are idempotent.
  d.exec(`
    CREATE TABLE IF NOT EXISTS announcement_acknowledgments (
      announcement_id TEXT NOT NULL,
      person_id       TEXT NOT NULL,
      acknowledged_at INTEGER NOT NULL,
      PRIMARY KEY (announcement_id, person_id),
      FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE
    );
  `);

  // ── Phase 6 Migration: extend issues table ─────────────────────
  // Add columns for employee-reported issues, linked announcements, and
  // qualified clearance tracking. The existing `source` column already
  // stores a message ID, so we reuse it for dedup rather than adding
  // a separate source_message_id column.
  {
    const issueCols = d.prepare("PRAGMA table_info(issues)").all();
    const has = (name) => issueCols.some((c) => c.name === name);

    if (!has('reporter_id')) d.exec("ALTER TABLE issues ADD COLUMN reporter_id TEXT");
    if (!has('linked_announcement_id')) d.exec("ALTER TABLE issues ADD COLUMN linked_announcement_id TEXT");
    if (!has('qualified_verifier')) d.exec("ALTER TABLE issues ADD COLUMN qualified_verifier TEXT");
    if (!has('verification_evidence')) d.exec("ALTER TABLE issues ADD COLUMN verification_evidence TEXT");
    if (!has('verified_at')) d.exec("ALTER TABLE issues ADD COLUMN verified_at INTEGER");
    if (!has('issue_type')) d.exec("ALTER TABLE issues ADD COLUMN issue_type TEXT DEFAULT 'general'");
  }

  // Unique index on issues: prevents duplicate issues from the same source
  // message within the same workspace. Allows issues without a source.
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_msg_dedup
    ON issues(workspace_id, source)
    WHERE source IS NOT NULL
  `);

  // ── Phase 6 Migration: task dedup for direct manager assignments ─
  // The existing `source` column on tasks already stores a message ID.
  // This unique index prevents duplicate tasks from the same source
  // message with the same name, while allowing multiple distinct tasks
  // from the same message (different names) and manual tasks (null source).
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_dedup
    ON tasks(workspace_id, source, name)
    WHERE source IS NOT NULL
  `);

  // ── Groq Integration: persistent AI job queue ────────────────────
  // Tracks each Groq API processing job for a message. Jobs that fail
  // (API down, parse error, etc.) remain in 'pending' or 'failed' status
  // for retry by the next message trigger or the hourly recovery automation.
  // Unique index on message_id prevents duplicate jobs for the same message.
  d.exec(`
    CREATE TABLE IF NOT EXISTS ai_jobs (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      message_id      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL DEFAULT 3,
      last_error      TEXT DEFAULT '',
      actions_json    TEXT DEFAULT '',
      latency_ms      INTEGER DEFAULT 0,
      model_used      TEXT DEFAULT '',
      tokens_used     INTEGER DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      completed_at    INTEGER,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON ai_jobs(status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_jobs_msg ON ai_jobs(message_id);
  `);

  // ── Agent V2 migrations: incident memory and manager feedback ──
  {
    const cols = d.prepare('PRAGMA table_info(issues)').all().map(c => c.name);
    if (!cols.includes('entity_key')) d.exec('ALTER TABLE issues ADD COLUMN entity_key TEXT');
    if (!cols.includes('last_activity_at')) d.exec('ALTER TABLE issues ADD COLUMN last_activity_at INTEGER');
  }
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_issues_entity_active
      ON issues(workspace_id, entity_key, status);
    CREATE TABLE IF NOT EXISTS issue_message_links (
      workspace_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'report',
      created_by TEXT NOT NULL,
      reasoning TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, message_id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE,
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_issue_links_timeline ON issue_message_links(workspace_id, issue_id, created_at);
    CREATE TABLE IF NOT EXISTS ai_feedback (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      reviewer_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE,
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_feedback_workspace ON ai_feedback(workspace_id, created_at);
    INSERT OR IGNORE INTO issue_message_links(workspace_id,issue_id,message_id,relation,created_by,reasoning,created_at)
      SELECT i.workspace_id,i.id,m.id,'report','migration','Original issue source',i.created_at
        FROM issues i JOIN messages m
          ON m.id=i.source AND m.workspace_id=i.workspace_id
       WHERE i.source IS NOT NULL;
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
    source: row.source || null,
    createdBy: row.created_by,
    reporterId: row.reporter_id || null,
    requiresApproval: row.requires_approval === 1,
    approved: row.approved === 1,
    evidence: row.evidence || '',
    resolvedAt: row.resolved_at,
    linkedAnnouncementId: row.linked_announcement_id || null,
    qualifiedVerifier: row.qualified_verifier || null,
    verificationEvidence: row.verification_evidence || null,
    verifiedAt: row.verified_at || null,
    issueType: row.issue_type || 'general',
    entityKey: row.entity_key || null,
    lastActivityAt: row.last_activity_at || row.created_at,
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

export function mapProposal(row) {
  if (!row) return null;
  let evidence = [];
  try { evidence = JSON.parse(row.evidence || '[]'); } catch { /* keep default */ }
  let proposedData = null;
  try { proposedData = row.proposed_data ? JSON.parse(row.proposed_data) : null; } catch { /* keep default */ }
  return {
    id: row.id,
    ws: row.workspace_id,
    type: row.type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    evidence,
    reasoning: row.reasoning || '',
    confidence: row.confidence,
    status: row.status,
    proposedData,
    sourceMessageId: row.source_message_id || null,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

export function mapCompletionClaim(row) {
  if (!row) return null;
  return {
    id: row.id,
    ws: row.workspace_id,
    taskId: row.task_id,
    messageId: row.message_id,
    reportingEmployee: row.reporting_employee,
    claimText: row.claim_text,
    claimType: row.claim_type,
    status: row.status,
    verificationApplied: row.verification_applied,
    createdAt: row.created_at,
  };
}

export function mapAIAnalysisLog(row) {
  if (!row) return null;
  let processingErrors = [];
  try { processingErrors = JSON.parse(row.processing_errors || '[]'); } catch { /* keep default */ }
  return {
    id: row.id,
    ws: row.workspace_id,
    runAt: row.run_at,
    messagesTotal: row.messages_total,
    messagesNew: row.messages_new,
    proposalsCreated: row.proposals_created,
    completionClaims: row.completion_claims,
    errors: row.errors || '',
    lastMessageSeq: row.last_message_seq,
    status: row.status,
    summary: row.summary || '',
    processingErrors,
    createdAt: row.created_at,
  };
}

// ── Phase 6 mappers ────────────────────────────────────────────────

export function mapAnnouncement(row) {
  if (!row) return null;
  return {
    id: row.id,
    ws: row.workspace_id,
    title: row.title,
    body: row.body,
    type: row.type,
    status: row.status,
    publisherId: row.publisher_id || null,
    linkedIssueId: row.linked_issue_id || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    publishedAt: row.published_at || null,
    archivedAt: row.archived_at || null,
  };
}

export function mapAnnouncementRevision(row) {
  if (!row) return null;
  return {
    id: row.id,
    announcementId: row.announcement_id,
    oldTitle: row.old_title || '',
    newTitle: row.new_title || '',
    oldBody: row.old_body || '',
    newBody: row.new_body || '',
    editorId: row.editor_id,
    editedAt: row.edited_at,
  };
}

export function mapIssueExtended(row) {
  if (!row) return null;
  return {
    id: row.id,
    ws: row.workspace_id,
    title: row.title,
    description: row.description || '',
    severity: row.severity,
    status: row.status,
    source: row.source || null,
    createdBy: row.created_by,
    reporterId: row.reporter_id || null,
    requiresApproval: row.requires_approval === 1,
    approved: row.approved === 1,
    evidence: row.evidence || '',
    resolvedAt: row.resolved_at,
    linkedAnnouncementId: row.linked_announcement_id || null,
    qualifiedVerifier: row.qualified_verifier || null,
    verificationEvidence: row.verification_evidence || null,
    verifiedAt: row.verified_at || null,
    issueType: row.issue_type || 'general',
    createdAt: row.created_at,
  };
}
