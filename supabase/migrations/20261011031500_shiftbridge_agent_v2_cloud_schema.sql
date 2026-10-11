-- Bring ShiftBridge Agent V2 incident memory + AI feedback to Supabase.
BEGIN;
ALTER TABLE public.sb_issues ADD COLUMN IF NOT EXISTS entity_key TEXT;
ALTER TABLE public.sb_issues ADD COLUMN IF NOT EXISTS last_activity_at BIGINT;
CREATE INDEX IF NOT EXISTS sb_idx_issues_entity_active
  ON public.sb_issues(workspace_id, entity_key, status);

CREATE TABLE IF NOT EXISTS public.sb_issue_message_links (
  workspace_id TEXT NOT NULL REFERENCES public.sb_workspaces(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES public.sb_issues(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES public.sb_messages(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'report',
  created_by TEXT NOT NULL,
  reasoning TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  PRIMARY KEY(workspace_id, message_id)
);
CREATE INDEX IF NOT EXISTS sb_idx_issue_links_timeline
  ON public.sb_issue_message_links(workspace_id, issue_id, created_at);

CREATE TABLE IF NOT EXISTS public.sb_ai_feedback (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.sb_workspaces(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES public.sb_issues(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES public.sb_messages(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  reviewer_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sb_idx_ai_feedback_workspace
  ON public.sb_ai_feedback(workspace_id, created_at);

ALTER TABLE public.sb_issue_message_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sb_ai_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_issue_message_links, public.sb_ai_feedback FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sb_issue_message_links, public.sb_ai_feedback TO service_role;
COMMIT;
