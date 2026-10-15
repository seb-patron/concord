import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;

function mobileBlocks(css: string) {
  const blocks: string[] = [];
  const media = /@media\s*\(\s*max-width\s*:\s*767px\s*\)\s*\{/g;
  for (let match; (match = media.exec(css));) {
    let depth = 1;
    let end = media.lastIndex;
    while (depth && end < css.length) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') depth--;
      end++;
    }
    blocks.push(css.slice(media.lastIndex, end - 1));
    media.lastIndex = end;
  }
  return blocks;
}

function rules(block: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...block.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
    .map(([, body]) => Object.fromEntries((body ?? '').split(';').map(part => part.trim().split(/:\s*/, 2)).filter(([key, value]) => key && value)));
}

describe('phone header layout', () => {
  it('keeps the header on one row, bounds the profile sheet, and scrolls nav tabs inside the nav', () => {
    const css = readFileSync(new URL('../../web/styles.css', import.meta.url), 'utf8');
    const blocks = mobileBlocks(css);
    expect(blocks.length).toBeGreaterThan(0);

    const profileRules = blocks.flatMap(block => rules(block, '.profile-menu'));
    expect(profileRules.at(-1)).toMatchObject({ position: 'fixed', left: '16px', right: '16px' });
    expect(profileRules.at(-1)?.['max-height']).toBeTruthy();
    expect(profileRules.at(-1)?.['overflow-y']).toBe('auto');

    const topbarRules = blocks.flatMap(block => rules(block, '.topbar'));
    expect(topbarRules.at(-1)?.['flex-wrap']).toBe('nowrap');
    expect(blocks.flatMap(block => rules(block, '.topbar .repo-link')).at(-1)).toMatchObject({
      'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis',
    });

    const navRules = blocks.flatMap(block => rules(block, '.main-nav'));
    expect(navRules.at(-1)).toMatchObject({ 'overflow-x': 'auto', 'flex-wrap': 'nowrap' });
  });

  it('closes the profile menu after an outside click and Escape', async () => {
    const dom = new JSDOM(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/' });
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    Object.assign(globalThis, { document: dom.window.document, window: dom.window });
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.scrollTo = () => {};
    dom.window.setInterval = (() => 1) as any;
    globalThis.fetch = (async (url: string) => {
      if (url === '/health') return Response.json({ data: { accessSignIn: true } });
      if (url === '/v1/session') return Response.json({ data: { principalId: 'phone-owner', roles: ['owner'], authMethod: 'access', expiresAt: Date.now() + 60_000 } });
      if (url === '/v1/me') return Response.json({ data: { principalId: 'phone-owner', roles: ['owner'], repoIds: '*' } });
      if (url === '/v1/repos') return Response.json({ data: { items: [{ repoId: 'phone-repo' }] } });
      if (url === '/v1/repos/phone-repo/snapshot') return Response.json({ data: { projections: {} }, version: 0, eventSeq: 0 });
      if (url.startsWith('/v1/repos/phone-repo/events')) return Response.json({ data: { items: [] }, version: 0, eventSeq: 0 });
      if (url.startsWith('/v1/repos/phone-repo/metrics')) return new Response('', { status: 404 });
      return Response.json({ data: { mode: 'production', storageBackend: 'artifacts' } });
    }) as any;
    try {
      // @ts-expect-error Browser JS is intentionally untyped.
      await import('../../web/app.js?mobile-profile-menu');
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
      const doc = dom.window.document;
      const toggle = doc.getElementById('profile-toggle') as HTMLButtonElement;
      const menu = doc.getElementById('profile-menu')!;
      toggle.click();
      expect(menu.hidden).toBe(false);
      doc.getElementById('signed-out')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      expect(menu.hidden).toBe(true);

      toggle.click();
      expect(menu.hidden).toBe(false);
      doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(menu.hidden).toBe(true);
    } finally {
      Object.assign(globalThis, previous);
      dom.window.close();
    }
  });
});
