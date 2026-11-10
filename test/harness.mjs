// Drives index.html's script in a stubbed DOM to assert how often the paid
// Google Routes API gets called, and that the island bounding boxes pick the
// right port. No network: fetch is stubbed and counted.
//
//   node test/harness.mjs              # Saaremaa line (boxes + behaviour)
//   LINE=hiiumaa node test/harness.mjs # Hiiumaa line (boxes)
//
// Exits non-zero on any failure.
import fs from 'fs'; import vm from 'vm';
import path from 'path'; import {fileURLToPath} from 'url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
const code=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');

// ── universal DOM stub ───────────────────────────────────────────────────────
const mkEl=()=>new Proxy(function(){},{
  get(t,k){
    if(k==='classList')return {add(){},remove(){},toggle(){},replace(){},contains(){return false}};
    if(k==='querySelectorAll')return ()=>[];
    if(k==='querySelector')return ()=>mkEl();
    if(k==='appendChild'||k==='remove'||k==='addEventListener'||k==='removeChild'||k==='insertBefore')return ()=>{};
    if(k==='style')return {};
    if(k==='children')return [];
    if(k==='textContent'||k==='innerHTML')return t['_'+k]??'';
    if(k==='getBoundingClientRect')return ()=>({width:0,height:0,top:0,left:0});
    if(k==='dataset')return {};
    if(k==='value')return '';
    if(k==='checked')return false;
    return mkEl();
  },
  set(t,k,v){t['_'+k]=v;return true},
  apply(){return mkEl()}
});

// ── shared "world" state, persisting across reloads ──────────────────────────
const LINE=process.env.LINE||'saaremaa';
const store={selectedLine:LINE, locationGranted:'1'};          // = localStorage
const localStorage={getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};

let visibility='visible', focused=true;
let POS={latitude:59.4370,longitude:24.7536};                  // Tallinn
let geoCalls=0, geoFails=false;
const navigator={geolocation:{getCurrentPosition(ok,err){
  geoCalls++;
  if(geoFails) setTimeout(()=>err({code:3}),0);
  else         setTimeout(()=>ok({coords:{...POS}}),0);
}}};

const calls={routes:0,nominatim:0,praamid:0};
const routeOrigins=[];
let driveSecs=5400;
let perPort=null;
const portOf=(ll)=>Math.abs(ll.longitude-23.389240)<0.01?'kuivastu':
                   Math.abs(ll.longitude-23.511273)<0.01?'virtsu':
                   Math.abs(ll.longitude-23.044376)<0.01?'heltermaa':'rohukyla';
const json=(o)=>Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(o)});
function fetch(url,opts){
  const u=String(url);
  if(u.includes('routes.googleapis.com')){
    calls.routes++;
    const b=JSON.parse(opts.body);
    routeOrigins.push(b.origin.location.latLng);
    const secs=(perPort&&perPort[portOf(b.destination.location.latLng)])??driveSecs;
    return json({routes:[{legs:[{duration:secs+'s',staticDuration:(secs-600)+'s'}]}]});
  }
  if(u.includes('nominatim')){calls.nominatim++;return json({address:{road:'Tee',village:'Koht'}})}
  if(u.includes('praamid.ee')){calls.praamid++;return json({items:[
    {dtstart:new Date(Date.now()+3*3600e3).toISOString()},
    {dtstart:new Date(Date.now()+5*3600e3).toISOString()}]})}
  return json({});
}

let clockOffset=0;
const RealDate=Date;
class FakeDate extends RealDate{
  constructor(...a){ super(...(a.length?a:[RealDate.now()+clockOffset])) }
  static now(){return RealDate.now()+clockOffset}
}

// ── boot: one page load. Re-callable, which is what a reload (F5) is. ────────
let listeners, sandbox, _sp;
const intervals=new Map(); let ivId=1;
function boot(){
  intervals.clear();
  listeners={};
  const addL=()=>(ev,fn)=>{(listeners[ev]??=[]).push(fn)};
  const document={
    getElementById:()=>mkEl(), createElement:()=>mkEl(), querySelector:()=>mkEl(),
    querySelectorAll:()=>[], addEventListener:addL(), body:mkEl(),
    get visibilityState(){return visibility}, hasFocus:()=>focused,
    documentElement:mkEl(),
  };
  const window={addEventListener:addL(), matchMedia:()=>({matches:false,addEventListener(){}}),
    location:{href:'http://localhost/'}, scrollTo(){}, innerWidth:400};
  const sb={document,window,navigator,localStorage,fetch,Date:FakeDate,
    setTimeout,clearTimeout,Promise,console,Intl,JSON,Math,
    setInterval:(fn,ms)=>{const id=ivId++;intervals.set(id,{fn,ms});return id},
    clearInterval:(id)=>{intervals.delete(id)},
  };
  sb.globalThis=sb; sb.self=sb;
  if(process.env.DBG) console.log('      [boot] store.driveCache='+(store.driveCache??'(absent)'));
  vm.createContext(sb);
  vm.runInContext(code,sb);
  sandbox=sb;
  if(process.env.DBG){
    const _h=sb.driveCacheHit;
    sb.driveCacheHit=(c,co)=>{const r=_h(c,co);
      console.log('      [driveCacheHit] cached='+JSON.stringify(c)+' -> '+r); return r;};
    const _l=sb.loadDriveCache;
    sb.loadDriveCache=()=>{const r=_l(); console.log('      [loadDriveCache] '+JSON.stringify(r)); return r;};
  }
  _sp = sb.selectPort;
  sb.selectPort = (c)=>{ const r=_sp(c); sb.__lastSelected=r[0].key; return r; };
  return sb;
}
boot();

const tick=()=>new Promise(r=>setTimeout(r,4));
const settle=async()=>{for(let i=0;i<30;i++)await tick()};
const emit=(ev)=>{for(const fn of (listeners[ev]??[]))fn()};           // same-task, like the browser
const fire=async(ev)=>{emit(ev); await settle()};
const firePair=async(...evs)=>{evs.forEach(emit); await settle()};

let fails=0;
function check(label,actual,expected){
  const ok=JSON.stringify(actual)===JSON.stringify(expected);
  if(!ok)fails++;
  console.log(`${ok?'PASS':'FAIL'}  ${label}: got ${JSON.stringify(actual)}${ok?'':' want '+JSON.stringify(expected)}`);
}

// ═══ box logic (no network) ══════════════════════════════════════════════════
console.log(`— island boxes, line=${LINE} —`);
const onI=(lat,lon)=>sandbox.isOnIsland(lat,lon);
const portFor=(lat,lon)=>_sp({latitude:lat,longitude:lon})[0].key;
const CASES={
  saaremaa:[
    ['Virtsu port (mainland)',      58.572837,23.511273,false,'virtsu'],
    ['Kuivastu port (Muhu)',        58.573006,23.389240,true, 'kuivastu'],
    ['Kuressaare (Saaremaa)',       58.2481,  22.5134,  true, 'kuivastu'],
    ['Vaike vain causeway',         58.48,    23.05,    true, 'kuivastu'],
    ['Tallinn',                     59.4370,  24.7536,  false,'virtsu'],
    ['Parnu',                       58.3859,  24.4971,  false,'virtsu'],
    ['Haapsalu',                    58.9431,  23.5413,  false,'virtsu'],
    ['mid-strait (on the ferry)',   58.5730,  23.4500,  false,'virtsu'],
    ['Kardla (Hiiumaa)',            58.9978,  22.7490,  false,'virtsu'],
  ],
  hiiumaa:[
    ['Rohukula port (mainland)',    58.907544,23.426702,false,'rohukyla'],
    ['Heltermaa port (Hiiumaa)',    58.864811,23.044376,true, 'heltermaa'],
    ['Kardla (Hiiumaa)',            58.9978,  22.7490,  true, 'heltermaa'],
    ['Soru, S tip of Hiiumaa',      58.6950,  22.5200,  true, 'heltermaa'],
    ['Vormsi (its own ferry)',      59.0050,  23.2300,  false,'rohukyla'],
    ['Noarootsi peninsula',         58.9800,  23.3300,  false,'rohukyla'],
    ['Tallinn',                     59.4370,  24.7536,  false,'rohukyla'],
    ['Kuressaare (Saaremaa)',       58.2481,  22.5134,  false,'rohukyla'],
  ],
};
for(const [label,lat,lon,island,port] of CASES[LINE]){
  check(`${label}: onIsland`, onI(lat,lon), island);
  check(`${label}: port`,     portFor(lat,lon), port);
}

if(LINE!=='saaremaa'){ 
console.log(fails?`\n${fails} FAILING`:'\nALL PASS'); process.exit(fails?1:0); }

// ═══ scenarios ═══════════════════════════════════════════════════════════════
console.log('\n— initial load —');
await settle();  // app auto-runs via startApp()
check('Routes calls on load (1 port)', calls.routes, 1);
check('geolocation fixes on load', geoCalls, 1);
const ivs=[...intervals.values()].map(i=>i.ms);
check('exactly one timer, at 60s', ivs, [60000]);

console.log('\n— blur, then refocus within 60s (cache fresh) —');
const before=calls.routes;
await fire('blur');
check('departure timer cleared on blur', intervals.size, 0);
visibility='visible'; focused=true;
await fire('focus');
check('Routes calls added (throttled)', calls.routes-before, 0);
check('departure timer restarted', intervals.size, 1);

console.log('\n— paired visibilitychange+focus = one activation —');
const b2=calls.routes, p2=calls.praamid;
clockOffset+=61000;              // cache now stale
await firePair('visibilitychange','focus');   // browser fires these together
check('Routes calls for the pair', calls.routes-b2, 1);
check('departure fetches for the pair', calls.praamid-p2, 1);

console.log('\n— drove halfway: position changes —');
POS={latitude:58.7,longitude:23.9}; driveSecs=1500; // near Virtsu
const g3=geoCalls, b3=calls.routes;
clockOffset+=61000;
await fire('focus');
check('new geolocation fix taken', geoCalls-g3, 1);
check('Routes calls', calls.routes-b3, 1);
check('origin sent = new position', routeOrigins.at(-1), {latitude:58.7,longitude:23.9});

console.log('\n— crossed to the island: nearer port flips —');
perPort={kuivastu:600, virtsu:4800};
POS={latitude:58.57,longitude:23.39};
const pS=calls.praamid, rS=calls.routes;
clockOffset+=61000;
await fire('focus');
check('Routes calls', calls.routes-rS, 1);
// 2 is expected: departures for the old port are already in flight (fast path)
// when the flip is discovered, so the new port needs its own fetch. Free API.
check('departures refetched for the new port', calls.praamid-pS, 2);
check('selected port is now the island side', sandbox.__lastSelected, 'kuivastu');

console.log('\n— the 60s timer must not call Google —');
const b4=calls.routes, p4=calls.praamid;
for(const {fn} of intervals.values()){ await fn(); }
await settle();
check('Routes calls from timer', calls.routes-b4, 0);
check('departure fetches from timer', calls.praamid-p4, 1);

console.log('\n— geolocation failure keeps last known coords —');
const lastOrigin=routeOrigins.at(-1);
navigator.geolocation.getCurrentPosition=(ok,err)=>{geoCalls++;setTimeout(()=>err({code:3}),0)};
const b5=calls.routes;
clockOffset+=61000;
await fire('focus');
check('no paid call on failed fix', calls.routes-b5, 0);
check('coords unchanged', routeOrigins.at(-1), lastOrigin);

console.log('\n— hidden tab is silent —');
visibility='hidden'; focused=false;
await fire('visibilitychange');
check('no timers while hidden', intervals.size, 0);
const b6=calls.routes;
clockOffset+=61000;
await fire('focus');   // focus while still hidden
check('no calls while hidden', calls.routes-b6, 0);

console.log('\n— reload (F5) must not spend a paid call —');
// healthy world again: the previous scenario broke geolocation on purpose
navigator.geolocation.getCurrentPosition=(ok,err)=>{geoCalls++;
  if(geoFails) setTimeout(()=>err({code:3}),0); else setTimeout(()=>ok({coords:{...POS}}),0)};
geoFails=false; visibility='visible'; focused=true; perPort=null; driveSecs=3000;
POS={latitude:58.60,longitude:23.60};
clockOffset+=61000;

boot(); await settle();                       // warm load, pays once
check('warm load spends a call', calls.routes-0>0, true);
check('cache was persisted to localStorage', typeof store.driveCache==='string', true);

let r=calls.routes;
boot(); await settle();                       // plain reload, same spot
check('reload: paid calls', calls.routes-r, 0);

r=calls.routes;
for(let i=0;i<10;i++){ boot(); await settle(); }   // F5 held down
check('10 rapid reloads: paid calls', calls.routes-r, 0);

r=calls.routes;
POS={latitude:58.60005,longitude:23.60003};   // ~6 m of GPS jitter
boot(); await settle();
check('reload after 6m jitter: paid calls', calls.routes-r, 0);

r=calls.routes;
POS={latitude:58.609,longitude:23.60};        // ~1 km on
boot(); await settle();
check('reload after moving 1km: paid calls', calls.routes-r, 1);

r=calls.routes;
clockOffset+=61000;                           // same spot, cache expired
boot(); await settle();
check('reload after TTL expiry: paid calls', calls.routes-r, 1);

r=calls.routes;
store.driveCache='{"not valid json';          // corrupt storage must not break the app
boot(); await settle();
check('corrupt cache: still works, pays once', calls.routes-r, 1);


console.log(fails?`\n${fails} FAILING`:'\nALL PASS');
process.exit(fails?1:0);
