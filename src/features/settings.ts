import type { FeatureModule, ModuleContext, ReviewManifest } from '../contracts';
import { requireRole } from '../auth';
import { HttpError, json } from '../http';
import { eventSequence, sqlState } from '../state';

export type ProtectionLevel = 'agents' | 'human-approval' | 'human-only';
export interface ProtectedPath { pattern: string; level: ProtectionLevel; note?: string }
export interface RepoSettings { version: number; protectedPaths: ProtectedPath[] }

const key = 'module:settings:record';
export function repoSettings(context: ModuleContext): RepoSettings {
  return sqlState(context.sql).get<RepoSettings>(key) ?? { version: 0, protectedPaths: [] };
}

function expression(pattern: string): RegExp {
  if (!pattern || pattern.length > 512 || pattern.startsWith('/') || pattern.includes('\\') || pattern.includes('\0') ||
    pattern.split('/').some((part, index, parts) => (!part && index !== parts.length - 1) || part === '.' || part === '..') ||
    /[\[\]{}]/.test(pattern)) throw new HttpError(422, 'INVALID_PATTERN', 'Use normalized Git paths and *, **, or ?');
  const value = pattern.endsWith('/') ? pattern + '**' : pattern;
  let source = '^';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '*' && value[i + 1] === '*') {
      if (value[i + 2] === '/') { source += '(?:.*/)?'; i += 2; }
      else { source += '.*'; i++; }
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(source + '$');
}

function specificity(pattern: string): [number, number, number, number] {
  const value = pattern.endsWith('/') ? pattern + '**' : pattern;
  const wildcards = (value.match(/\*\*|\*|\?/g) ?? []).length;
  const literal = value.replace(/\*\*|\*|\?/g, '').length;
  return [wildcards === 0 ? 1 : 0, literal, -wildcards, value.length];
}

/** Exact paths win over any wildcard match; then longest literal scope, fewer wildcards, longer patterns. */
export function protectionFor(context: ModuleContext, path: string): ProtectedPath | null {
  const matches = repoSettings(context).protectedPaths.filter(rule => expression(rule.pattern).test(path));
  matches.sort((a, b) => {
    const left = specificity(a.pattern), right = specificity(b.pattern);
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return right[i] - left[i];
    return a.pattern.localeCompare(b.pattern);
  });
  return matches[0] ?? null;
}

export function matchingProtections(context: ModuleContext, manifest: ReviewManifest, level: ProtectionLevel): ProtectedPath[] {
  const found = new Map<string, ProtectedPath>();
  for (const unit of manifest.changedUnits) for (const path of [unit.beforePath, unit.afterPath]) {
    if (!path) continue;
    const rule = protectionFor(context, path);
    if (rule?.level === level) found.set(rule.pattern, rule);
  }
  return [...found.values()].sort((a, b) => a.pattern.localeCompare(b.pattern));
}

export const settings: FeatureModule = {
  name: 'settings', migrations: [],
  routes: [
    { method: 'GET', pattern: /^\/v1\/repos\/[^/]+\/settings$/, handle: context =>
      json(repoSettings(context), context.version(), eventSequence(context.sql)) },
    { method: 'PUT', pattern: /^\/v1\/repos\/[^/]+\/settings$/, handle: (context, _request, _match, raw) => {
      requireRole(context.principal, 'owner');
      const body = raw as { protectedPaths?: unknown } | null;
      if (!Array.isArray(body?.protectedPaths) || body.protectedPaths.length > 256) throw new HttpError(422, 'INVALID_SETTINGS', 'protectedPaths must be an array of at most 256 rules');
      const paths: ProtectedPath[] = [];
      const seen = new Set<string>();
      for (const item of body.protectedPaths) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(422, 'INVALID_SETTINGS', 'Invalid protected path');
        const rule = item as Record<string, unknown>;
        if (typeof rule.pattern !== 'string' || !['agents', 'human-approval', 'human-only'].includes(rule.level as string) ||
          rule.note !== undefined && (typeof rule.note !== 'string' || rule.note.length > 500) ||
          Object.keys(rule).some(field => !['pattern', 'level', 'note'].includes(field))) throw new HttpError(422, 'INVALID_SETTINGS', 'Invalid protected path');
        expression(rule.pattern);
        if (seen.has(rule.pattern)) throw new HttpError(422, 'DUPLICATE_PATTERN', 'Each pattern must appear once');
        seen.add(rule.pattern);
        paths.push({ pattern: rule.pattern, level: rule.level as ProtectionLevel, ...(rule.note === undefined ? {} : { note: rule.note as string }) });
      }
      return context.transaction(() => {
        const version = context.nextVersion();
        const record = { version, protectedPaths: paths };
        context.state.put('record', record);
        const event = context.appendEvent('settings.updated', [context.repoId], { protectedPaths: paths }, version);
        return json(record, version, event.sequence);
      });
    } },
  ],
  snapshot: context => repoSettings(context),
  nextDeadline: () => null,
  onAlarm: () => {},
  hooks: {},
};
