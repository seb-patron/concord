import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ConcordError, rememberCredential } from './client.ts';

export type ProfileCredential = { url: string; token: string; profileName: string };
type ProfileEntry = { url?: unknown; tokenFile?: unknown; tokenKey?: unknown };
type ProfileDocument = { default?: unknown; profiles?: Record<string, ProfileEntry> };

export function profileFilePath(): string {
  return process.env.CONCORD_CONFIG || join(homedir(), '.config', 'concord', 'profiles.json');
}

async function privateFile(path: string, profileName: string, missingCode: 'PROFILE_NOT_FOUND' | 'PROFILE_TOKEN_UNREADABLE'): Promise<string> {
  let handle;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    handle = await open(path, flags);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new ConcordError(`${missingCode}: profile ${profileName}`, 'usage');
    if ((metadata.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && metadata.uid !== process.getuid()))
      throw new ConcordError(`PROFILE_PERMISSIONS: profile ${profileName}`, 'usage');
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof ConcordError) throw error;
    throw new ConcordError(`${missingCode}: profile ${profileName}`, 'usage');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function loadProfile(name?: string): Promise<ProfileCredential> {
  const configPath = profileFilePath();
  let contents: string;
  contents = await privateFile(configPath, name ?? 'default', 'PROFILE_NOT_FOUND');
  let document: ProfileDocument;
  try { document = JSON.parse(contents) as ProfileDocument; }
  catch { throw new ConcordError(`PROFILE_NOT_FOUND: profile ${name ?? 'default'}`, 'usage'); }
  const selected = name ?? (typeof document.default === 'string' ? document.default : undefined);
  if (!selected || !document.profiles || typeof document.profiles !== 'object')
    throw new ConcordError(`PROFILE_NOT_FOUND: profile ${name ?? 'default'}`, 'usage');
  const entry = document.profiles[selected];
  if (!entry || typeof entry.url !== 'string' || typeof entry.tokenFile !== 'string')
    throw new ConcordError(`PROFILE_NOT_FOUND: profile ${selected}`, 'usage');
  if (!isAbsolute(entry.tokenFile)) throw new ConcordError(`PROFILE_TOKEN_UNREADABLE: profile ${selected}`, 'usage');
  const raw = await privateFile(entry.tokenFile, selected, 'PROFILE_TOKEN_UNREADABLE');
  let token: unknown = raw.trim();
  if (entry.tokenKey !== undefined) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      token = typeof entry.tokenKey === 'string' ? parsed?.[entry.tokenKey] : undefined;
    } catch { token = undefined; }
  } else if (raw.trimStart().startsWith('{')) {
    try { JSON.parse(raw); token = undefined; } catch { /* a plain token may begin with a brace */ }
  }
  if (typeof token !== 'string' || !token.trim()) throw new ConcordError(`PROFILE_TOKEN_UNREADABLE: profile ${selected}`, 'usage');
  const url = process.env.CONCORD_URL !== undefined ? process.env.CONCORD_URL : entry.url;
  try { new URL(url); } catch { throw new ConcordError(`PROFILE_NOT_FOUND: profile ${selected}`, 'usage'); }
  rememberCredential(token.trim());
  return { url, token: token.trim(), profileName: selected };
}

export async function resolveCredential(options: { profile?: string; tokenStdin?: string }): Promise<ProfileCredential> {
  const selected = options.profile ?? process.env.CONCORD_PROFILE;
  if (process.env.CONCORD_TOKEN) {
    const url = process.env.CONCORD_URL ?? (await loadProfile(selected)).url;
    if (!url) throw new ConcordError('CONCORD_URL is required', 'usage');
    rememberCredential(process.env.CONCORD_TOKEN);
    return { url, token: process.env.CONCORD_TOKEN, profileName: 'environment' };
  }
  if (options.tokenStdin !== undefined) {
    const url = process.env.CONCORD_URL ?? (await loadProfile(selected)).url;
    if (!url) throw new ConcordError('CONCORD_URL is required', 'usage');
    rememberCredential(options.tokenStdin);
    return { url, token: options.tokenStdin, profileName: selected ?? 'stdin' };
  }
  return loadProfile(selected);
}

export function reviewerProfileName(explicit?: string): string | undefined {
  return explicit ?? process.env.CONCORD_REVIEWER_PROFILE;
}

export function addProfileRejectionContext<T extends { request: (...args: any[]) => Promise<any> }>(client: T, profileName?: string): T {
  if (!profileName || profileName === 'environment' || profileName === 'stdin') return client;
  const request = client.request.bind(client);
  client.request = (async (...args: any[]) => {
    try { return await request(...args); }
    catch (error) {
      if (error instanceof ConcordError && error.status === 401) {
        const data = (error.payload as any)?.error ?? {};
        const code = typeof data.code === 'string' ? data.code : 'UNAUTHORIZED';
        if (code === 'CREDENTIAL_EXPIRED' || code === 'UNAUTHORIZED') {
          const details = data.details && typeof data.details === 'object' ? data.details : {};
          const safeFields = { ...data, ...details };
          const fields = ['principalId', 'expiresAt'].filter(key => safeFields[key] !== undefined)
            .map(key => `${key}=${String(safeFields[key])}`).join(' ');
          error.message = `credential for profile ${profileName} was rejected (${code})${fields ? ` ${fields}` : ''}`;
        }
      }
      throw error;
    }
  }) as T['request'];
  return client;
}
