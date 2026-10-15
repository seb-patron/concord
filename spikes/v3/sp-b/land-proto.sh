#!/usr/bin/env bash
set -euo pipefail

# Server-side Git landing spike. All mutations occur in a disposable bare repo.
ROOT=$(git rev-parse --show-toplevel)
SOURCE=${1:-$ROOT}
SCRATCH=${DELEGATE_SCRATCH_DIR:-${TMPDIR:-/tmp}}
RUN=$(mktemp -d "$SCRATCH/sp-b-land.XXXXXX")
SERVER_PID=
cleanup() {
  if [[ -n ${SERVER_PID:-} ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

git --version
uname -sm
python3 --version
if [[ $(git -C "$SOURCE" rev-parse --show-toplevel 2>/dev/null || true) == "$ROOT" ]]; then
  printf 'source=concord-checkout\n'
else
  printf 'source=external-checkout\n'
fi
git clone --bare --quiet "$SOURCE" "$RUN/server.git"
G="$RUN/server.git"
MAIN=main
if ! git --git-dir="$G" show-ref --verify --quiet "refs/heads/$MAIN"; then
  BASE=$(git --git-dir="$G" rev-parse HEAD)
  git --git-dir="$G" update-ref "refs/heads/$MAIN" "$BASE"
else
  BASE=$(git --git-dir="$G" rev-parse "refs/heads/$MAIN")
fi
git --git-dir="$G" symbolic-ref HEAD "refs/heads/$MAIN"
export GIT_DIR="$G"
BASE_NAME=$(git show -s --format=%an "$BASE")
BASE_EMAIL=$(git show -s --format=%ae "$BASE")
BASE_TIME=$(git show -s --format=%aI "$BASE")
COMMIT_DATE=${BASE_TIME}

blob() { printf '%s' "$2" | git hash-object -w --stdin; }
seed_index="$RUN/seed.index"
GIT_INDEX_FILE="$seed_index" git read-tree "$BASE"
for i in $(seq 1 10); do
  path=$(printf 'sp-b-fixtures/disjoint-%02d.txt' "$i")
  oid=$(blob "$i" "base disjoint $i\n")
  GIT_INDEX_FILE="$seed_index" git update-index --add --cacheinfo "100644,$oid,$path"
done
oid=$(blob overlap 'base overlap\n')
GIT_INDEX_FILE="$seed_index" git update-index --add --cacheinfo "100644,$oid,sp-b-fixtures/overlap.txt"
seed_tree=$(GIT_INDEX_FILE="$seed_index" git write-tree)
SEED=$(printf 'SP-B temporary benchmark fixtures\n' | GIT_AUTHOR_NAME="$BASE_NAME" GIT_AUTHOR_EMAIL="$BASE_EMAIL" GIT_COMMITTER_NAME="$BASE_NAME" GIT_COMMITTER_EMAIL="$BASE_EMAIL" GIT_AUTHOR_DATE="$COMMIT_DATE" GIT_COMMITTER_DATE="$COMMIT_DATE" git commit-tree "$seed_tree" -p "$BASE")
git update-ref "refs/heads/$MAIN" "$SEED" "$BASE"
BASE=$SEED
rm -f "$seed_index"
printf 'fixture_base=%s\n' "$BASE"

printf '\n[a] create 20 server-side changes (hash-object, temporary index, read-tree, update-index --index-info, write-tree, commit-tree)\n'
CREATE_START=$(python3 -c 'import time; print(time.monotonic_ns())')
for i in $(seq 1 20); do
  parent=$BASE
  index="$RUN/change.$i.index"
  GIT_INDEX_FILE="$index" git read-tree "$parent"
  if (( i <= 10 )); then
    path=$(printf 'sp-b-fixtures/disjoint-%02d.txt' "$i")
    text="change $i disjoint\n"
  else
    path=sp-b-fixtures/overlap.txt
    text="overlap candidate $i\n"
  fi
  oid=$(blob "$path" "$text")
  printf '100644 %s\t%s\n' "$oid" "$path" | GIT_INDEX_FILE="$index" git update-index --index-info
  tree=$(GIT_INDEX_FILE="$index" git write-tree)
  change=$(printf 'SP-B candidate %02d\n' "$i" | GIT_AUTHOR_NAME="$BASE_NAME" GIT_AUTHOR_EMAIL="$BASE_EMAIL" GIT_COMMITTER_NAME="$BASE_NAME" GIT_COMMITTER_EMAIL="$BASE_EMAIL" GIT_AUTHOR_DATE="$COMMIT_DATE" GIT_COMMITTER_DATE="$COMMIT_DATE" git commit-tree "$tree" -p "$parent")
  printf '%02d %s\n' "$i" "$change" >> "$RUN/changes"
  rm -f "$index"
done
CREATE_END=$(python3 -c 'import time; print(time.monotonic_ns())')
python3 - "$CREATE_START" "$CREATE_END" <<'PY'
import sys
print(f'create_elapsed_ms={(int(sys.argv[2])-int(sys.argv[1]))/1e6:.3f}')
PY

printf '\n[b-d] merge-tree, CAS landing of 20 concurrent changes (10 disjoint, 10 overlapping)\n'
land_one() {
  local id=$1 change=$2 start now old merge_output rc tree new retries=0
  start=$(python3 -c 'import time; print(time.monotonic_ns())')
  while :; do
    old=$(git rev-parse "refs/heads/$MAIN")
    set +e
    merge_output=$(git merge-tree --write-tree "$old" "$change" 2>&1)
    rc=$?
    set -e
    if (( rc != 0 )); then
      now=$(python3 -c 'import time; print(time.monotonic_ns())')
      python3 - "$id" "$retries" "$start" "$now" <<'PY' >> "$RUN/results"
import sys
i,r,s,n=sys.argv[1:]
print(f'{i} conflict {r} {(int(n)-int(s))/1e6:.3f}')
PY
      return 0
    fi
    tree=${merge_output%%$'\n'*}
    new=$(printf 'SP-B merged change %s\n' "$id" | GIT_AUTHOR_NAME="$BASE_NAME" GIT_AUTHOR_EMAIL="$BASE_EMAIL" GIT_COMMITTER_NAME="$BASE_NAME" GIT_COMMITTER_EMAIL="$BASE_EMAIL" GIT_AUTHOR_DATE="$COMMIT_DATE" GIT_COMMITTER_DATE="$COMMIT_DATE" git commit-tree "$tree" -p "$old")
    if git update-ref "refs/heads/$MAIN" "$new" "$old" 2>/dev/null; then
      now=$(python3 -c 'import time; print(time.monotonic_ns())')
      python3 - "$id" "$retries" "$start" "$now" <<'PY' >> "$RUN/results"
import sys
i,r,s,n=sys.argv[1:]
print(f'{i} landed {r} {(int(n)-int(s))/1e6:.3f}')
PY
      return 0
    fi
    retries=$((retries+1))
  done
}
while read -r id change; do land_one "$id" "$change" & done < "$RUN/changes"
wait
cat "$RUN/results" | sort -n
python3 - "$RUN/results" <<'PY'
import pathlib,sys
rows=[]
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    i,status,retries,ms=line.split(); rows.append((int(i),status,int(retries),float(ms)))
lat=sorted(row[3] for row in rows)
def pct(p): return lat[max(0, __import__('math').ceil(p*len(lat))-1)]
landed=sum(r[1]=='landed' for r in rows); conflicts=sum(r[1]=='conflict' for r in rows)
print(f'landed={landed} conflicts={conflicts} cas_retries={sum(r[2] for r in rows)}')
print(f'latency_ms_p50={pct(.50):.3f} latency_ms_p95={pct(.95):.3f}')
if (landed,conflicts)!=(11,9): raise SystemExit('unexpected conflict/landing count')
PY

printf '\n[e] bisect a landed batch and revert the bad change server-side\n'
current=$(git rev-parse "refs/heads/$MAIN")
parent=$current
for i in $(seq 1 7); do
  path=$(printf 'sp-b-fixtures/batch-%02d.txt' "$i")
  contents="good $i\n"
  if [[ $i -eq 1 ]]; then
    path=sp-b-fixtures/bad-marker.txt
    contents='good baseline\n'
  elif [[ $i -eq 4 ]]; then
    path=sp-b-fixtures/bad-marker.txt
    contents='BAD regression\n'
  fi
  index="$RUN/batch.$i.index"
  GIT_INDEX_FILE="$index" git read-tree "$parent"
  oid=$(blob "$path" "$contents")
  printf '100644 %s\t%s\n' "$oid" "$path" | GIT_INDEX_FILE="$index" git update-index --index-info
  tree=$(GIT_INDEX_FILE="$index" git write-tree)
  parent=$(printf 'SP-B batch item %02d\n' "$i" | GIT_AUTHOR_NAME="$BASE_NAME" GIT_AUTHOR_EMAIL="$BASE_EMAIL" GIT_COMMITTER_NAME="$BASE_NAME" GIT_COMMITTER_EMAIL="$BASE_EMAIL" GIT_AUTHOR_DATE="$COMMIT_DATE" GIT_COMMITTER_DATE="$COMMIT_DATE" git commit-tree "$tree" -p "$parent")
  rm -f "$index"
  printf '%s\n' "$parent" >> "$RUN/batch"
done
git update-ref "refs/heads/$MAIN" "$parent" "$current"
lo=1; hi=7; probes=0
while (( lo < hi )); do
  mid=$(((lo+hi)/2)); commit=$(sed -n "${mid}p" "$RUN/batch"); probes=$((probes+1))
  if git show "$commit:sp-b-fixtures/bad-marker.txt" 2>/dev/null | grep -q BAD; then hi=$mid; else lo=$((mid+1)); fi
done
BAD_COMMIT=$(sed -n "${lo}p" "$RUN/batch")
printf 'bad_change_index=%s bisect_probes=%s bad_commit=%s\n' "$lo" "$probes" "$BAD_COMMIT"
bad_tree=$(git rev-parse "$BAD_COMMIT^{tree}")
bad_parent=$(git rev-parse "$BAD_COMMIT^")
revert_index="$RUN/revert.index"
GIT_INDEX_FILE="$revert_index" git read-tree "$bad_tree"
original=$(git rev-parse "$bad_parent:sp-b-fixtures/bad-marker.txt")
printf '100644 %s\tsp-b-fixtures/bad-marker.txt\n' "$original" | GIT_INDEX_FILE="$revert_index" git update-index --index-info
revert_tree=$(GIT_INDEX_FILE="$revert_index" git write-tree)
revert=$(printf 'SP-B server-side revert bad change %s\n' "$lo" | GIT_AUTHOR_NAME="$BASE_NAME" GIT_AUTHOR_EMAIL="$BASE_EMAIL" GIT_COMMITTER_NAME="$BASE_NAME" GIT_COMMITTER_EMAIL="$BASE_EMAIL" GIT_AUTHOR_DATE="$COMMIT_DATE" GIT_COMMITTER_DATE="$COMMIT_DATE" git commit-tree "$revert_tree" -p "$parent")
git update-ref "refs/heads/$MAIN" "$revert" "$parent"
printf 'revert_commit=%s restored_blob=%s\n' "$revert" "$original"

printf '\n[f] git http-backend full clone and incremental fetch\n'
mkdir -p "$RUN/www"
ln -s "$G" "$RUN/www/repository.git"
cat > "$RUN/http-backend.py" <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import gzip, os, subprocess, sys, urllib.parse
root, port = sys.argv[1], int(sys.argv[2])
class Handler(BaseHTTPRequestHandler):
    def do_GET(self): self.run_backend()
    def do_POST(self): self.run_backend()
    def run_backend(self):
        parsed=urllib.parse.urlsplit(self.path); body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        if self.headers.get('Content-Encoding','').lower() == 'gzip': body=gzip.decompress(body)
        env=os.environ.copy(); env.pop('GIT_DIR',None); env.pop('GIT_INDEX_FILE',None); env.update({'GIT_PROJECT_ROOT':root,'GIT_HTTP_EXPORT_ALL':'1','PATH_INFO':parsed.path,'QUERY_STRING':parsed.query,'REQUEST_METHOD':self.command,'CONTENT_TYPE':self.headers.get('Content-Type',''),'CONTENT_LENGTH':str(len(body)),'REMOTE_ADDR':self.client_address[0],'SERVER_PROTOCOL':self.request_version,'HTTP_GIT_PROTOCOL':self.headers.get('Git-Protocol','')})
        p=subprocess.run(['git','http-backend'],input=body,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
        head,_,content=p.stdout.partition(b'\r\n\r\n')
        if not content: head,_,content=p.stdout.partition(b'\n\n')
        print(f'{self.command} {parsed.path} request_headers={dict(self.headers)} request_head={body[:24]!r} rc={p.returncode} headers={head[:120]!r} body_head={content[:24]!r} bytes={len(content)} stderr={p.stderr[:300]!r}',file=sys.stderr,flush=True)
        status=200
        headers=[]
        for line in head.decode('latin1').splitlines():
            if line.lower().startswith('status:'): status=int(line.split()[1])
            elif ':' in line:
                k,v=line.split(':',1)
                if k.lower() not in ('status','connection','transfer-encoding'): headers.append((k,v.strip()))
        self.send_response(status)
        for k,v in headers: self.send_header(k,v)
        self.send_header('Content-Length',str(len(content))); self.end_headers(); self.wfile.write(content)
    def log_message(self,*args): pass
ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()
PY
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
python3 "$RUN/http-backend.py" "$RUN/www" "$PORT" >"$RUN/http.log" 2>&1 & SERVER_PID=$!
READY=0
for n in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT/repository.git/info/refs?service=git-upload-pack" -o /dev/null 2>/dev/null && { READY=1; break; } || sleep .05; done
if (( READY == 0 )); then cat "$RUN/http.log"; exit 1; fi
URL="http://127.0.0.1:$PORT/repository.git"
T0=$(python3 -c 'import time;print(time.monotonic_ns())')
env -u GIT_DIR git clone --quiet "$URL" "$RUN/full-clone"
T1=$(python3 -c 'import time;print(time.monotonic_ns())')
python3 - "$T0" "$T1" <<'PY'
import sys
print(f'http_backend_full_clone_ms={(int(sys.argv[2])-int(sys.argv[1]))/1e6:.3f}')
PY
env -u GIT_DIR git clone --bare --quiet "$URL" "$RUN/fetch-clone.git"
old=$(git rev-parse "refs/heads/$MAIN")
fetch_oid=$(blob fetch-probe 'incremental HTTP fetch payload\n')
idx="$RUN/fetch.index"; GIT_INDEX_FILE="$idx" git read-tree "$old"
printf '100644 %s\tsp-b-fixtures/fetch-probe.txt\n' "$fetch_oid" | GIT_INDEX_FILE="$idx" git update-index --index-info
fetch_tree=$(GIT_INDEX_FILE="$idx" git write-tree)
fetch_commit=$(printf 'SP-B HTTP fetch probe\n' | GIT_AUTHOR_NAME="$BASE_NAME" GIT_AUTHOR_EMAIL="$BASE_EMAIL" GIT_COMMITTER_NAME="$BASE_NAME" GIT_COMMITTER_EMAIL="$BASE_EMAIL" GIT_AUTHOR_DATE="$COMMIT_DATE" GIT_COMMITTER_DATE="$COMMIT_DATE" git commit-tree "$fetch_tree" -p "$old")
git update-ref "refs/heads/$MAIN" "$fetch_commit" "$old"
T0=$(python3 -c 'import time;print(time.monotonic_ns())')
env -u GIT_DIR git --git-dir="$RUN/fetch-clone.git" fetch --quiet "$URL" "refs/heads/$MAIN"
T1=$(python3 -c 'import time;print(time.monotonic_ns())')
python3 - "$T0" "$T1" <<'PY'
import sys
print(f'http_backend_incremental_fetch_ms={(int(sys.argv[2])-int(sys.argv[1]))/1e6:.3f}')
PY
printf 'repo_object_count=%s repo_pack_bytes=%s\n' "$(git count-objects -v | awk '/count:/{print $2}')" "$(git count-objects -v | awk '/size-pack:/{print $2*1024}')"
printf '\ncleanup: temporary repository and HTTP server removed on exit\n'
