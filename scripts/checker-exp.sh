#!/bin/sh
set -eu
set +x

usage() { echo "Usage: CHECKER_EXP_URL=... EXP_TOKEN=... $0 <40-or-64-hex-sha> | --status" >&2; exit 2; }
: "${CHECKER_EXP_URL:?Set CHECKER_EXP_URL to the experiment Worker URL}"
: "${EXP_TOKEN:?Set EXP_TOKEN to the experiment bearer secret}"

case "${1:-}" in
  --status) [ "$#" -eq 1 ] || usage ;;
  *)
    [ "$#" -eq 1 ] || usage
    case "$1" in *[!a-f0-9]*|'') usage ;; esac
    [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ] || usage
    ;;
esac

# Use Concord CLI's own read-token mint helper. Its repo-clone flow calls
# POST /v1/repos/:id/git-token with scope=read and a 300-second TTL.
EXP_BEARER="$EXP_TOKEN" CHECKER_SHA="${1:-}" node --import tsx --input-type=module <<'NODE'
import { ConcordClient } from './cli/client.ts';
import { mintGitToken } from './cli/git-token.ts';
import { resolveCredential } from './cli/profile.ts';

const url = process.env.CHECKER_EXP_URL;
const bearer = process.env.EXP_BEARER;
const headers = { authorization: `Bearer ${bearer}` };

async function showStatus() {
  const response = await fetch(`${url}/status`, { headers });
  const body = await response.text();
  process.stdout.write(`${body}\n`);
  if (!response.ok) process.exitCode = 1;
  try {
    const value = JSON.parse(body);
    console.log(`Running estimated total: $${Number(value.totalEstimatedCostUsd || 0).toFixed(6)}`);
  } catch { /* The response body above contains the server diagnostic. */ }
}

if (process.env.CHECKER_SHA === '--status') {
  await showStatus();
} else {
  const credential = await resolveCredential({});
  const client = new ConcordClient({ url: credential.url, token: credential.token });
  const repoResponse = await client.request('GET', '/repos/concord-v2') as Record<string, unknown>;
  const repo = (repoResponse.data && typeof repoResponse.data === 'object' ? repoResponse.data : repoResponse) as Record<string, unknown>;
  if (typeof repo.canonicalStorageName !== 'string' || !repo.canonicalStorageName) throw new Error('Concord did not return canonical storage metadata');
  const mintedResponse = await mintGitToken(client, {
    repoPath: '/repos/concord-v2', storageName: repo.canonicalStorageName, scope: 'read',
  }) as Record<string, unknown>;
  const minted = (mintedResponse.data && typeof mintedResponse.data === 'object' ? mintedResponse.data : mintedResponse) as Record<string, unknown>;
  const gitToken = minted.token ?? minted.plaintext;
  if (typeof gitToken !== 'string' || !gitToken) throw new Error('Concord did not return a read token');
  const response = await fetch(`${url}/run`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ repoUrl: 'https://github.com/seb-patron/concord-v2.git', sha: process.env.CHECKER_SHA, gitToken }),
  });
  process.stdout.write(`${await response.text()}\n`);
  await showStatus();
  if (!response.ok) process.exitCode = 1;
}
NODE
