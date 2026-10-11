/**
 * src/api.js — API client for ShiftBridge backend.
 *
 * All functions return Promises. Uses relative /api endpoints so the
 * frontend works from any host (localhost or laptop IP on the LAN).
 *
 * No authentication — this is a hackathon demo. Demo identity is passed
 * as `userId` in request bodies or query params.
 */

const BASE = '/api';

/** Generic fetch wrapper with JSON handling. */
async function request(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  if (!res.ok) {
    if (res.status === 404 && !(res.headers.get('content-type') || '').includes('json')) {
      throw new Error('API route returned 404. Check Vercel proxy deployment and Render backend URL');
    }
    throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`);
  }
  return json;
}

const api = {
  // ── People ────────────────────────────────────────────────────────
  getPeople: () => request('GET', '/people'),
  getAttachments: (ws) => request('GET', `/workspaces/${encodeURIComponent(ws)}/attachments`),
  attachmentSrc: (ws, id) => `/api/workspaces/${encodeURIComponent(ws)}/attachments/${encodeURIComponent(id)}/content`,
  uploadMessageAttachment: async (ws, msgId, file, userId) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > 1300000) throw new Error('Photos must be no larger than 1.3 MB');
    let binary = '';
    for (let n = 0; n < bytes.length; n += 8192) binary += String.fromCharCode(...bytes.subarray(n, n + 8192));
    return request('POST', `/workspaces/${encodeURIComponent(ws)}/messages/${encodeURIComponent(msgId)}/attachments`, {
      userId, originalName: file.name, contentType: file.type, data: btoa(binary),
    });
  },

  // ── Workspaces ─────────────────────────────────────────────────────
  getWorkspaces: () => request('GET', '/workspaces'),
  createWorkspace: (data) => request('POST', '/workspaces', data),
  updateWorkspace: (id, data) => request('PUT', `/workspaces/${id}`, data),

  // ── Messages ──────────────────────────────────────────────────────
  getMessages: (ws, since = 0) => request('GET', `/workspaces/${ws}/messages?since=${since}${since ? '' : '&latest=1'}`),
  sendMessage: (ws, { id, user, body }) =>
    request('POST', `/workspaces/${ws}/messages`, { id, user, body }),

  // ── Tasks ─────────────────────────────────────────────────────────
  getTasks: (ws) => request('GET', `/workspaces/${ws}/tasks`),
  getTask: (id) => request('GET', `/tasks/${id}`),
  createTask: (ws, data) => request('POST', `/workspaces/${ws}/tasks`, data),
  updateTask: (id, data) => request('PUT', `/tasks/${id}`, data),

  // ── Issues ────────────────────────────────────────────────────────
  getIssues: (ws) => request('GET', `/workspaces/${ws}/issues`),
  getIssue: (id) => request('GET', `/issues/${id}`),
  getIncidentContext: (ws) => request('GET', `/workspaces/${ws}/incident-context`),
  linkIncidentMessage: (ws, issueId, body) => request('POST', `/workspaces/${ws}/incidents/${issueId}/link-message`, body),
  getAgentFeedback: (ws, reviewerId) => request('GET', `/workspaces/${ws}/agent-feedback?reviewerId=${encodeURIComponent(reviewerId)}`),
  submitAgentFeedback: (ws, body) => request('POST', `/workspaces/${ws}/agent-feedback`, body),
  updateIssue: (id, data) => request('PUT', `/issues/${id}`, data),

  // ── Rules ─────────────────────────────────────────────────────────
  updateRule: (id, allowed) => request('PUT', `/rules/${id}`, { allowed }),

  // ── Shifts ────────────────────────────────────────────────────────
  getShift: (ws, personId) => request('GET', `/workspaces/${encodeURIComponent(ws)}/shift?personId=${encodeURIComponent(personId)}`),
  getShiftHistory: (ws, personId) => request('GET', `/workspaces/${encodeURIComponent(ws)}/shift-sessions?personId=${encodeURIComponent(personId)}`),
  toggleShift: (ws, personId) => request('PUT', `/workspaces/${ws}/shift`, { personId }),

  // ── Handovers ─────────────────────────────────────────────────────
  getHandover: (ws) => request('GET', `/workspaces/${ws}/handover`),
  saveHandover: (ws, data) => request('PUT', `/workspaces/${ws}/handover`, data),

  // ── Audit log ─────────────────────────────────────────────────────
  getAudit: (ws, since = 0) => request('GET', `/workspaces/${ws}/audit?since=${since}`),

  // ── AI Proposals (Silent AI agent) ─────────────────────────────────
  getProposals: (ws, status = '') => {
    const q = status ? `?status=${status}` : '';
    return request('GET', `/workspaces/${ws}/proposals${q}`);
  },
  getProposal: (id) => request('GET', `/proposals/${id}`),
  createProposal: (ws, data) => request('POST', `/workspaces/${ws}/proposals`, data),
  reviewProposal: (id, data) => request('PUT', `/proposals/${id}/review`, data),

  // ── Sync ──────────────────────────────────────────────────────────
  sync: (ws, revision = 0) => request('GET', `/sync?workspace=${ws}&revision=${revision}`),
  health: () => request('GET', '/health'),

  // ── Reset ─────────────────────────────────────────────────────────
  reset: () => request('POST', '/reset'),

  // ── Chat-Derived Completion Claims (Phase 4) ──────────────────────
  processChatCompletion: (ws, data) => request('POST', `/workspaces/${ws}/chat-completion`, data),
  getCompletionClaims: (ws) => request('GET', `/workspaces/${ws}/completion-claims`),
  getTaskCompletionClaims: (taskId) => request('GET', `/tasks/${taskId}/completion-claims`),

  // ── Silent AI Analysis Monitoring (Phase 5) ────────────────────────
  getAIStatus: (ws) => request('GET', `/workspaces/${ws}/ai-status`),
  getGroqStatus: (ws) => request('GET', `/workspaces/${ws}/groq-status`),
  logAIAnalysis: (ws, data) => request('POST', `/workspaces/${ws}/ai-log`, data),

  // ── Phase 6: Manager-direct task, issue flagging, announcements ──
  createManagerTask: (ws, data) => request('POST', `/workspaces/${ws}/manager-task`, data),
  reportIssue: (ws, data) => request('POST', `/workspaces/${ws}/report-issue`, data),
  getAnnouncements: (ws) => request('GET', `/workspaces/${ws}/announcements`),
  getActiveAnnouncements: (ws) => request('GET', `/workspaces/${ws}/announcements/active`),
  getAnnouncement: (id) => request('GET', `/announcements/${id}`),
  createAnnouncement: (ws, data) => request('POST', `/workspaces/${ws}/announcements`, data),
  updateAnnouncement: (id, data) => request('PUT', `/announcements/${id}`, data),
  archiveAnnouncement: (id) => request('PUT', `/announcements/${id}/archive`),
  acknowledgeAnnouncement: (id) => request('POST', `/announcements/${id}/acknowledge`),
  resolveIssue: (id, data) => request('PUT', `/issues/${id}/resolve`, data),

  // ── SSE ───────────────────────────────────────────────────────────
  /**
   * Open an SSE connection for a workspace. Calls onEvent(payload) for each update.
   * Returns a cleanup function to close the connection.
   */
  openEvents(workspaceId, onEvent) {
    const es = new EventSource(`${BASE}/events?workspace=${encodeURIComponent(workspaceId)}`);
    es.addEventListener('update', (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* ignore parse errors */ }
    });
    es.onerror = () => { /* SSE auto-reconnects; ignore transient errors */ };
    return () => es.close();
  },
};

export { api };
