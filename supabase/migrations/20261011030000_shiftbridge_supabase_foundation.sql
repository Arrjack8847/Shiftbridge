-- ShiftBridge Supabase foundation. Restricted to trusted backend access.
BEGIN;
CREATE TABLE IF NOT EXISTS public.sb_workspaces (

      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'Other business',
      zone          TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
      invite        TEXT,
      created_at    BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS public.sb_workspace_members (

      workspace_id  TEXT NOT NULL,
      person_id     TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'employee',
      PRIMARY KEY (workspace_id, person_id),
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_messages (

      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      body          TEXT NOT NULL,
      created_at    BIGINT NOT NULL,
      seq           BIGINT,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_tasks (

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
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_issues (

      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT DEFAULT '',
      severity        TEXT NOT NULL DEFAULT 'normal',
      status          TEXT NOT NULL DEFAULT 'open',
      source          TEXT,
      created_by      TEXT NOT NULL DEFAULT 'demo',
      requires_approval BIGINT NOT NULL DEFAULT 0,
      approved        BIGINT NOT NULL DEFAULT 0,
      evidence        TEXT DEFAULT '',
      resolved_at     BIGINT,
      created_at      BIGINT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_rules (

      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      name          TEXT NOT NULL,
      note          TEXT DEFAULT '',
      allowed       BIGINT NOT NULL DEFAULT 0,
      locked        BIGINT NOT NULL DEFAULT 0,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_audit_log (

      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      action        TEXT NOT NULL,
      entity_type  TEXT,
      entity_id    TEXT,
      actor        TEXT,
      details      TEXT DEFAULT '',
      created_at    BIGINT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_shifts (

      workspace_id  TEXT PRIMARY KEY,
      person_id    TEXT NOT NULL,
      clocked_in   BIGINT NOT NULL DEFAULT 0,
      since         BIGINT,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_handovers (

      workspace_id  TEXT PRIMARY KEY,
      finished      TEXT DEFAULT '',
      problems      TEXT DEFAULT '',
      stock         TEXT DEFAULT '',
      next          TEXT DEFAULT '',
      unfinished    TEXT DEFAULT '',
      saved         BIGINT,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_meta (

      key   TEXT PRIMARY KEY,
      value TEXT
);
CREATE TABLE IF NOT EXISTS public.sb_ai_proposals (

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
      reviewed_at   BIGINT,
      created_at    BIGINT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_completion_claims (

      id                  TEXT PRIMARY KEY,
      workspace_id        TEXT NOT NULL,
      task_id             TEXT NOT NULL,
      message_id          TEXT NOT NULL,
      reporting_employee  TEXT NOT NULL,
      claim_text          TEXT NOT NULL,
      claim_type          TEXT NOT NULL DEFAULT 'completion',
      status              TEXT NOT NULL DEFAULT 'processed',
      verification_applied TEXT NOT NULL DEFAULT 'self-report',
      created_at          BIGINT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_ai_analysis_log (

      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      run_at          BIGINT NOT NULL,
      messages_total  BIGINT NOT NULL DEFAULT 0,
      messages_new    BIGINT NOT NULL DEFAULT 0,
      proposals_created     BIGINT NOT NULL DEFAULT 0,
      completion_claims     BIGINT NOT NULL DEFAULT 0,
      errors          TEXT DEFAULT '',
      last_message_seq BIGINT NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'success',
      summary         TEXT DEFAULT '',
      created_at      BIGINT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_announcements (

      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      title           TEXT NOT NULL,
      body            TEXT NOT NULL,
      type            TEXT NOT NULL DEFAULT 'general',
      status          TEXT NOT NULL DEFAULT 'draft',
      publisher_id    TEXT,
      linked_issue_id TEXT,
      created_by      TEXT NOT NULL DEFAULT 'demo',
      created_at      BIGINT NOT NULL,
      published_at    BIGINT,
      archived_at     BIGINT,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_announcement_revisions (

      id              TEXT PRIMARY KEY,
      announcement_id TEXT NOT NULL,
      old_title       TEXT,
      new_title       TEXT,
      old_body        TEXT,
      new_body        TEXT,
      editor_id       TEXT NOT NULL,
      edited_at       BIGINT NOT NULL,
      FOREIGN KEY (announcement_id) REFERENCES public.sb_announcements(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_announcement_acknowledgments (

      announcement_id TEXT NOT NULL,
      person_id       TEXT NOT NULL,
      acknowledged_at BIGINT NOT NULL,
      PRIMARY KEY (announcement_id, person_id),
      FOREIGN KEY (announcement_id) REFERENCES public.sb_announcements(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.sb_ai_jobs (

      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      message_id      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      attempts        BIGINT NOT NULL DEFAULT 0,
      max_attempts    BIGINT NOT NULL DEFAULT 3,
      last_error      TEXT DEFAULT '',
      actions_json    TEXT DEFAULT '',
      latency_ms      BIGINT DEFAULT 0,
      model_used      TEXT DEFAULT '',
      tokens_used     BIGINT DEFAULT 0,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL,
      completed_at    BIGINT,
      FOREIGN KEY (workspace_id) REFERENCES public.sb_workspaces(id) ON DELETE CASCADE
);
ALTER TABLE public.sb_ai_proposals ADD COLUMN IF NOT EXISTS source_message_id TEXT;
ALTER TABLE public.sb_ai_analysis_log ADD COLUMN IF NOT EXISTS processing_errors TEXT DEFAULT '[]';
ALTER TABLE public.sb_issues ADD COLUMN IF NOT EXISTS reporter_id TEXT;
ALTER TABLE public.sb_issues ADD COLUMN IF NOT EXISTS linked_announcement_id TEXT;
ALTER TABLE public.sb_issues ADD COLUMN IF NOT EXISTS qualified_verifier TEXT;
ALTER TABLE public.sb_issues ADD COLUMN IF NOT EXISTS verification_evidence TEXT;
ALTER TABLE public.sb_issues ADD COLUMN IF NOT EXISTS verified_at BIGINT;
ALTER TABLE public.sb_issues ADD COLUMN IF NOT EXISTS issue_type TEXT DEFAULT 'general';
CREATE INDEX IF NOT EXISTS sb_idx_messages_ws_time ON public.sb_messages(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS sb_idx_messages_seq ON public.sb_messages(workspace_id, seq);
CREATE INDEX IF NOT EXISTS sb_idx_tasks_ws ON public.sb_tasks(workspace_id);
CREATE INDEX IF NOT EXISTS sb_idx_issues_ws ON public.sb_issues(workspace_id);
CREATE INDEX IF NOT EXISTS sb_idx_rules_ws ON public.sb_rules(workspace_id);
CREATE INDEX IF NOT EXISTS sb_idx_audit_ws ON public.sb_audit_log(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS sb_idx_proposals_ws ON public.sb_ai_proposals(workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS sb_idx_proposals_entity ON public.sb_ai_proposals(entity_type, entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS sb_idx_claims_task_msg ON public.sb_completion_claims(task_id, message_id);
CREATE INDEX IF NOT EXISTS sb_idx_claims_ws ON public.sb_completion_claims(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS sb_idx_claims_task ON public.sb_completion_claims(task_id);
CREATE INDEX IF NOT EXISTS sb_idx_ai_log_ws ON public.sb_ai_analysis_log(workspace_id, run_at);
CREATE INDEX IF NOT EXISTS sb_idx_announcements_ws ON public.sb_announcements(workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS sb_idx_announcements_issue ON public.sb_announcements(linked_issue_id);
CREATE INDEX IF NOT EXISTS sb_idx_revisions_ann ON public.sb_announcement_revisions(announcement_id, edited_at);
CREATE INDEX IF NOT EXISTS sb_idx_ai_jobs_status ON public.sb_ai_jobs(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS sb_idx_ai_jobs_msg ON public.sb_ai_jobs(message_id);
ALTER TABLE public.sb_workspaces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_workspaces FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_workspaces TO service_role;
ALTER TABLE public.sb_workspace_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_workspace_members FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_workspace_members TO service_role;
ALTER TABLE public.sb_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_messages TO service_role;
ALTER TABLE public.sb_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_tasks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_tasks TO service_role;
ALTER TABLE public.sb_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_issues FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_issues TO service_role;
ALTER TABLE public.sb_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_rules FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_rules TO service_role;
ALTER TABLE public.sb_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_audit_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_audit_log TO service_role;
ALTER TABLE public.sb_shifts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_shifts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_shifts TO service_role;
ALTER TABLE public.sb_handovers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_handovers FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_handovers TO service_role;
ALTER TABLE public.sb_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_meta FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_meta TO service_role;
ALTER TABLE public.sb_ai_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_ai_proposals FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_ai_proposals TO service_role;
ALTER TABLE public.sb_completion_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_completion_claims FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_completion_claims TO service_role;
ALTER TABLE public.sb_ai_analysis_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_ai_analysis_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_ai_analysis_log TO service_role;
ALTER TABLE public.sb_announcements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_announcements FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_announcements TO service_role;
ALTER TABLE public.sb_announcement_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_announcement_revisions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_announcement_revisions TO service_role;
ALTER TABLE public.sb_announcement_acknowledgments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_announcement_acknowledgments FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_announcement_acknowledgments TO service_role;
ALTER TABLE public.sb_ai_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_ai_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_ai_jobs TO service_role;
COMMIT;
