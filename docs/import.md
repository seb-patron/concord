# Import an existing Git repository

An owner can adopt a source branch as a new Concord repository. By default,
import reads the committed tree at `--ref`; it does not read the worktree,
copy Git history, or send excluded blobs to the seed fork. The resulting
canonical `main` begins with one new root commit. Use this mode when you need
to exclude committed paths or intentionally start fresh history. Use a new
Concord repo name and a trusted policy/profile
that can validate the imported tree. The checker and promoter runners must be
operating for that policy/profile before canonical `main` can be observed.

```sh
npm run concord -- import --source ./existing-repo --ref main --repo adopted \
  --policy-id POLICY_ID --profile-id PROFILE_ID \
  --exclude 'private/**' --exclude '**/.env' --exclude-file ./import-excludes.txt
```

To preserve the source branch's exact commit OID and all its ancestors, use
`--with-history`:

```sh
npm run concord -- import --source ./existing-repo --ref main --repo adopted \
  --policy-id POLICY_ID --profile-id PROFILE_ID --with-history
```

Use history mode when a destination such as GitHub already has an ancestor of
the source branch and later mirrors must fast-forward. This copies **all Git
history reachable from the source commit**, including old versions of files,
deleted files, and blobs that may contain private data. `--with-history`
rejects `--exclude` and `--exclude-file`; exclusions cannot remove data from
past commits. Inspect the source history before using this mode.

`--source` must name the Git repository top level. Exclusions match normalized,
repository-relative Git paths. Supported glob operators are `*` (within one
path component), `?` (one character), and
`**` (across path components); `**/` also matches zero directories. A trailing
`/` excludes a directory and everything below it. The exclude file contains
one glob per line; blank lines and lines beginning with `#` are ignored.
An unreadable file, malformed UTF-8, empty glob, or unsupported glob is an error.
Patterns that match no committed path appear in `unmatchedPatterns` in the
result. Add `--require-match` to make any such pattern an error. The command
refuses any symlink or submodule in the source commit, including one under an
excluded path.
It verifies the completed tree against the selected paths before contacting
Concord. Git paths are never printed merely because they were excluded.
Import disables Git's lazy fetching. A partial clone must already have the
source commit and selected tree's blobs locally. With `--with-history`, all
commits, trees, and blobs reachable from that commit must also be local.
Shallow repositories are rejected in history mode; fetch complete history
before importing. Import checks for shallow history and unavailable objects
before contacting Concord. Import does not change source objects, index, or refs.

```sh
npm run concord -- import --source ./existing-repo --ref main --repo adopted \
  --exclude 'private/**' --print-tree
```

`--print-tree` needs no API connection. It prints the included file count,
included total bytes, excluded path count, and prospective head tree OID.
It also reports patterns that matched no path.
`--verbose` also prints excluded path names; use it only where those names
can be disclosed.

In default mode, the root commit message records the source repository directory basename,
source ref, and full source commit SHA. History mode retains the source commit
and its original message unchanged. Repeating the same import reconciles
the existing seed draft or reports the existing canonical OID. A different
canonical OID is a conflict. Import uses the owner seed draft, fork write
token, branch registration, and bootstrap routes; Git credentials are passed
through the child process environment and never placed in a remote URL.
When a pending bootstrap is blocked by `PROFILE_CHANGED` or `INVALID_JOB`,
import prints that reason and repeats the same owner bootstrap request. The
server cancels the stale job, pins the current trusted policy and profile,
and schedules a new validation job using the existing scratch repository.
Re-pinning is refused while a runner holds a live claim or after canonical
`main` exists. The repository detail endpoint exposes the pending state and
blocked reason.
The command waits for canonical `main` and prints its OID. If it times out,
the timeout includes the last blocked reason; check the checker/promoter
runners and repeat the same command.

After canonical `main` is confirmed, an owner may authorize the one-way
mirror described in [Deployment](deploy.md). For an adopted repository, its
GitHub destination must be a **new empty repository** for a default import:
the imported root commit has different history from the source. With history
mode, a destination already at an ancestor of the source can fast-forward.
The mirror checks the
destination is absent or an ancestor, never force pushes, and never syncs
changes back into Concord.
