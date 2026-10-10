export const demoPeople = [
  { id:'jack', name:'Jack', initials:'J', hue:'sea', role:'Barista' },
  { id:'emma', name:'Emma', initials:'E', hue:'lavender', role:'Barista' },
  { id:'sarah', name:'Sarah', initials:'S', hue:'rose', role:'Shift lead' },
  { id:'manager', name:'Manager', initials:'M', hue:'orange', role:'Owner' },
  { id:'liam', name:'Liam', initials:'L', hue:'blue', role:'Barista' }
];
export const ruleDefaults = [
  { id:'inventory', name:'Stock checks', note:'Count and confirm supplies', allowed:true },
  { id:'cleaning', name:'Routine cleaning', note:'Regular low-risk cleaning work', allowed:true },
  { id:'opening', name:'Opening preparation', note:'Preapproved startup activities', allowed:true },
  { id:'repairs', name:'Equipment repairs', note:'Qualified review always required', allowed:false, locked:true },
  { id:'purchases', name:'Purchases and spending', note:'Owner approval required', allowed:false, locked:true },
  { id:'safety', name:'Safety clearance', note:'Qualified human verification required', allowed:false, locked:true }
];
export function initialState(){
  const now=Date.now();
  return {
    version:3, currentWorkspace:'daily', role:'admin', user:'jack', onboarded:true,
    workspaces:[
      {id:'daily',name:'Daily Brew Café',type:'Café / Restaurant',zone:'Asia/Kuala_Lumpur',members:['jack','emma','sarah','manager','liam'],invite:'K7PX-42MA',rules:structuredClone(ruleDefaults)},
      {id:'riverside',name:'Riverside Bakery',type:'Bakery',zone:'Asia/Kuala_Lumpur',members:['jack','sarah','manager'],invite:'RB4K-8M2Z',rules:structuredClone(ruleDefaults)}
    ],
    messages:[
      {id:'m1',ws:'daily',user:'emma',body:'Machine 2 is leaking again. Please don’t use it until someone checks.',at:now-36*60000},
      {id:'m2',ws:'daily',user:'sarah',body:'We may be running low on oat milk.',at:now-33*60000},
      {id:'m3',ws:'daily',user:'manager',body:'Could someone check the storage room before opening?',at:now-29*60000},
      {id:'m4',ws:'daily',user:'jack',body:"I'll check the oat milk stock now.",at:now-26*60000},
      {id:'m5',ws:'daily',user:'jack',body:'Checked storage. Four cartons are left.',at:now-15*60000},
      {id:'m6',ws:'riverside',user:'sarah',body:'Bread trays have arrived for the morning bake.',at:now-25*60000},
      {id:'m7',ws:'riverside',user:'jack',body:'Great. I’ll prepare the display counter.',at:now-12*60000}
    ],
    tasks:[
      {id:'t1',ws:'daily',name:'Check oat milk stock',description:'Check storage and record the remaining number of cartons.',assignee:'jack',status:'todo',priority:'high',category:'inventory',due:'10:00 AM',source:'m3',createdBy:'demo',verification:'self-report'},
      {id:'t2',ws:'daily',name:'Prepare serving counter',description:'Arrange the clean cups and prepare the serving counter for opening.',assignee:'jack',status:'todo',priority:'normal',category:'opening',due:'9:00 AM',source:null,createdBy:'demo',verification:'self-report'},
      {id:'t3',ws:'daily',name:'Clean kitchen surfaces',description:'Wipe down food-preparation surfaces.',assignee:'jack',status:'done',priority:'normal',category:'cleaning',due:'8:30 AM',source:null,createdBy:'demo',verification:'self-report',completion:'Self-reported done'},
      {id:'t4',ws:'daily',name:'Check paper cup delivery',description:'Confirm quantity against the delivery note.',assignee:'emma',status:'doing',priority:'normal',category:'inventory',due:'11:00 AM',source:null,createdBy:'demo',verification:'self-report'},
      {id:'t5',ws:'daily',name:'Inspect machine 2',description:'Qualified technician inspection required before reuse.',assignee:null,status:'review',priority:'high',category:'repairs',due:'Today',source:'m1',createdBy:'demo',verification:'qualified'},
      {id:'t6',ws:'riverside',name:'Prepare bakery display',description:'Arrange morning bakery products for display.',assignee:'jack',status:'todo',priority:'normal',category:'opening',due:'9:30 AM',source:'m7',createdBy:'demo',verification:'self-report'}
    ],
    issues:[{id:'i1',ws:'daily',title:'Machine 2 is leaking',severity:'high',status:'open',source:'m1',description:'Reported repeatedly. Inspection and safe-to-use sign-off are required.',createdBy:'demo',requiresApproval:true}],
    shifts:{daily:{on:true,since:now-85*60000},riverside:{on:false,since:null}},
    handovers:{}, notifications:[], invites:[], preferences:{},
  };
}
export function escapeHTML(value=''){return String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function safeID(prefix='id'){return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;}
export function displayTime(timestamp){return new Date(timestamp).toLocaleTimeString('en-MY',{hour:'numeric',minute:'2-digit'});}
export function formatDate(timestamp){return new Date(timestamp).toLocaleDateString('en-MY',{weekday:'long',day:'numeric',month:'short'});}
