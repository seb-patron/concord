import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;
const { createRepoPage } = require('../../web/repo.js') as any;

const fixture = {
  data: { projections: {
    repos: { changes: [
      { changeId: 'x', authorId: 'agent-a', authorModel: 'model-from-api', intentText: 'Cap retries', unitKeys: ['fn:retry'], status: 'ready', revision: 2, headOid: 'abc123', baseOid: 'base' },
      { changeId: 'y', authorId: 'agent-b', intentText: 'Rename logs', unitKeys: ['file:log'], status: 'blocked', revision: 1, headOid: 'def456' },
    ], repo: { observedCanonicalOid: 'main123' } },
    leases: { items: [{ leaseId: 'l1', changeId: 'x', holderId: 'agent-a', intentText: 'Protect retry path', unitKey: 'fn:retry', fence: 3, expiresAt: Date.now() + 120000, state: 'active' }],
      refusals: [{ changeId: 'x', requesterId: 'agent-c', keys: ['fn:retry'], createdAt: Date.now(), conflicts: [{ holderId: 'agent-a', intentText: 'Protect retry path', expiresAt: Date.now() + 120000 }] }] },
    queue: { entries: [
      { changeId: 'y', state: 'blocked', revision: 1, sequence: 41, blockedReason: 'CHECK_FAILED' },
      { changeId: 'landed-id', state: 'landed', admittedRevision: 2, sequence: 42, blockedReason: null },
      { changeId: 'withdrawn-id', state: 'withdrawn', admittedRevision: 3, sequence: 43, blockedReason: 'author request' },
    ], diagnosis: { reason: 'SINGLETON', blame: ['y'] }, observedMain: 'main123',
      activeStackJobId: 'job-2', stackMembers: ['x', 'y'], diagnosticResults: [{ jobId: 'job-1', memberIds: ['x', 'y'], outcome: 'FAIL', sequence: 4 }] },
    issues: { items: [{ number: 1, title: '<task>', state: 'open', milestoneId: 'm1', changes: [{ changeId: 'x', status: 'ready' }] }], milestones: [{ milestoneId: 'm1', title: 'Release' }] },
    findings: { findingSetVersions: { x: 0 }, findings: [
      { findingId: 'f1', changeId: 'x', status: 'open', unitKey: 'fn:retry', originRevision: 1, text: 'Retry evidence needs repair' },
    ], rounds: [] },
    runners: { items: [{ runnerId: 'checker-1', role: 'checker', state: 'idle', lastSeenAt: 1700000000000, activeJobId: null }] },
  } },
  version: 7, eventSeq: 0,
};

describe('Repository code page', () => {
  it('uses the queue observed main after a landing when the repo projection is stale', async () => {
    const dom = new JSDOM('<main id="page"></main>');
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const calls: string[] = [];
      const current = structuredClone(fixture) as any;
      current.data.projections.repos.repo.observedCanonicalOid = null;
      current.data.projections.queue.observedMain = 'b'.repeat(40);
      const page = createRepoPage(dom.window.document.getElementById('page'), {
        getRepoTree: async (_repo: string, _path: string, oid: string) => { calls.push(oid); return { data: { oid: 'b'.repeat(40), entries: [] } }; },
        getRepoReadme: async () => ({ data: { content: '# Main' } }),
        getRepoFile: async () => { throw { status: 404 }; },
      });
      page.show('sample', current);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls).toEqual(['b'.repeat(40), 'b'.repeat(40)]);
      expect(dom.window.document.getElementById('page')?.textContent).toContain('Main');
    } finally { globalThis.document = previous; }
  });
  it('renders human files and claims, switches to exact agent context and opens docs', async () => {
    const dom = new JSDOM('<main id="page"></main>', { url: 'http://localhost/' });
    const previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('page')!;
      const snapshot = structuredClone(fixture) as any;
      snapshot.data.projections.repos.repo.observedCanonicalOid = 'a'.repeat(40);
      snapshot.data.projections.leases.heldItems = [
        { unitKey: 'file:docs/guide.md', state: 'active', holderId: 'worker', expiresAt: Date.now() + 60000 },
        { unitKey: 'row:guides:one', state: 'reserved', holderId: 'worker-2', expiresAt: Date.now() + 60000 },
      ];
      const api = {
        getRepoTree: async (_repo: string, path: string) => ({ data: { entries: path === '' ? [{ name: 'docs', type: 'tree' }, { name: 'README.md', type: 'blob' }] : path === 'docs' ? [{ name: 'guide.md', type: 'blob' }] : [{ name: 'rules.md', type: 'blob' }], unitFiles: { 'file:docs/guide.md': 'docs/guide.md' }, rowTables: { guides: 'docs/guide.md' } } }),
        getRepoReadme: async () => ({ data: { path: 'README.md', content: '# Welcome\n<script>alert(1)</script>' } }),
        getRepoFile: async (_repo: string, path: string) => ({ data: { path, content: path === 'AGENTS.md' ? 'Follow rules' : 'Agent or guide content' } }),
      };
      const page = createRepoPage(root, api);
      page.show('sample', snapshot);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(root.textContent).toContain('README.md');
      expect(root.textContent).toContain('Welcome');
      expect(root.querySelector('script')).toBeNull();
      const docs = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('docs/'))! as HTMLButtonElement;
      docs.click(); await new Promise(resolve => setTimeout(resolve, 0));
      expect(root.textContent).toContain('2 claimed');
      const agents = [...root.querySelectorAll('button')].find(button => button.textContent === 'For agents')! as HTMLButtonElement;
      agents.click();
      expect(agents.isConnected).toBe(false);
      expect(root.textContent).toContain('AGENTS.md');
      expect(root.textContent).toContain('agents/rules.md');
      expect(root.querySelector('pre')?.textContent).toBe(JSON.stringify(snapshot, null, 2));
      const docButton = [...root.querySelectorAll('button')].find(button => button.textContent === 'AGENTS.md')! as HTMLButtonElement;
      docButton.click();
      expect(root.textContent).toContain('Follow rules');
    } finally { globalThis.document = previous; }
  });
  it('redacts credential-shaped strings in the agent context like the MCP output filter', async () => {
    const dom = new JSDOM('<main id="page"></main>', { url: 'http://localhost/' });
    const previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('page')!;
      const snapshot = structuredClone(fixture) as any;
      snapshot.data.projections.repos.repo.observedCanonicalOid = 'a'.repeat(40);
      snapshot.data.projections.repos.repo.remote = 'Bearer sample-token';
      const api = {
        getRepoTree: async () => ({ data: { entries: [] } }),
        getRepoReadme: async () => { throw { status: 404 }; },
        getRepoFile: async () => { throw { status: 404 }; },
      };
      const page = createRepoPage(root, api);
      page.show('sample', snapshot);
      await new Promise(resolve => setTimeout(resolve, 0));
      ([...root.querySelectorAll('button')].find(button => button.textContent === 'For agents') as HTMLButtonElement).click();
      const shown = root.querySelector('pre')?.textContent ?? '';
      expect(shown).toContain('[REDACTED]');
      expect(shown).not.toContain('sample-token');
    } finally { globalThis.document = previous; }
  });
  it('shows empty main and read errors without inventing files', async () => {
    const dom = new JSDOM('<main id="page"></main>');
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('page')!;
      const page = createRepoPage(root, { getRepoTree: async () => { throw { status: 403 }; }, getRepoReadme: async () => { throw { status: 404 }; }, getRepoFile: async () => { throw { status: 404 }; } });
      page.show(null, null);
      expect(root.textContent).toContain('Choose a repository');
      page.show('empty', { data: { projections: { repos: { repo: { observedCanonicalOid: null } } } } });
      expect(root.textContent).toContain('Canonical main has no files yet');
      page.show('full', { data: { projections: { repos: { repo: { observedCanonicalOid: 'a'.repeat(40) } } } } });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(root.textContent).toContain('Your token cannot read this repository');
    } finally { globalThis.document = previous; }
  });
  it('distinguishes failed agent-doc reads from missing docs and readme errors from missing README', async () => {
    const snapshot = structuredClone(fixture) as any;
    snapshot.data.projections.repos.repo.observedCanonicalOid = 'a'.repeat(40);
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const forAgents = (root: any) => ([...root.querySelectorAll('button')].find((b: any) => b.textContent === 'For agents') as HTMLButtonElement).click();
    const previous = globalThis.document;
    const failingDom = new JSDOM('<main id="page"></main>');
    globalThis.document = failingDom.window.document;
    try {
      const root = failingDom.window.document.getElementById('page')!;
      const failing = {
        getRepoTree: async (_repo: string, path: string) => {
          if (path === 'agents') throw { status: 503 };
          return { data: { entries: [] } };
        },
        getRepoReadme: async () => { throw { status: 503 }; },
        getRepoFile: async () => { throw { status: 404 }; },
      };
      const page = createRepoPage(root, failing);
      page.show('sample', snapshot);
      await settle();
      expect(root.textContent).toContain('Could not load');
      expect(root.textContent).not.toContain('README.md is unavailable');
      forAgents(root);
      expect(root.textContent).toContain('Could not load');
      expect(root.textContent).not.toContain('No agent docs');
    } finally { globalThis.document = previous; }
    const missingDom = new JSDOM('<main id="page"></main>');
    globalThis.document = missingDom.window.document;
    try {
      const root = missingDom.window.document.getElementById('page')!;
      const missing = {
        getRepoTree: async () => { throw { status: 404 }; },
        getRepoReadme: async () => { throw { status: 404 }; },
        getRepoFile: async () => { throw { status: 404 }; },
      };
      const page = createRepoPage(root, missing);
      page.show('sample', snapshot);
      await settle();
      expect(root.textContent).toContain('README.md is unavailable');
      expect(root.textContent).not.toContain('Could not load');
      forAgents(root);
      expect(root.textContent).toContain('not present');
      expect(root.textContent).not.toContain('Could not load');
    } finally { globalThis.document = previous; }
  });
  it('loads canonical main when the fresh snapshot OID is null', async () => {
    const dom = new JSDOM('<main id="page"></main>');
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('page')!;
      const requested: Array<[string, string | null]> = [];
      const page = createRepoPage(root, {
        getRepoTree: async (_repo: string, path: string, oid: string | null) => {
          requested.push([path, oid]);
          return { data: { oid: 'c'.repeat(40), entries: path ? [] : [{ name: 'README.md', type: 'blob' }] } };
        },
        getRepoReadme: async (_repo: string, oid: string | null) => { requested.push(['readme', oid]); return { data: { oid: 'c'.repeat(40), content: '# Fresh main' } }; },
        getRepoFile: async () => { throw { status: 404 }; },
      });
      const snapshot = structuredClone(fixture) as any;
      snapshot.data.projections.repos.repo.observedCanonicalOid = null;
      snapshot.data.projections.queue.observedMain = null;
      page.show('fresh', snapshot);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(requested.find(([path]) => path === '')?.[1]).toBe(null);
      expect(requested.find(([path]) => path === 'readme')?.[1]).toBe('c'.repeat(40));
      expect(root.textContent).toContain('Fresh main');
    } finally { globalThis.document = previous; }
  });
  it('keeps the resolved OID and open directory when a later snapshot still has a null OID', async () => {
    const dom = new JSDOM('<main id="page"></main>');
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('page')!;
      const requests: Array<{ path: string; oid: string | null }> = [];
      const resolvedOid = 'f'.repeat(40);
      const page = createRepoPage(root, {
        getRepoTree: async (_repo: string, path: string, oid: string | null) => {
          requests.push({ path, oid });
          return { data: { oid: resolvedOid, entries: path === '' ? [{ name: 'docs', type: 'tree' }] : [] } };
        },
        getRepoReadme: async () => ({ data: { oid: resolvedOid, content: '# Main' } }),
        getRepoFile: async () => { throw { status: 404 }; },
      });
      const snapshot = structuredClone(fixture) as any;
      snapshot.version = 1;
      snapshot.data.projections.queue.observedMain = null;
      snapshot.data.projections.repos.repo.observedCanonicalOid = null;
      page.show('steady-repo', snapshot);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(requests).toContainEqual({ path: '', oid: null });
      const docs = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('docs/'))! as HTMLButtonElement;
      docs.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(requests).toContainEqual({ path: 'docs', oid: resolvedOid });
      const requestCount = requests.length;
      const refreshed = structuredClone(snapshot);
      refreshed.version = 2;
      page.show('steady-repo', refreshed);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(requests).toHaveLength(requestCount);
      expect(root.textContent).toContain('steady-repo/docs');
      expect(root.textContent).toContain(resolvedOid.slice(0, 7));
    } finally { globalThis.document = previous; }
  });
  it('caps agent document discovery at 20 and concurrent reads at four, showing read error codes', async () => {
    const dom = new JSDOM('<main id="page"></main>');
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('page')!;
      const names = Array.from({ length: 30 }, (_, i) => ({ name: `doc-${i}.md`, type: 'blob' }));
      let active = 0, maximum = 0, agentReads = 0, completedReads = 0;
      let finishReads!: () => void;
      const allReadsComplete = new Promise<void>(resolve => { finishReads = resolve; });
      const api = {
        getRepoTree: async (_repo: string, path: string) => ({ data: { oid: 'd'.repeat(40), entries: path === 'agents' ? names : [] } }),
        getRepoReadme: async () => { throw { status: 404 }; },
        getRepoFile: async (_repo: string, path: string) => {
          if (path !== 'AGENTS.md') {
            agentReads++; active++; maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 1)); active--; completedReads++;
            if (completedReads === 20) finishReads();
          }
          throw path === 'AGENTS.md' ? { status: 503, code: 'AGENTS_UNAVAILABLE' } : { status: 404 };
        },
      };
      const page = createRepoPage(root, api);
      page.show('many-docs', fixture);
      let readTimeout!: ReturnType<typeof setTimeout>;
      const readTimeoutElapsed = new Promise<never>((_, reject) => { readTimeout = setTimeout(() => reject(new Error('agent document reads did not finish')), 1000); });
      try { await Promise.race([allReadsComplete, readTimeoutElapsed]); }
      finally { clearTimeout(readTimeout); }
      const toggle = [...root.querySelectorAll('button')].find(button => button.textContent === 'For agents')! as HTMLButtonElement;
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      toggle.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(agentReads).toBe(20);
      expect(maximum).toBeLessThanOrEqual(4);
      expect(root.textContent).toContain('Could not load (AGENTS_UNAVAILABLE)');
      expect(root.textContent).not.toContain('Exactly what an agent gets');
      expect(root.querySelector('[aria-pressed="true"]')?.textContent).toBe('For agents');
    } finally { globalThis.document = previous; }
  });
  it('shows a missing AGENTS.md as not present and redacts plain and encoded Bearer values', async () => {
    const dom = new JSDOM('<main id="page"></main>');
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('page')!;
      const snapshot = structuredClone(fixture) as any;
      snapshot.data.projections.repos.repo.remote = 'Bearer x / Bearer%20x';
      const page = createRepoPage(root, {
        getRepoTree: async () => ({ data: { oid: 'e'.repeat(40), entries: [] } }),
        getRepoReadme: async () => { throw { status: 404 }; },
        getRepoFile: async () => { throw { status: 404 }; },
      });
      page.show('missing-agents', snapshot);
      await new Promise(resolve => setTimeout(resolve, 0));
      [...root.querySelectorAll('button')].find(button => button.textContent === 'For agents')!.click();
      expect(root.textContent).toContain('AGENTS.md');
      expect(root.textContent).toContain('not present');
      const json = root.querySelector('pre')?.textContent ?? '';
      expect(json).toContain('[REDACTED]');
      expect(json).not.toContain('Bearer x');
      expect(json).not.toContain('Bearer%20x');
    } finally { globalThis.document = previous; }
  });
  it('uses missing status rather than document text to label AGENTS.md', async () => {
    const dom = new JSDOM('<main id="page"></main>');
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('page')!;
      let agentsContent: string | null = 'not present';
      const page = createRepoPage(root, {
        getRepoTree: async () => ({ data: { oid: 'f'.repeat(40), entries: [] } }),
        getRepoReadme: async () => { throw { status: 404 }; },
        getRepoFile: async (_repo: string, path: string) => {
          if (path !== 'AGENTS.md' || agentsContent === null) throw { status: 404 };
          return { data: { path, content: agentsContent } };
        },
      });
      const snapshot = structuredClone(fixture) as any;
      snapshot.data.projections.repos.repo.observedCanonicalOid = 'f'.repeat(40);
      page.show('agent-doc-label', snapshot);
      await new Promise(resolve => setTimeout(resolve, 0));
      const toggle = [...root.querySelectorAll('button')].find(button => button.textContent === 'For agents')! as HTMLButtonElement;
      toggle.click();
      const badge = root.querySelector('.repo-doc-list li span')!;
      expect(badge.textContent).toMatch(/estimated tokens/);
      expect(badge.textContent).not.toBe('not present');

      page.hide();
      agentsContent = null;
      page.show('agent-doc-label', snapshot);
      await new Promise(resolve => setTimeout(resolve, 0));
      [...root.querySelectorAll('button')].find(button => button.textContent === 'For agents')!.click();
      expect(root.querySelector('.repo-doc-list li span')?.textContent).toBe('not present');
    } finally { globalThis.document = previous; }
  });
});
