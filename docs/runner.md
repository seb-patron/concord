# Local runner

The runner is an outbound client for one repository. Run separate processes and credentials for checker and promoter roles. It handles one claimed job at a time. The coordinator issues a 60-second claim, and the client renews it every 20 seconds. A crash leaves the job recoverable: the coordinator expires the claim, increases its attempt and fence, and stops after three attempts. Results from an expired fence return 409; retry a lost result response with the identical body and idempotency key.

The command checker executes code from the composed repository. Run checker workers only on a trusted, isolated machine or container with no valuable host files or credentials accessible to that code. The environment allowlist and credential filtering reduce accidental exposure; they are not an OS sandbox and do not make an untrusted checkout safe on an ordinary workstation.

## Configuration

Set `CONCORD_URL` and a role-specific `CONCORD_TOKEN` in the runner supervisor. Never place either token in a candidate checkout. The checker needs an absolute owner-owned JSON profile path. The promoter uses only the profile digest; it does not load a checker profile or execute source. Install native Git and Node 22 or newer.

An owner profile records:

- `id`, `digest`, `checkerId`, `checkerDigest`, `oracleDigest`, `toolchainDigest`, and `environmentDigest`.
- `timeoutMs` from 1 to 2,100,000 (35 minutes), and `maxOutputBytes` from 1 to 16,384. The demo default is 120,000 ms.
- `toolchainFile`: absolute path to the pinned toolchain binary or marker. Its raw SHA-256 must equal `toolchainDigest`.
- For an ordinary checker: absolute `executable`, fixed `argv`, `checkerFile`, and `oracleFile`. The latter two files must hash to their declared digests. Optional `successOutcome` is `PASS` (default) or `MATCH`. Only `{repo}` and `{unit}` placeholders are substituted in argv. The executable is never selected by a candidate.
- For `kind: "command"`: set `checkerId` to an owner-installed ID other than `dispatch-lab`; set `executable` and `toolchainFile` to the same absolute path outside the checkout. Set both `checkerDigest` and `toolchainDigest` to the raw SHA-256 of that executable. Set `oracleDigest` to the canonical JSON digest of `{executable,argv,cwd,timeoutSeconds,env,outputCap}`. `cwd` must be `"repo"`; `argv` is a fixed string array without `{...}` job placeholders. `timeoutSeconds` is an integer from 1 through the profile's `timeoutMs` ceiling; `outputCap` is 4,096 through `maxOutputBytes`. `env` is an array of names only, chosen from `PATH`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `UV_CACHE_DIR`, `UV_PYTHON`, `UV_PROJECT_ENVIRONMENT`, and `XDG_CACHE_HOME`. Their values come from the runner supervisor, never the job or checkout. The checker runs on the inspected candidate, once for each configured composed-stack acceptance gate (at most 128), and for affected-unit delta checks. Exit code 0 within the timeout is `PASS`; every other exit or timeout is `FAIL`, with the exit code and capped output tail in the authenticated result. The runner reserves room for every completed check's exit marker before capping output bodies and fails closed if affected-unit markers cannot fit. A command profile cannot supply `cases`, `checkerFile`, `oracleFile`, or `successOutcome`.
- For `checkerId: "dispatch-lab"`: `cases` maps trusted case IDs to exact case-specific `rows` with `retry_limit`, `timeout_ms`, and `output`. `oracleDigest` is the canonical JSON SHA-256 of `cases`; `checkerDigest` is the raw SHA-256 of `runner/profiles.ts`; `toolchainFile` and `executable` must be the running Node binary. Set `argv` to the exported `dispatchArgv` constant from that module. Only the `j-common` case may add `epsilonChoices`, exactly `(2,500,1000)` and `(2,1000,2000)`. The runner invokes the candidate's `dispatch.mjs` and compares its actual outputs and TSV cells to this matrix. Unknown case IDs fail closed.

The dispatch profile must include the reviewed `seed`, `a-only`, `b-only`, `c-only`, `a-b`, `a-c-survivors`, `b-c`, `a-b-c`, `b-repaired`, `d-only`, `e-only`, `d-e`, `h-only`, `i-only`, `j-common`, `aw-only`, and seven `rows-*` cases with exactly the literal row tuples in `runner/profiles.ts`. The B-containing cases pin the valid gamma row from their base; B's invalid zero-valued gamma row fails schema validation. The later cases represent D before E, E before carried D, carried D after E, H before I, and I after H is invalidated. Both J children use `j-common`. A profile with a missing case, altered output, or unreviewed case ID is rejected even when its own profile and oracle digests are internally consistent. The executable and in-range alpha changes in the negative acceptance scene use `a-c-survivors` and must fail its hard gate.

`environmentDigest` is the canonical JSON SHA-256 of `{platform,arch,node}` from the local process. `digest` is the canonical JSON SHA-256 of the entire profile object with the `digest` field omitted. Canonical JSON recursively sorts object keys, as `src/http.ts` does. Install this same profile digest in the coordinator's trusted configuration. Keep profile, checker, oracle, and toolchain files outside candidate forks. A missing or changed local binary yields `ENV_ERROR` for a claimed job.

From the repository root, calculate the local environment and final profile digests with the same code the runner uses:

```sh
node --import tsx --input-type=module -e 'import { digest } from "./src/http.ts"; import { localEnvironment } from "./runner/profiles.ts"; console.log(await digest(localEnvironment()))'
node --import tsx --input-type=module -e 'import { readFileSync } from "node:fs"; import { digest } from "./src/http.ts"; const { digest: unused, ...profile } = JSON.parse(readFileSync(process.argv[1], "utf8")); console.log(await digest(profile))' "$PROFILE_FILE"
```

The second command verifies the value to place in the JSON `digest` field after the other fields are filled. Compute raw file SHA-256 digests for `checkerFile`, `oracleFile`, and `toolchainFile` separately; these are hashes of file bytes, not canonical JSON. The coordinator's trusted profile and policy pins must agree with this file.

For a command profile, compute the executable hash once for `checkerDigest` and `toolchainDigest`; compute `oracleDigest` from the six command fields before computing the whole-profile digest. The coordinator's trusted policy must use the same checker ID and digest, and its trusted profile must use the same profile, oracle, toolchain, environment, timeout, and output pins. For example, Concord itself can use the checked-out validation script:

```json
{
  "kind": "command", "checkerId": "concord-validation",
  "executable": "/bin/sh", "toolchainFile": "/bin/sh",
  "argv": ["scripts/validate.sh"], "cwd": "repo",
  "timeoutSeconds": 900, "env": ["PATH", "TMPDIR", "LANG"], "outputCap": 16384
}
```

A Python and uv repository can keep its own `scripts/validate.sh` in the checkout and use the same command profile shape, with `argv: ["scripts/validate.sh"]` and an allowlisted `PATH` (and optionally `UV_CACHE_DIR`). A sample script is:

```sh
#!/bin/sh
set -eu
uv run ruff check .
uv run pytest
```

In both examples, the runner invokes the pinned `/bin/sh` directly in the composed repository root; the script bytes come from that composed tree. Install the executable digest and all profile/job pins before scheduling work. The script may run arbitrary repository code, so use the isolated checker host described above.

For dispatch-lab, the stored job must carry a trusted `caseId` from the scenario plan. Both J children must use the same base and profile input, pass this exact hard gate, and only then may the queue compare their scores. The queue owns that cross-job decision. Candidate-edited TSV rows never supply expected values.

## Run

```sh
CONCORD_URL=http://127.0.0.1:8787 CONCORD_TOKEN="$CHECKER_TOKEN" npm run runner -- --repo "$REPO_ID" --role checker --profile "$PROFILE_FILE" --once
CONCORD_URL=http://127.0.0.1:8787 CONCORD_TOKEN="$PROMOTER_TOKEN" npm run runner -- --repo "$REPO_ID" --role promoter --profile-digest "$PROFILE_DIGEST" --once
```

On Windows PowerShell, set `$env:CONCORD_URL` and the role-specific `$env:CONCORD_TOKEN`, then run the same `npm run runner -- --repo ...` arguments. Use separate shells or clear the previous token before changing roles.

`--once` polls once and executes at most one job. For a bounded worker, use `--max-jobs N` and optionally `--idle-timeout-seconds N`. An idle timeout alone caps a process at 1,000 jobs; a zero idle timeout exits on an empty poll. `--runner-id` selects a stable opaque ID if required. Keep one process per runner ID.

The checker fetches exact input OIDs into a disposable Git directory. It inspects actual writes and review dependencies, composes ordered candidates, runs the pinned checker without a shell, and conditionally pushes only a green composed commit to its assigned scratch fork. Ordinary unresolved conflicts fail. The trusted TSV helper combines disjoint rows in any owner-declared table, preserves deletions, and rejects divergent changes to the same row. Delta checks recompute manifests and dependencies and report facts; only the verdict service may decide whether review carries.

At scheduling, `inputDigest` must equal the SHA-256 of canonical sorted JSON of the job with `inputDigest`, `state`, `attempt`, `fence`, `runnerId`, `expiresAt`, and `version` omitted. This binds results to the immutable job input across claims. A null-base inspection is accepted only for an owner-scheduled `SeedInput` whose seed fork's expected ref is pinned to its head OID.

The promoter fetches the checked scratch commit, confirms the scratch ref and ancestry, then uses Git `--force-with-lease` with an explicit expected old main OID. The bootstrap ticket is the sole exception: its expected old value is absent main. A lost push response is reconciled by reading main; an unrelated new value is reported as `OLD_REF` or `THIRD_REF`. No checker runs in promoter mode, and checker mode cannot request canonical write credentials.

Git runs with ambient global/system config and hooks disabled. The supervisor holds short-lived Git credentials; checker subprocesses receive a filtered environment with no Concord token. Published logs are capped at 16 KB and known credentials are redacted. A timeout kills the process group and the temporary work directory is removed when execution ends.

If a job is blocked after three expired attempts, inspect the job snapshot and events, repair the local runner or profile, and schedule a new authorized job through the owning feature. Do not edit queue state or force-push main manually.
