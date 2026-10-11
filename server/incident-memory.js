/**
 * Agent V2: workspace-scoped incident memory.
 * Linked messages represent unverified reports/updates, not proof of repairs.
 */
export const ACTIVE_ISSUE_STATUSES = ['open','reported','acknowledged','in_progress','review'];
export const isActiveIssue = status => ACTIVE_ISSUE_STATUSES.includes(status);

export function normalizeEntityKey(input) {
  const text = String(input || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const numbered = text.match(/\b(machine|printer|fridge|freezer|oven|terminal|register|pump|aircon|coffee machine|espresso machine)\s*(?:#|no\.?\s*)?(\d{1,3})\b/i);
  if (numbered) return numbered[1].replace(/\s+/g, '-') + '-' + numbered[2];
  const named = [
    [/\b(?:pos|card terminal|payment terminal|card machine)\b/, 'payment-terminal'],
    [/\b(?:coffee machine|espresso machine)\b/, 'coffee-machine'],
    [/\b(?:fridge|refrigerator)\b/, 'fridge'],
    [/\bfreezer\b/, 'freezer'], [/\bprinter\b/, 'printer'],
    [/\b(?:aircon|air conditioner|a\/c)\b/, 'air-conditioner'],
    [/\b(?:wifi|wi-fi|internet connection)\b/, 'network'],
    [/\boven\b/, 'oven'], [/\bwater supply\b/, 'water-supply'], [/\bsink\b/, 'sink'],
  ];
  for (const [pattern, key] of named) if (pattern.test(text)) return key;
  return null; // "it" and unnamed equipment must go through contextual AI.
}

export function findMatchingOpenIssue(db, workspaceId, key) {
  if (!key) return null;
  return db.prepare("SELECT * FROM issues WHERE workspace_id = ? AND entity_key = ? AND status IN ('open','reported','acknowledged','in_progress','review') ORDER BY COALESCE(last_activity_at,created_at) DESC LIMIT 1")
    .get(workspaceId, key) || null;
}

export function linkMessageToIssue(db, {workspaceId,issueId,messageId,relation='update',actor='silent-ai',reason=''}) {
  if (!['report','update','evidence','completion_claim','inspection_scheduled'].includes(relation)) {
    return {ok:false,status:400,error:'Unsupported relation'};
  }
  const issue = db.prepare('SELECT id,status FROM issues WHERE id = ? AND workspace_id = ?').get(issueId,workspaceId);
  const msg = db.prepare('SELECT id,user_id,body FROM messages WHERE id = ? AND workspace_id = ?').get(messageId,workspaceId);
  if (!issue || !msg) return {ok:false,status:404,error:'Issue or message not found in workspace'};
  const existing = db.prepare('SELECT issue_id FROM issue_message_links WHERE workspace_id = ? AND message_id = ?').get(workspaceId,messageId);
  if (existing) return existing.issue_id === issueId
    ? {ok:true,duplicate:true,issueId,messageId}
    : {ok:false,status:409,error:'Message already linked to a different incident'};
  if (!isActiveIssue(issue.status)) return {ok:false,status:409,error:'Resolved issue cannot be reopened by AI'};
  const ts = Date.now();
  db.transaction(() => {
    db.prepare('INSERT INTO issue_message_links (workspace_id,issue_id,message_id,relation,created_by,reasoning,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(workspaceId,issueId,messageId,relation,String(actor).slice(0,80),String(reason).slice(0,500),ts);
    db.prepare('UPDATE issues SET last_activity_at = ? WHERE id = ? AND workspace_id = ?').run(ts,issueId,workspaceId);
    db.prepare('INSERT INTO audit_log (id,workspace_id,action,entity_type,entity_id,actor,details,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('al_'+ts.toString(36)+'_'+Math.random().toString(36).slice(2,8),workspaceId,'issue_message_linked','issue',issueId,actor,
        'Message '+messageId+' linked as '+relation+' (unverified)',ts);
  })();
  return {ok:true,duplicate:false,issueId,messageId,relation};
}

export function issueMessages(db, workspaceId, issueId, limit=12) {
  return db.prepare('SELECT m.id,m.user_id AS user,m.body,m.created_at AS at,l.relation,l.created_by AS linkedBy,l.created_at AS linkedAt FROM issue_message_links l JOIN messages m ON m.id=l.message_id AND m.workspace_id=l.workspace_id WHERE l.workspace_id=? AND l.issue_id=? ORDER BY m.created_at DESC,m.seq DESC LIMIT ?')
    .all(workspaceId,issueId,Math.max(1,Math.min(50,limit))).reverse();
}

export function workspaceIncidentContext(db, workspaceId, limit=8) {
  const rows = db.prepare("SELECT id,title,status,issue_type,severity,entity_key,COALESCE(last_activity_at,created_at) AS latest_activity FROM issues WHERE workspace_id=? AND status!='resolved' ORDER BY COALESCE(last_activity_at,created_at) DESC LIMIT ?")
    .all(workspaceId,Math.max(1,Math.min(20,limit)));
  return rows.map(i=>({
    id:i.id,title:i.title,status:i.status,type:i.issue_type,severity:i.severity,
    entityKey:i.entity_key,latestActivity:i.latest_activity,
    messages:issueMessages(db,workspaceId,i.id,3)
  }));
}
