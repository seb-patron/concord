import { ConcordError } from './client.ts';
import { git, validateRemote } from './git.ts';

/** Server change records carry full refs; fetchFork accepts their short branch names. */
export function candidateBranchName(ref: string): string {
  if (!ref.startsWith('refs/heads/') || ref.slice('refs/heads/'.length).split('/').some(segment =>
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) || segment.includes('..') || segment.endsWith('.') || segment.endsWith('.lock'))) {
    throw new ConcordError('Server supplied an invalid candidate branch', 'server');
  }
  return ref.slice('refs/heads/'.length);
}

/** Anchor a published revision locally and expose its commit in a detached worktree. */
export async function checkoutPublishedRevision(worktree: string, remote: string, token: string, changeId: string, revision: number, headOid: string): Promise<void> {
  validateRemote(remote);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(changeId) || !Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{40}$/i.test(headOid)) {
    throw new ConcordError('Published revision identity is invalid', 'server');
  }
  const ref = `refs/remotes/concord/revisions/${changeId}/${revision}`;
  const object = await git(['rev-parse', '--verify', `${headOid}^{commit}`], {}, worktree).catch(() => null);
  if (object !== headOid.toLowerCase()) {
    await git(['fetch', '--no-tags', '--', remote, `${headOid}:${ref}`], { token }, worktree)
      .catch(() => { throw new ConcordError(`Published head ${headOid} is not available from the candidate fork`, 'server'); });
  } else {
    await git(['update-ref', ref, headOid], {}, worktree);
  }
  if (await git(['rev-parse', '--verify', `${ref}^{commit}`], {}, worktree) !== headOid.toLowerCase()) {
    throw new ConcordError(`Published head ${headOid} is not available from the candidate fork`, 'server');
  }
  await git(['switch', '--detach', ref], {}, worktree);
}
