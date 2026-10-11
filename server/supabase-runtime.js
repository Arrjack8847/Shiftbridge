/**
 * Single-instance hackathon persistence adapter.
 * SQLite preserves existing synchronous task/agent transactions.
 * Supabase stores an eventually consistent copy and restores it on startup.
 * Never use with two writers/instances; use Postgres-native transactions for production.
 */
import { getDB, initSchema } from './db.js';
const TABLES=['people','workspaces','workspace_members','messages','tasks','issues','rules',
  'audit_log','shifts','handovers','meta','ai_proposals','completion_claims',
  'ai_analysis_log','announcements','announcement_revisions','announcement_acknowledgments',
  'ai_jobs','issue_message_links','ai_feedback'];
const PK={
  workspace_members:['workspace_id','person_id'],shifts:['workspace_id'],handovers:['workspace_id'],
  meta:['key'],announcement_acknowledgments:['announcement_id','person_id'],
  issue_message_links:['workspace_id','message_id']
};
const REVERSED=[...TABLES].reverse();
const URL=(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const SECRET=process.env.SUPABASE_SECRET_KEY||'';
const enabled=process.env.SHIFTBRIDGE_STORAGE==='supabase';
if(enabled&&(!/^https:\/\/[^/]+\.supabase\.co$/.test(URL)||!SECRET||SECRET.startsWith('sb_publishable_'))){
 throw new Error('Supabase mode requires SUPABASE_URL and a server-only SUPABASE_SECRET_KEY (sb_secret_...).');
}
const info={mode:enabled?'supabase-mirror':'sqlite',connected:false,lastSync:null,lastError:null};
const baseHeaders=()=>({'apikey':SECRET,'Content-Type':'application/json'});
async function request(path,options={}){
 const r=await fetch(URL+'/rest/v1/'+path,{
  ...options,headers:{...baseHeaders(),...(options.headers||{})},signal:AbortSignal.timeout(30000)
 });
 if(!r.ok)throw new Error('Supabase HTTP '+r.status+' '+(await r.text()).slice(0,350));
 if(options.method && options.method !== 'GET') return null;
 if(r.status===204)return null;
 return r.json();
}
async function remoteRows(table){
 const all=[];
 for(let offset=0;;offset+=500){
  const rows=await request('sb_'+table+'?select=*&order='+encodeURIComponent((PK[table]||['id'])[0]+'.asc')+'&limit=500&offset='+offset);
  all.push(...rows);
  if(rows.length<500)return all;
 }
}
function localRows(table){return getDB().prepare('SELECT * FROM "'+table+'"').all();}
function rowKey(row,table){return JSON.stringify((PK[table]||['id']).map(key=>row[key]));}
function ensureColumns(db,table,record){
 const cols=new Set(db.prepare('PRAGMA table_info("'+table+'")').all().map(c=>c.name));
 return Object.fromEntries(Object.entries(record).filter(([k])=>cols.has(k)));
}
async function upsert(table,rows){
 if(!rows.length)return;
 const conflict=(PK[table]||['id']).join(',');
 for(let n=0;n<rows.length;n+=100){
  await request('sb_'+table+'?on_conflict='+encodeURIComponent(conflict),{
    method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},
    body:JSON.stringify(rows.slice(n,n+100))
  });
 }
}
async function removeRows(table,rows){
 const cols=PK[table]||['id'];
 for(const row of rows){
  const params=cols.map(c=>encodeURIComponent(c)+'=eq.'+encodeURIComponent(String(row[c]))).join('&');
  await request('sb_'+table+'?'+params,{method:'DELETE',headers:{Prefer:'return=minimal'}});
 }
}
function importCloud(snapshot){
 const db=getDB();
 db.transaction(()=>{
  for(const table of REVERSED)db.prepare('DELETE FROM "'+table+'"').run();
  for(const table of TABLES){
   const rows=snapshot.get(table)||[];
   if(!rows.length)continue;
   const cols=Object.keys(ensureColumns(db,table,rows[0]));
   if(!cols.length)continue;
   const stmt=db.prepare('INSERT INTO "'+table+'" ('+cols.map(c=>'"'+c+'"').join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')');
   for(const row of rows){
    const filtered=ensureColumns(db,table,row);
    stmt.run(...cols.map(c=>filtered[c]??null));
   }
  }
 })();
}
export async function initializeCloud(){
 if(!enabled)return false;
 initSchema();
 const snapshot=new Map();
 for(const table of TABLES)snapshot.set(table,await remoteRows(table));
 // Distinguish a brand-new cloud from existing data. Do not discard local seed until cloud is populated.
 const populated=(snapshot.get('workspaces')||[]).length>0;
 if(populated){
  importCloud(snapshot);
  console.log('[supabase] restored cloud snapshot to local transactional SQLite cache');
 } else {
  console.log('[supabase] fresh cloud database; local seed can initialize it');
 }
 info.connected=true;info.lastError=null;
 return populated;
}
let syncing=false;
export async function flushCloud(){
 if(!enabled||syncing)return;
 syncing=true;
 try{
  // Capture local rows at a consistent point, before asynchronous remote calls.
  const local=new Map();
  getDB().transaction(()=>{for(const t of TABLES)local.set(t,localRows(t));})();
  const remote=new Map();
  for(const t of TABLES)remote.set(t,await remoteRows(t));
  // Upsert parents before children, delete children before parents. Deletions are deliberate
  // and only safe with a single designated writer.
  for(const table of TABLES)await upsert(table,local.get(table));
  for(const table of REVERSED){
   const ids=new Set(local.get(table).map(r=>rowKey(r,table)));
   const removed=remote.get(table).filter(r=>!ids.has(rowKey(r,table)));
   await removeRows(table,removed);
  }
  info.connected=true;info.lastError=null;info.lastSync=new Date().toISOString();
 }catch(err){
  info.connected=false;info.lastError=err.message;
  console.error('[supabase] persistence error:',err.message);
 }finally{syncing=false;}
}
export function startCloudSync(){
 if(!enabled)return;
 // For the hackathon demo's single instance; not an atomic cross-database commit.
 const interval=Math.max(1000,Number(process.env.SUPABASE_SYNC_INTERVAL_MS||3000));
 setInterval(()=>{void flushCloud()},interval).unref();
 void flushCloud();
}
export function cloudStatus(){return {...info};}
