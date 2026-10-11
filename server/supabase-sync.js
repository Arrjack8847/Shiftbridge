/**
 * Explicit, opt-in SQLite -> Supabase snapshot. Does not change local data.
 * Requires SUPABASE_URL and SUPABASE_SECRET_KEY on the backend.
 * Usage: npm run supabase:sync
 */
import { getDB, closeDB, initSchema } from './db.js';

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SECRET_KEY || '';
if (!/^https:\/\/[^/]+\.supabase\.co$/.test(url) || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env (never commit it).');
  process.exit(1);
}
if (process.env.SUPABASE_SYNC_CONFIRM !== 'YES') {
  console.error('Snapshot requires SUPABASE_SYNC_CONFIRM=YES. It can overwrite matching remote rows.');
  process.exit(1);
}

// Parents first for FK constraints. Child references point only to previously inserted parents.
const tables = [
 'workspaces','workspace_members','messages','tasks','issues','rules',
 'audit_log','shifts','handovers','meta','ai_proposals','completion_claims',
 'ai_analysis_log','announcements','announcement_revisions',
 'announcement_acknowledgments','ai_jobs'
];
const conflict = {
 workspace_members:'workspace_id,person_id',
 shifts:'workspace_id',handovers:'workspace_id',meta:'key',
 announcement_acknowledgments:'announcement_id,person_id',
};

async function upsert(table, rows) {
 const response = await fetch(url + '/rest/v1/sb_' + table + '?on_conflict=' + encodeURIComponent(conflict[table] || 'id'), {
  method:'POST',
  headers:{
    apikey:key,
    'Content-Type':'application/json',
    Prefer:'resolution=merge-duplicates,return=minimal',
  },
  body:JSON.stringify(rows),
  signal:AbortSignal.timeout(30000)
 });
 if (!response.ok) throw new Error(table + ': HTTP ' + response.status + ' ' + (await response.text()).slice(0,500));
}
let processed=0;
try {
 initSchema();
 const db=getDB();
 for (const table of tables) {
  const rows=db.prepare('SELECT * FROM "'+table+'"').all();
  for(let offset=0;offset<rows.length;offset+=200){
   await upsert(table, rows.slice(offset,offset+200));
  }
  processed+=rows.length;
  console.log('[supabase] '+table+': '+rows.length+' rows');
 }
 console.log('[supabase] Snapshot complete, '+processed+' rows. SQLite remains the live database.');
} catch(e){
 console.error('[supabase] Snapshot failed:',e.message);
 process.exitCode=1;
} finally {
 closeDB();
}
