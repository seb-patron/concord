import { writeFileSync } from "node:fs";

type Arm = "baseline" | "A-naive" | "A-cooperative" | "B" | "C1" | "C2" | "D" | "E-naive" | "E-cooperative";
type Arrival = "uniform-poisson" | "burst-5";
type Policy = "naive" | "cooperative";
type SimConfig = { arm: Arm; workers: number; arrival: Arrival; scope: number; hiddenPct: number; service: number; seed: number; sharedToken: boolean; presence: boolean };
export type Metrics = { duplicateStarts: number; duplicateUsefulMinutes: number; completed: number; issues: number; idleIssueMinutes: number; arrivalStartMinutes: number[]; startCompleteMinutes: number[]; issueWaitMinutes: number[]; codeWaitMinutes: number[]; leaseNoProgressMinutes: number; hoardedLeaseMinutes: number; expiries: number; overrides: number; reassignments: number; partialStartAttempts: number; busyFailures: number; rollbacks: number; recoveryMinutes: number[]; hiddenGrowDelayMinutes: number[]; starvation: number; failures: number; abandoned: number; identityCollisionAttempts: number };
type Job = { id: number; units: number[]; attempt: number; firstProgress: number | null; startedAt: number; actor: number; issueFence: number; unitFences: number[]; useful: boolean; finishAt: number };
const DAY = 480, LEASE = 5, HEARTBEAT = LEASE / 3, BACKLOG = 80;
class Random {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0 || 1; }
  next(): number { let x = this.state; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.state = x >>> 0; return this.state / 0x100000000; }
  poissonGap(mean: number): number { return -Math.log(Math.max(1e-12, 1 - this.next())) * mean; }
  int(n: number): number { return Math.floor(this.next() * n); }
}
const percentile = (xs: number[], p: number) => xs.length ? [...xs].sort((a,b)=>a-b)[Math.min(xs.length-1, Math.floor((xs.length-1)*p))] : 0;

function matrix(seed: number): SimConfig[] {
  const arms: Arm[] = ["baseline", "A-naive", "A-cooperative", "B", "C1", "C2", "D", "E-naive", "E-cooperative"];
  const out: SimConfig[] = [];
  for (const arm of arms) for (const workers of [2,5,10]) for (const arrival of ["uniform-poisson","burst-5"] as Arrival[])
    for (const scope of [1,3,8]) for (const hiddenPct of [0,10,25]) for (const service of [15,45,120])
      for (const sharedToken of [false,true]) for (const presence of [false,true])
        out.push({arm,workers,arrival,scope,hiddenPct,service,seed,sharedToken,presence});
  return out;
}
function run(config: SimConfig): Metrics {
  const rng = new Random(config.seed * 997 + config.workers * 31 + config.scope * 7 + config.service);
  const m: Metrics = { duplicateStarts:0, duplicateUsefulMinutes:0, completed:0, issues:BACKLOG, idleIssueMinutes:0, arrivalStartMinutes:[], startCompleteMinutes:[], issueWaitMinutes:[], codeWaitMinutes:[], leaseNoProgressMinutes:0, hoardedLeaseMinutes:0, expiries:0, overrides:0, reassignments:0, partialStartAttempts:0, busyFailures:0, rollbacks:0, recoveryMinutes:[], hiddenGrowDelayMinutes:[], starvation:0, failures:0, abandoned:0, identityCollisionAttempts:0 };
  const issueState = Array.from({length:BACKLOG},()=>({done:false, doneAt:0, active:0, claimedUntil:0, pendingUntil:0, pendingSince:0, pendingActor:-1, fence:0, lastEnd:0, holderActor:-1}));
  const unitUntil = new Map<number, number>(), unitOwner = new Map<number, number>();
  const running: Job[] = [];
  let now=0, starts=0, unitFence=1000;
  const stream = Array.from({length:config.workers},(_,actor)=>{const at=config.arrival==="burst-5" && actor<5 ? rng.next() : rng.poissonGap(DAY/Math.max(1,config.workers*6));return {actor,at,requestedAt:at};});
  const duration = config.service;
  const issues = Array.from({length:BACKLOG},(_,id)=>{
    const units=Array.from({length:config.scope},(_,i)=>(id*3+i*7)%Math.max(12,config.scope*4));
    const hiddenN=Math.floor((id+1)*config.scope*config.hiddenPct/100)-Math.floor(id*config.scope*config.hiddenPct/100);
    const hidden=Array.from({length:hiddenN},(_,i)=>(id*5+config.scope*3+i*11+1)%Math.max(12,config.scope*4));
    return {units:[...new Set(units)],hidden:[...new Set(hidden)].filter(u=>!units.includes(u))};
  });
  const policy: Policy = config.arm.includes("cooperative") ? "cooperative" : "naive";
  const issueExclusive = ["B","C1","C2","D"].includes(config.arm);
  const isA=config.arm.startsWith("A-"), isE=config.arm.startsWith("E-");
  function dispatch(actor:number, at:number): void {
    now=at;
    const candidates=issues.map((v,id)=>id).filter(id=>!issueState[id].done).sort((a,b)=>a-b);
    if (!candidates.length) return;
    let selected=-1, issueWait=0, codeWait=0;
    for (const id of candidates) {
      const state=issueState[id];
      if(config.arm==="C2" && state.pendingUntil && state.pendingUntil<=at){m.leaseNoProgressMinutes+=state.pendingUntil-state.pendingSince;m.hoardedLeaseMinutes+=state.pendingUntil-state.pendingSince;state.pendingUntil=0;state.claimedUntil=0;state.pendingSince=0;state.pendingActor=-1;m.rollbacks++;continue;}
      if (issueExclusive && state.claimedUntil>at && !(config.arm==="C2"&&state.pendingActor===actor)) { if(config.sharedToken&&state.holderActor!==actor)m.identityCollisionAttempts++;issueWait=Math.max(issueWait,state.claimedUntil-at); continue; }
      const fullUnits=issues[id].units;
      const units=(!issueExclusive && fullUnits.length>1)?fullUnits.filter((_,index)=>index%2===actor%2):fullUnits;
      const busy=units.some(u=>(unitUntil.get(u)||0)>at);
      if (busy) {
        codeWait=Math.max(codeWait,...units.map(u=>Math.max(0,(unitUntil.get(u)||0)-at)));
        if(issueExclusive&&config.arm!=="C2")m.busyFailures++;
        if(config.arm==="C2" && state.active===0 && !state.pendingUntil){state.pendingSince=at;state.pendingActor=actor;state.pendingUntil=at+LEASE;state.claimedUntil=state.pendingUntil;}
        if(config.arm==="C1") m.rollbacks++;
        continue;
      }
      selected=id; break;
    }
    if(selected<0) {
      const id=candidates[0];
      if(issueWait) m.issueWaitMinutes.push(issueWait);
      if(codeWait) m.codeWaitMinutes.push(codeWait);
      stream[actor].at=Math.min(DAY+duration,at+Math.max(1,Math.min(LEASE,issueWait||codeWait||1)));
      return;
    }
    const id=selected, st=issueState[id], fullUnits=issues[id].units;
    const units=(!issueExclusive && fullUnits.length>1)?fullUnits.filter((_,index)=>index%2===actor%2):fullUnits;
    const duplicate=st.active>0;
    if(duplicate) m.duplicateStarts++;
    starts++;
    const issueFence=++st.fence;
    st.holderActor=actor;
    if(issueExclusive) st.claimedUntil=at+duration;
    if(st.pendingUntil){m.leaseNoProgressMinutes+=at-st.pendingSince;m.hoardedLeaseMinutes+=at-st.pendingSince;}
    st.pendingUntil=0;st.pendingSince=0;st.pendingActor=-1;
    const fences=units.map(()=>++unitFence);
    for(const u of units){unitUntil.set(u,at+duration/2);unitOwner.set(u,actor);}
    st.active++;
    const record: Job={id,units,attempt:starts,firstProgress:at,startedAt:at,actor,issueFence,unitFences:fences,useful:!duplicate,finishAt:at+duration};
    if(config.arrival==="burst-5" && at<1) record.finishAt=at+duration;
    running.push(record);
    m.arrivalStartMinutes.push(at-stream[actor].requestedAt);
    if((isA || (isE&&config.presence)) && policy==="cooperative" && st.active>1) { record.finishAt=at+Math.min(1,duration); }
    if(duplicate) m.duplicateUsefulMinutes+=record.finishAt-at;
    // A shared token collapses run identity in the advisory record, but never code authorization.
    if(config.sharedToken && (isA||isE) && config.presence) st.active=Math.max(1,st.active);
    const hidden=issues[id].hidden, discoveryAt=at+duration/2;
    const growDelay=Math.max(0,...hidden.map(u=>Math.max(0,(unitUntil.get(u)||0)-discoveryAt)));
    m.hiddenGrowDelayMinutes.push(growDelay);
    if(growDelay>0) record.finishAt+=growDelay;
    for(const u of hidden){unitUntil.set(u,record.finishAt);unitOwner.set(u,actor);}
    // Work begins immediately after a successful grant; only C2 pending reservation contributes no-progress time.
    m.hoardedLeaseMinutes+=issueExclusive?Math.max(0,record.finishAt-at-duration/2):0;
    // heartbeat is modeled as preserving the fence; a missed renewal is a deterministic 1-in-20 seed event.
    if(issueExclusive && rng.next()<0.05){ st.claimedUntil=at+LEASE; m.expiries++; m.reassignments++; m.recoveryMinutes.push(Math.min(duration,LEASE)); }
    stream[actor].at=record.finishAt;
  }
  // Event-time loop: arrivals and completions are processed in stable actor/issue order.
  while(now<DAY && m.completed<BACKLOG && running.length<BACKLOG*2) {
    let actor=-1, t=Infinity;
    for(const a of stream) if(a.at<t){t=a.at;actor=a.actor;}
    if(actor<0||t>DAY+duration)break;
    const done=running.filter(j=>j.finishAt<=t).sort((a,b)=>a.finishAt-b.finishAt||a.actor-b.actor);
    for(const job of done){
      const idx=running.indexOf(job);if(idx>=0)running.splice(idx,1);
      const st=issueState[job.id];st.active=Math.max(0,st.active-1);
      if(job.useful&&!st.done){st.done=true;st.doneAt=job.finishAt;m.completed++;m.startCompleteMinutes.push(job.finishAt-job.startedAt);}
      for(const u of job.units) if(unitOwner.get(u)===job.actor){unitUntil.set(u,job.finishAt);unitOwner.delete(u);}
      if(config.arm==="baseline") st.claimedUntil=0;
      st.lastEnd=job.finishAt;
      stream[job.actor].at=job.finishAt+rng.poissonGap(DAY/Math.max(1,config.workers*6));
      stream[job.actor].requestedAt=stream[job.actor].at;
    }
    dispatch(actor,t);
    if(running.length===0 && stream.every(s=>s.at>DAY))break;
  }
  m.idleIssueMinutes=issues.reduce((sum,_,id)=>sum+(issueState[id].done?issueState[id].doneAt:DAY),0);
  m.starvation=issues.filter((_,id)=>!issueState[id].done).length;
  m.failures=m.busyFailures+m.expiries;
  m.abandoned=Math.max(0,starts-m.completed);
  return m;
}
const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const fields=(m:Metrics)=>({duplicateStarts:m.duplicateStarts,duplicateUsefulMinutes:m.duplicateUsefulMinutes,completedTasks:m.completed,idleIssueMinutes:m.idleIssueMinutes,meanArrivalToStart:avg(m.arrivalStartMinutes),p50ArrivalToStart:percentile(m.arrivalStartMinutes,.5),p95ArrivalToStart:percentile(m.arrivalStartMinutes,.95),meanStartToAccepted:avg(m.startCompleteMinutes),p50StartToAccepted:percentile(m.startCompleteMinutes,.5),p95StartToAccepted:percentile(m.startCompleteMinutes,.95),issueWaitP50:percentile(m.issueWaitMinutes,.5),issueWaitP95:percentile(m.issueWaitMinutes,.95),codeWaitP50:percentile(m.codeWaitMinutes,.5),codeWaitP95:percentile(m.codeWaitMinutes,.95),leasesWithoutProgressMinutes:m.leaseNoProgressMinutes,hoardedLeaseMinutes:m.hoardedLeaseMinutes,expiries:m.expiries,overrides:m.overrides,reassignments:m.reassignments,partialStartAttempts:m.partialStartAttempts,busyUnitFailures:m.busyFailures,rollbacks:m.rollbacks,recoveryMinutes:avg(m.recoveryMinutes),hiddenScopeGrowDelay:avg(m.hiddenGrowDelayMinutes),starvedIssues:m.starvation,failures:m.failures,abandonedRuns:m.abandoned,identityCollisionAttempts:m.identityCollisionAttempts});
function main(){
 const replicates=Number(process.env.C2B_SEEDS||20), baseSeed=Number(process.env.C2B_BASE_SEED||1);
 const rows:string[]=[];
 for(let seed=baseSeed;seed<baseSeed+replicates;seed++) for(const c of matrix(seed)){
   const m=run(c); const x=fields(m);
   rows.push([c.arm,c.workers,c.arrival,c.scope,c.hiddenPct,c.service,c.seed,c.sharedToken,c.presence,...Object.values(x)].join(","));
 }
 const header="arm,workerSlots,arrivalPattern,declaredScope,hiddenNeedPct,serviceMinutes,seed,sharedToken,presence,"+Object.keys(fields({duplicateStarts:0,duplicateUsefulMinutes:0,completed:0,issues:0,idleIssueMinutes:0,arrivalStartMinutes:[],startCompleteMinutes:[],issueWaitMinutes:[],codeWaitMinutes:[],leaseNoProgressMinutes:0,hoardedLeaseMinutes:0,expiries:0,overrides:0,reassignments:0,partialStartAttempts:0,busyFailures:0,rollbacks:0,recoveryMinutes:[],hiddenGrowDelayMinutes:[],starvation:0,failures:0,abandoned:0,identityCollisionAttempts:0})).join(",");
 writeFileSync("results.csv",header+"\n"+rows.join("\n")+"\n");
 const metricNames=header.split(",").slice(9), sums=new Map<string,number[]>();
 for(const row of rows){const v=row.split(","),key=`${v[0]}|${v[6]}`,total=sums.get(key)||Array(metricNames.length).fill(0);for(let i=0;i<total.length;i++)total[i]+=Number(v[i+9]);sums.set(key,total);}
 const byArm=new Map<string,number[][]>();for(const [key,total] of sums){const arm=key.split("|")[0],arr=byArm.get(arm)||[];arr.push(total.map(x=>x/648));byArm.set(arm,arr);}
 const ci=(arm:string,name:string)=>{const i=metricNames.indexOf(name),values=(byArm.get(arm)||[]).map(x=>x[i]),mean=avg(values),se=values.length>1?Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/(values.length-1)/values.length):0;return `${mean.toFixed(2)} [${Math.max(0,mean-1.96*se).toFixed(2)}, ${(mean+1.96*se).toFixed(2)}]`;};
 const text=`Deterministic offline issue-claim simulation\n\n${rows.length} seed-level rows; seeds ${baseSeed}–${baseSeed+replicates-1}; ${replicates} seeds per factorial cell. Each row is one arm × worker-slot × arrival × scope × hidden-need × service × identity × presence cell and seed. There are ${matrix(baseSeed).length/9} cells per arm per seed. All timings are synthetic. Five-minute issue TTL and one-third-TTL heartbeat are provisional assumptions. Presence is toggled independently of lease behavior. A/E naive and cooperative variants are capability sensitivities.\n\nAcross-seed mean [normal 95% interval], averaging each seed across the same factorial mix (mean counts/minutes per simulation cell):\n\nArm | duplicate starts | duplicate useful minutes | completed tasks | idle issue-minutes | p95 issue wait | p95 code wait | hoarded lease-minutes | hidden grow delay | shared-token collision attempts\n--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:\n`+[...byArm.keys()].map(a=>`| ${a} | ${ci(a,"duplicateStarts")} | ${ci(a,"duplicateUsefulMinutes")} | ${ci(a,"completedTasks")} | ${ci(a,"idleIssueMinutes")} | ${ci(a,"issueWaitP95")} | ${ci(a,"codeWaitP95")} | ${ci(a,"hoardedLeaseMinutes")} | ${ci(a,"hiddenScopeGrowDelay")} | ${ci(a,"identityCollisionAttempts")} |`).join("\n")+"\n\n";
 const chunks=[text,"The CSV is the complete seed-level result. Metric definitions: duplicate starts are overlapping attempts; duplicate useful-work minutes are duplicated service minutes; completed tasks count first accepted completions; idle issue-minutes sum backlog issues left incomplete times the eight-hour horizon; issue/code wait percentiles are blocked retry gaps; hoarded lease-minutes count issue authority after the first-publish midpoint; grow delay is hidden-scope acquisition wait; shared-token collision attempts count blocked foreign runs sharing a principal. Empty wait samples are zero. Unfinished work is retained as starvation, failure and abandonment counts.\n"];
 writeFileSync("output.txt",chunks.join(""));
}
if (process.argv[1]?.endsWith("sim.ts")) main();
export { run, Random, matrix };
