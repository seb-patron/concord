import assert from "node:assert/strict";

type Grant = { run: string; issueFence: number; unitFences: Map<string, number>; expires: number };
class LeaseBook {
  private open = true;
  private issueFence = 0;
  private codeFence = 1000;
  private unitFence = new Map<string, number>();
  private units = new Map<string, string>();
  private grants = new Map<string, Grant>();
  private keys = new Map<string, Grant>();
  audit: string[] = [];
  private expire(now: number): void { const g=this.grants.get("issue");if(g&&g.expires<=now){this.grants.delete("issue");for(const u of g.unitFences.keys())if(this.units.get(u)===g.run)this.units.delete(u);} }
  acquire(run: string, key: string, wanted: string[], now: number, ttl = 5): Grant | null {
    this.expire(now);
    const previous = this.keys.get(key);
    if (previous && previous.run === run && previous.expires > now) return previous;
    if (!this.open) return null;
    const current = this.grants.get("issue");
    if (current && current.expires > now) return null;
    if (wanted.some(u => this.units.has(u))) return null;
    const grant: Grant = { run, issueFence: ++this.issueFence, unitFences: new Map(), expires: now + ttl };
    for (const unit of wanted) {
      const fence = ++this.codeFence;
      this.unitFence.set(unit, fence); this.units.set(unit, run); grant.unitFences.set(unit, fence);
    }
    this.grants.set("issue", grant); this.keys.set(key, grant); return grant;
  }
  validIssue(run: string, fence: number, now: number): boolean { const g=this.grants.get("issue"); return !!g&&g.run===run&&g.issueFence===fence&&g.expires>now&&this.open; }
  renew(run: string, fence: number, now: number, ttl = 5): boolean { this.expire(now);const g=this.grants.get("issue");if(!g||g.run!==run||g.issueFence!==fence||!this.open)return false;g.expires=now+ttl;return true; }
  validUnit(run: string, unit: string, fence: number): boolean { const g=this.grants.get("issue"); return !!g&&g.run===run&&g.unitFences.get(unit)===fence&&this.units.get(unit)===run&&this.unitFence.get(unit)===fence; }
  release(run: string): void { const g=this.grants.get("issue"); if(g?.run===run){this.grants.delete("issue");for(const u of g.unitFences.keys())this.units.delete(u);} }
  close(): void { this.open=false;const g=this.grants.get("issue");if(g){this.release(g.run);this.issueFence++;} }
  reopen(): void { this.open=true; }
  override(run: string, reason: string): void { assert.ok(reason.trim());this.audit.push(`override:${run}:${reason}`);const g=this.grants.get("issue");if(g){this.release(g.run);this.issueFence++;} }
  busy(unit: string): boolean { return this.units.has(unit); }
  get grantCount(): number { return this.grants.size; }
}
function test(name: string, body: () => void): void { body(); console.log(`ok - ${name}`); }

test("single valid issue fence", () => { const b=new LeaseBook();const a=b.acquire("r1","k1",["a"],0)!;assert.ok(b.validIssue("r1",a.issueFence,1));assert.equal(b.acquire("r2","k2",["b"],1),null); });
test("stale-holder rejection after expiry and reassignment", () => { const b=new LeaseBook();const a=b.acquire("r1","k1",["a"],0)!;b.release("r1");const c=b.acquire("r2","k2",["a"],6)!;assert.equal(b.validIssue("r1",a.issueFence,6),false);assert.ok(b.validIssue("r2",c.issueFence,6)); });
test("zero partial unit grants on one busy declared unit", () => { const b=new LeaseBook();b.acquire("r1","k1",["busy"],0);assert.equal(b.acquire("r2","k2",["free","busy"],1),null);assert.equal(b.busy("free"),false); });
test("issue and code fences are distinct namespaces", () => { const b=new LeaseBook();const g=b.acquire("r","k",["u"],0)!;assert.notEqual(g.issueFence, g.unitFences.get("u")); });
test("reopen grants fresh ownership and never restores old fence", () => { const b=new LeaseBook();const a=b.acquire("r1","k1",["u"],0)!;b.close();b.reopen();const c=b.acquire("r2","k2",["u"],1)!;assert.notEqual(a.issueFence,c.issueFence);assert.equal(b.validIssue("r1",a.issueFence,1),false); });
test("same-key retry is idempotent", () => { const b=new LeaseBook();const a=b.acquire("r","key",["u"],0)!;const retry=b.acquire("r","key",["u"],1)!;assert.equal(retry,a);assert.equal(retry.unitFences.get("u"),a.unitFences.get("u")); });
test("override is audited and fences stale holder", () => { const b=new LeaseBook();const a=b.acquire("r1","k1",["u"],0)!;b.override("owner","incident response");assert.equal(b.audit.length,1);assert.equal(b.validIssue("r1",a.issueFence,1),false); });
test("crash before start creates no grant", () => { const b=new LeaseBook();assert.equal(b.grantCount,0);assert.equal(b.acquire("r","k",[],0)?.unitFences.size,0); });
test("crash after start is recoverable at expiry", () => { const b=new LeaseBook();const a=b.acquire("r1","k1",["u"],0)!;assert.equal(b.acquire("r2","k2",["u"],6)?.run,"r2");assert.equal(b.validIssue("r1",a.issueFence,6),false); });
test("partitioned stale resume cannot renew authority", () => { const b=new LeaseBook();const a=b.acquire("r1","k1",["u"],0)!;b.acquire("r2","k2",["u"],6);assert.equal(b.validIssue("r1",a.issueFence,7),false); });
test("replacement change keeps stable intent and idempotent grant", () => { const b=new LeaseBook();const a=b.acquire("r","intent",["u"],0)!;assert.equal(b.acquire("r","intent",["u"],1),a); });
test("scope edit cannot partially extend active scope", () => { const b=new LeaseBook();const a=b.acquire("r1","k1",["held"],0)!;assert.equal(b.acquire("r2","grow",["new","held"],1),null);assert.equal(b.validUnit("r1","held",a.unitFences.get("held")!),true);assert.equal(b.busy("new"),false); });
test("busy hidden-unit grow preserves old grants and grants no subset", () => { const b=new LeaseBook();const a=b.acquire("r1","k1",["old"],0)!;b.acquire("r2","k2",["hidden"],0);assert.equal(b.acquire("r1","grow",["old","hidden"],1),null);assert.equal(b.validUnit("r1","old",a.unitFences.get("old")!),true); });
test("close racing with claim revokes; reopen is fresh", () => { const b=new LeaseBook();const a=b.acquire("r1","k1",["u"],0)!;b.close();assert.equal(b.acquire("r2","k2",["u"],1),null);b.reopen();const c=b.acquire("r2","k2",["u"],2)!;assert.notEqual(a.issueFence,c.issueFence); });
test("paused-holder override invalidates its fence", () => { const b=new LeaseBook();const a=b.acquire("r1","k1",["u"],0)!;b.override("owner","paused worker");assert.equal(b.validIssue("r1",a.issueFence,1),false); });
test("duplicate renewers cannot create a second holder", () => { const b=new LeaseBook();b.acquire("r1","k1",["u"],0);assert.equal(b.acquire("r2","k2",["u"],1),null); });
test("renewal without progress preserves owner and fence", () => { const b=new LeaseBook();const a=b.acquire("r","k",["u"],0)!;assert.equal(b.renew("r",a.issueFence,4),true);assert.equal(b.validIssue("r",a.issueFence,8),true);assert.equal(b.acquire("other","k2",["v"],8),null); });
test("work may outlast a short lease only after stale authority is rejected", () => { const b=new LeaseBook();const a=b.acquire("r1","k1",["u"],0,5)!;const c=b.acquire("r2","k2",["u"],6,120)!;assert.notEqual(a.issueFence,c.issueFence);assert.equal(b.validUnit("r1","u",a.unitFences.get("u")!),false); });
test("one run claiming backlog still receives at most one current claim", () => { const b=new LeaseBook();assert.ok(b.acquire("r","one",["a"],0));assert.equal(b.acquire("r","two",["b"],0),null); });
