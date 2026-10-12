/** Byte-preserving section boundaries for owner-declared Markdown documents. */
export interface MarkdownSection { slug: string; heading: string | null; content: string; structure: string[] }

export function headingSlug(text: string): string {
  return text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '')
    .trim().replace(/\s+/g, '-');
}

export function parseMarkdown(text: string, level: number): MarkdownSection[] | null {
  if (text.includes('\r') || level < 1 || level > 6) return null;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const sections: MarkdownSection[] = [{ slug: '_preamble', heading: null, content: '', structure: [] }];
  const seen = new Map<string, number>();
  let start = 0;
  let fence: { marker: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\n$/, '');
    const matchFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (matchFence) {
      const marker = matchFence[1][0];
      if (!fence && (marker !== '`' || !matchFence[2].includes('`'))) fence = { marker, length: matchFence[1].length };
      else if (fence && marker === fence.marker && matchFence[1].length >= fence.length && !matchFence[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
    const setext = i > 0 && /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    const isSetext = !!setext && (setext[1][0] === '=' ? level === 1 : level === 2) &&
      !!lines[i - 1].trim() && !/^ {0,3}(?:[#>`*+-]|\d+[.)] )/.test(lines[i - 1]);
    if ((!atx || atx[1].length !== level) && !isSetext) {
      if (atx || setext) sections[sections.length - 1].structure.push(setext ? lines[i - 1].trim() + '\n' + line : line);
      continue;
    }
    const headingIndex = isSetext ? i - 1 : i;
    const heading = isSetext ? lines[i - 1].trim() : atx![2].replace(/[ \t]+#+[ \t]*$/, '').trim();
    const slug = headingSlug(heading);
    if (!slug || slug === '_preamble') return null;
    sections[sections.length - 1].content = lines.slice(start, headingIndex).join('');
    const ordinal = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, ordinal);
    sections.push({ slug: ordinal === 1 ? slug : `${slug}-${ordinal}`, heading, content: '', structure: [] });
    start = headingIndex;
  }
  sections[sections.length - 1].content = lines.slice(start).join('');
  if (new Set(sections.map(item => item.slug)).size !== sections.length) return null;
  return sections;
}

/** Existing headings must retain their identity and order; only new headings may be inserted. */
export function compatibleSections(base: MarkdownSection[], next: MarkdownSection[]): boolean {
  const baseline = new Map(base.map(item => [item.slug, item]));
  for (const item of next) {
    const old = baseline.get(item.slug);
    if (old && JSON.stringify(old.structure) !== JSON.stringify(item.structure)) return false;
  }
  const old = base.filter(item => item.heading !== null);
  const current = next.filter(item => item.heading !== null);
  let at = 0;
  for (const section of current) {
    if (section.slug === old[at]?.slug && section.heading === old[at]?.heading) at++;
    else if (old.some(item => item.slug === section.slug)) return false;
  }
  return at === old.length;
}

export function mergeMarkdown(base: string, ours: string, theirs: string, level: number): string {
  const b = parseMarkdown(base, level), o = parseMarkdown(ours, level), t = parseMarkdown(theirs, level);
  if (!b || !o || !t || !compatibleSections(b, o) || !compatibleSections(b, t)) throw new Error('MARKDOWN_STRUCTURE_CONFLICT');
  const before = new Map(b.map(item => [item.slug, item.content]));
  const left = new Map(o.map(item => [item.slug, item.content]));
  const right = new Map(t.map(item => [item.slug, item.content]));
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    if (left.get(key) !== before.get(key) && right.get(key) !== before.get(key)) throw new Error('MARKDOWN_SECTION_CONFLICT:' + key);
  }
  const output: string[] = [];
  const inserted = new Set<string>();
  const emitNew = (sections: MarkdownSection[], preceding: string) => {
    let anchor = '_preamble';
    for (const section of sections.slice(1)) {
      if (before.has(section.slug)) anchor = section.slug;
      else if (anchor === preceding && !inserted.has(section.slug)) {
        output.push(section.content);
        inserted.add(section.slug);
      }
    }
  };
  for (const section of b) {
    output.push(right.get(section.slug) !== section.content ? right.get(section.slug)! : left.get(section.slug)!);
    emitNew(o, section.slug);
    emitNew(t, section.slug);
  }
  return output.join('');
}
