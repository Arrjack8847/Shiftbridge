/**
 * Vercel same-origin proxy to the ShiftBridge Express API hosted on Render.
 *
 * Configure SHIFTBRIDGE_RENDER_URL=https://YOUR-SERVICE.onrender.com
 * in Vercel Project > Settings > Environment Variables.
 *
 * Do NOT put Supabase service keys or Groq API keys in Vercel.
 * Those remain on Render. No browser credentials are used for this demo.
 */
const json=(body,status)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
export default {
  async fetch(request) {
    const configured=(process.env.SHIFTBRIDGE_RENDER_URL||"").trim().replace(/\/$/,"");
    let origin;
    try {
      origin=new URL(configured);
      if(origin.protocol!=="https:"||origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash)throw new Error("Invalid backend URL");
      if(origin.hostname===new URL(request.url).hostname)throw new Error("Self-referential backend URL");
    }catch{
      return json({error:"ShiftBridge API backend is not configured. Set SHIFTBRIDGE_RENDER_URL in Vercel to your Render service HTTPS URL.",code:"BACKEND_NOT_CONFIGURED"},503);
    }

    const incoming=new URL(request.url);
    const route=incoming.searchParams.get("__sb_route");
    if(!route||! /^[A-Za-z0-9_/-]+$/.test(route)||route.split("/").some(s=>s==="."||s==="..")||route.startsWith("/")){
      return json({error:"Invalid API route"},400);
    }
    // Long-lived SSE is unreliable in short-running Vercel functions.
    // HTTP 204 permanently closes EventSource; ShiftBridge's existing sync polling remains active.
    if(route==="events")return new Response(null,{status:204,headers:{"Cache-Control":"no-store"}});
    incoming.searchParams.delete("__sb_route");
    const upstream=new URL("/api/"+route,origin);
    upstream.search=incoming.search;

    // All user-facing API requests are JSON. Forward only required headers,
    // never Vercel host headers/cookies or backend infrastructure credentials.
    const headers=new Headers();
    for(const name of ["accept","content-type"]){
      const value=request.headers.get(name);
      if(value)headers.set(name,value);
    }

    const options={method:request.method,headers,redirect:"manual",signal:AbortSignal.timeout(45000)};
    if(!["GET","HEAD"].includes(request.method)){
      const body=await request.arrayBuffer();
      if(body.byteLength>2*1024*1024)return json({error:"Request body too large"},413);
      options.body=body;
    }

    try{
      const response=await fetch(upstream,options);
      const outgoingHeaders=new Headers();
      for(const name of ["content-type","cache-control"]){
        const value=response.headers.get(name);
        if(value)outgoingHeaders.set(name,value);
      }
      outgoingHeaders.set("Cache-Control","no-store");
      return new Response(response.body,{status:response.status,headers:outgoingHeaders});
    }catch(error){
      return json({error:"Cannot reach ShiftBridge backend on Render. Check service status and SHIFTBRIDGE_RENDER_URL.",code:"BACKEND_UNAVAILABLE"},502);
    }
  }
};
