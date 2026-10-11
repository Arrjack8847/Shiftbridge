-- ShiftBridge: 20 existing + 2 new public tables (22 total).
-- Idempotent migration additions; intentionally preserves existing demo rows.
-- The existing shift state was keyed only by workspace; make it per-person.
ALTER TABLE public.sb_shifts DROP CONSTRAINT IF EXISTS sb_shifts_pkey;
ALTER TABLE public.sb_shifts ADD CONSTRAINT sb_shifts_pkey PRIMARY KEY (workspace_id, person_id);
ALTER TABLE public.sb_shifts
  ADD CONSTRAINT sb_shifts_member_fk FOREIGN KEY (workspace_id, person_id)
  REFERENCES public.sb_workspace_members(workspace_id, person_id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS public.sb_shift_sessions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  person_id text NOT NULL,
  clock_in_at bigint NOT NULL,
  clock_out_at bigint,
  created_at bigint NOT NULL,
  CONSTRAINT sb_shift_session_member_fk FOREIGN KEY (workspace_id, person_id)
    REFERENCES public.sb_workspace_members(workspace_id, person_id) ON DELETE CASCADE,
  CONSTRAINT sb_shift_session_time_valid CHECK (clock_out_at IS NULL OR clock_out_at >= clock_in_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS sb_shift_one_open
  ON public.sb_shift_sessions(workspace_id, person_id) WHERE clock_out_at IS NULL;
CREATE INDEX IF NOT EXISTS sb_shift_history
  ON public.sb_shift_sessions(workspace_id, person_id, clock_in_at DESC);

-- Existing active employees receive exactly one recovered open session.
INSERT INTO public.sb_shift_sessions(id, workspace_id, person_id, clock_in_at, clock_out_at, created_at)
SELECT 'legacy:' || s.workspace_id || ':' || s.person_id,
  s.workspace_id, s.person_id, s.since, NULL, s.since
FROM public.sb_shifts s
WHERE s.clocked_in = 1 AND s.since IS NOT NULL
ON CONFLICT DO NOTHING;

-- Composite FK prevents cross-workspace photo/message mixups.
CREATE UNIQUE INDEX IF NOT EXISTS sb_messages_ws_id ON public.sb_messages(workspace_id, id);
CREATE TABLE IF NOT EXISTS public.sb_message_attachments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  message_id text NOT NULL,
  uploaded_by text NOT NULL,
  storage_bucket text NOT NULL DEFAULT 'shiftbridge-chat',
  storage_path text NOT NULL UNIQUE,
  original_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  created_at bigint NOT NULL,
  CONSTRAINT sb_attachment_message_fk FOREIGN KEY (workspace_id, message_id)
    REFERENCES public.sb_messages(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT sb_attachment_member_fk FOREIGN KEY (workspace_id, uploaded_by)
    REFERENCES public.sb_workspace_members(workspace_id, person_id) ON DELETE CASCADE,
  CONSTRAINT sb_attachment_content_valid CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  CONSTRAINT sb_attachment_size_valid CHECK (size_bytes BETWEEN 1 AND 1300000)
);
CREATE INDEX IF NOT EXISTS sb_attachment_message_lookup
  ON public.sb_message_attachments(workspace_id, message_id);

-- API access is restricted to the trusted Render backend secret, not browser keys.
ALTER TABLE public.sb_shift_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sb_message_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_shift_sessions FROM anon, authenticated;
REVOKE ALL ON public.sb_message_attachments FROM anon, authenticated;
GRANT ALL ON public.sb_shift_sessions TO service_role;
GRANT ALL ON public.sb_message_attachments TO service_role;

-- Private bucket for image bytes; metadata lives in sb_message_attachments.
INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('shiftbridge-chat','shiftbridge-chat',false,1300000,
  ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;
