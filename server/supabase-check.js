/** Read-only server-side Supabase connection smoke test. */
const url=(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const key=process.env.SUPABASE_SECRET_KEY||'';
if(!/^https:\/\/[^/]+\.supabase\.co$/.test(url)||!key) {
 console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env.');process.exit(1);
}
try{
 const r=await fetch(url+'/rest/v1/sb_workspaces?select=id,name&limit=1',{
  headers:{apikey:key},signal:AbortSignal.timeout(10000)
 });
 if(!r.ok)throw new Error('HTTP '+r.status+' '+(await r.text()).slice(0,300));
 const rows=await r.json();
 console.log('Supabase connection OK. Workspaces in sample: '+rows.length);
}catch(e){console.error('Supabase connection failed:',e.message);process.exitCode=1}
