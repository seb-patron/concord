# Import an existing Git repository

An owner can adopt one source commit as a new Concord repository. Import reads the
committed tree at `--ref`; it does not read the worktree, copy Git history, or
send excluded blobs to the seed fork. The resulting canonical `main` begins
with one root commit. Use a new Concord repo name and a trusted policy/profile
that can validate the imported tree. The checker and promoter runners must be
operating for that policy/profile before canonical `main` can be observed.

```sh
npm run concord -- import --source ./existing-repo --ref main --repo adopted \
  --policy-id POLICY_ID --profile-id PROFILE_ID \
  --exclude 'private/**' --exclude '**/.env' --exclude-file ./import-excludes.txt
```

Exclusions match normalized, repository-relative Git paths. Supported glob
operators are `*` (within one path component), `?` (one character), and
`**` (across path components); `**/` also matches zero directories. A trailing
`/` excludes a directory and everything below it. The exclude file contains
one glob per line; blank lines and lines beginning with `#` are ignored.
An unreadable file or unsupported glob is an error. The command refuses any
symlink or submodule in the source commit, including one under an excluded path.
It verifies the completed tree against the selected paths before contacting
Concord. Git paths are never printed merely because they were excluded.

```sh
npm run concord -- import --source ./existing-repo --ref main --repo adopted \
  --exclude 'private/**' --print-tree
```

`--print-tree` needs no API connection. It prints the included file count,
included total bytes, excluded path count, and prospective root tree OID.
`--verbose` also prints excluded path names; use it only where those names
can be disclosed.

The root commit message records the source repository directory basename,
source ref, and full source commit SHA. Repeating the same import reconciles
the existing seed draft or reports the existing canonical OID. A different
canonical OID is a conflict. Import uses the owner seed draft, fork write
token, branch registration, and bootstrap routes; Git credentials are passed
through the child process environment and never placed in a remote URL.
The command waits for canonical `main` and prints its OID. If it times out,
check the checker/promoter runners and repeat the same command.

After canonical `main` is confirmed, an owner may authorize the one-way
mirror described in [Deployment](deploy.md). For an adopted repository, its
GitHub destination must be a **new empty repository**: the imported root
commit has different history from the source. The mirror checks the
destination is absent or an ancestor, never force pushes, and never syncs
changes back into Concord.
