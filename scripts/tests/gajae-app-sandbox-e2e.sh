#!/usr/bin/env bash
# Isolated lifecycle test. It never invokes the host systemctl or writes outside WORKDIR.
set -euo pipefail

resolve_tool() {
  local tool
  tool="$(type -P "$1")" || { printf 'required tool not found: %s\n' "$1" >&2; exit 1; }
  printf '%s\n' "$tool"
}

if [[ "${1:-}" != "--sanitized" ]]; then
  BASH_BIN="$(resolve_tool bash)"
  ENV_BIN="$(resolve_tool env)"
  READLINK_BIN="$(resolve_tool readlink)"
  MKTEMP_BIN="$(resolve_tool mktemp)"
  STAT_BIN="$(resolve_tool stat)"
  SHA256SUM_BIN="$(resolve_tool sha256sum)"
  SCRIPT_PATH="$("$READLINK_BIN" -f "$0")"
  SKIP_REAL_HOME_CHECK=0
  for arg in "$@"; do
    [[ "$arg" == "--adversarial-probe" ]] && SKIP_REAL_HOME_CHECK=1
  done
  REAL_HOME_SAMPLE=""
  REAL_HOME_SAMPLE_MTIME=""
  REAL_HOME_SAMPLE_SUM=""
  if (( ! SKIP_REAL_HOME_CHECK )); then
    for candidate in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile"; do
      if [[ -f "$candidate" ]]; then
        REAL_HOME_SAMPLE="$candidate"
        break
      fi
    done
    [[ -n "$REAL_HOME_SAMPLE" ]] || { echo 'no real-home sample file available for isolation check' >&2; exit 1; }
    REAL_HOME_SAMPLE_MTIME="$("$STAT_BIN" -c %Y "$REAL_HOME_SAMPLE")"
    REAL_HOME_SAMPLE_SUM="$("$SHA256SUM_BIN" "$REAL_HOME_SAMPLE")"
  fi
  SANITIZED_HOME="$("$MKTEMP_BIN" -d "${TMPDIR:-/tmp}/gajae-app-sandbox-home.XXXXXX")"
  SANITIZED_PATH=""
  for tool in "$BASH_BIN" "$ENV_BIN" "$MKTEMP_BIN" "$(resolve_tool git)" "$(resolve_tool node)" "$(resolve_tool npm)" "$(resolve_tool awk)" "$(resolve_tool curl)" "$(resolve_tool sha256sum)" "$(resolve_tool sleep)" "$(resolve_tool mkdir)" "$(resolve_tool rm)" "$(resolve_tool cp)" "$(resolve_tool sed)" "$(resolve_tool grep)" "$(resolve_tool dirname)" "$(resolve_tool chmod)"; do
    tool_dir="${tool%/*}"
    case ":$SANITIZED_PATH:" in
      *":$tool_dir:"*) ;;
      *) SANITIZED_PATH="${SANITIZED_PATH:+$SANITIZED_PATH:}$tool_dir" ;;
    esac
  done
  exec "$ENV_BIN" -i \
    PATH="$SANITIZED_PATH" \
    HOME="$SANITIZED_HOME" \
    HARNESS_BOOTSTRAP_HOME="$SANITIZED_HOME" \
    REAL_HOME_SAMPLE="$REAL_HOME_SAMPLE" \
    REAL_HOME_SAMPLE_MTIME="$REAL_HOME_SAMPLE_MTIME" \
    REAL_HOME_SAMPLE_SUM="$REAL_HOME_SAMPLE_SUM" \
    SKIP_REAL_HOME_CHECK="$SKIP_REAL_HOME_CHECK" \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_TEMPLATE_DIR= \
    "$BASH_BIN" "$SCRIPT_PATH" --sanitized "$@"
fi

shift
ADVERSARIAL_PROBE=0
if [[ "${1:-}" == "--adversarial-probe" ]]; then
  ADVERSARIAL_PROBE=1
  shift
fi
[[ -z "${GIT_DIR+x}" && -z "${GIT_WORK_TREE+x}" && -z "${GIT_INDEX_FILE+x}" ]] || {
  echo 'git environment leaked into sanitized harness' >&2
  exit 1
}
git_sandbox() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TEMPLATE_DIR= git "$@"
}
if (( ADVERSARIAL_PROBE )); then
  probe_repo="$(mktemp -d "${TMPDIR:-/tmp}/gajae-app-sandbox-git-probe.XXXXXX")"
  git_sandbox -C "$probe_repo" init -q
  printf 'probe\n' > "$probe_repo/README"
  git_sandbox -C "$probe_repo" add README
  git_sandbox -C "$probe_repo" -c user.email=probe@example.invalid -c user.name=probe commit -qm probe
  rm -rf "$probe_repo"
  exit 0
fi
ROOT="$(git_sandbox rev-parse --show-toplevel)"
SCRIPT="$ROOT/scripts/gajae-app.sh"
REAL_NODE="$(command -v node)"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/gajae-app-sandbox.XXXXXX")"
PORT="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
SENTINEL="$WORKDIR/operational-sentinel"
printf 'do-not-touch\n' > "$SENTINEL"
SENTINEL_SUM="$(sha256sum "$SENTINEL")"

cleanup() {
  if [[ -f "$WORKDIR/home/.fake-systemctl/pid" ]]; then
    kill "$(<"$WORKDIR/home/.fake-systemctl/pid")" 2>/dev/null || true
  fi
  [[ -n "${KEEP_SANDBOX:-}" ]] || rm -rf "$WORKDIR"
  [[ -z "${HARNESS_BOOTSTRAP_HOME:-}" || -n "${KEEP_SANDBOX:-}" ]] || rm -rf "$HARNESS_BOOTSTRAP_HOME"
}
trap cleanup EXIT HUP INT TERM

REPO_WORK="$WORKDIR/repo-work"
REPO_BARE="$WORKDIR/repo.git"
mkdir -p "$REPO_WORK/packaging/systemd" "$REPO_WORK/scripts" "$WORKDIR/bin"
cat > "$WORKDIR/bin/node" <<NODE
#!/usr/bin/env bash
if [[ "\${1:-}" == --version ]]; then
  printf 'v22.0.0\n'
  exit 0
fi
exec "$REAL_NODE" "\$@"
NODE
chmod +x "$WORKDIR/bin/node"
git_sandbox -C "$REPO_WORK" init -q
git_sandbox -C "$REPO_WORK" config user.email sandbox@example.invalid
git_sandbox -C "$REPO_WORK" config user.name sandbox
cat > "$REPO_WORK/package.json" <<'JSON'
{"name":"gajae-app-sandbox","version":"0.0.0","scripts":{"build":"node -e \"require('fs').mkdirSync('dist-server/server',{recursive:true});require('fs').writeFileSync('dist-server/server/index.js','sandbox')\""}}
JSON
cat > "$REPO_WORK/package-lock.json" <<'JSON'
{"name":"gajae-app-sandbox","version":"0.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"gajae-app-sandbox","version":"0.0.0"}}}
JSON
cat > "$REPO_WORK/packaging/systemd/gajae-app.service" <<'UNIT'
[Service]
WorkingDirectory=@APP_ROOT@
Environment=HOST=@HOST@
Environment=SERVER_PORT=@PORT@
ExecStart=@NODE_BIN@ @APP_ROOT@/scripts/gajae-app-runtime.mjs start
UNIT
printf 'export {}\n' > "$REPO_WORK/scripts/gajae-app-runtime.mjs"
printf 'node_modules/\ndist-server/\n' > "$REPO_WORK/.gitignore"
git_sandbox -C "$REPO_WORK" add .
git_sandbox -C "$REPO_WORK" commit -qm release-1
git_sandbox -C "$REPO_WORK" tag v0.0.1
printf 'release two\n' > "$REPO_WORK/RELEASE"
git_sandbox -C "$REPO_WORK" add RELEASE
git_sandbox -C "$REPO_WORK" commit -qm release-2
git_sandbox -C "$REPO_WORK" tag v0.0.2
printf 'fail health\n' > "$REPO_WORK/HEALTH_FAIL"
git_sandbox -C "$REPO_WORK" add HEALTH_FAIL
git_sandbox -C "$REPO_WORK" commit -qm failure-candidate
git_sandbox -C "$REPO_WORK" branch failure
git_sandbox clone --bare -q "$REPO_WORK" "$REPO_BARE"

cat > "$WORKDIR/bin/fake-systemctl" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
state="$HOME/.fake-systemctl"
unit="${GAJAE_APP_SYSTEMD_USER_DIR:?}/gajae-app.service"
mkdir -p "$state"
command=""
for arg in "$@"; do
  case "$arg" in daemon-reload|enable|start|stop|restart|is-active) command="$arg";; esac
done
pid_file="$state/pid"
stop_server() {
  if [[ -f "$pid_file" ]]; then
    kill "$(<"$pid_file")" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$(<"$pid_file")" 2>/dev/null || break
      sleep 0.1
    done
    rm -f "$pid_file" "$state/root"
  fi
}
start_server() {
  local root port fail ready attempt
  root="$(awk -F= '/^WorkingDirectory=/{gsub(/^"|"$/, "", $2); print $2}' "$unit")"
  port="$(awk -F= '/^Environment=SERVER_PORT=/{gsub(/^"|"$/, "", $3); print $3}' "$unit")"
  fail=0
  [[ -f "$root/HEALTH_FAIL" ]] && fail=1
  ready="$state/ready"
  rm -f "$ready"
  ROOT="$root" PORT="$port" FAIL="$fail" READY="$ready" node -e '
const fs=require("fs"), http=require("http");
const root=process.env.ROOT, fail=process.env.FAIL === "1";
http.createServer((req,res)=>{if(req.url==="/health"){res.statusCode=fail?503:200;res.end(JSON.stringify({root}));}else{res.statusCode=404;res.end();}}).listen(Number(process.env.PORT),"127.0.0.1",()=>fs.writeFileSync(process.env.READY,"ready"));
' >/dev/null 2>&1 &
  printf '%s\n' "$!" > "$pid_file"
  printf '%s\n' "$root" > "$state/root"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    [[ -f "$ready" ]] && return
    sleep 0.1
  done
  return 1
}
case "$command" in
  daemon-reload|enable) exit 0 ;;
  is-active) [[ -f "$pid_file" ]] && kill -0 "$(<"$pid_file")" 2>/dev/null ;;
  start) stop_server; start_server ;;
  restart) stop_server; start_server ;;
  stop) stop_server ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "$WORKDIR/bin/fake-systemctl"

run_app() {
  env -i \
    HOME="$WORKDIR/home" \
    XDG_CONFIG_HOME="$WORKDIR/config" \
    GAJAE_APP_SYSTEMD_USER_DIR="$WORKDIR/systemd" \
    GAJAE_APP_INSTALL_DIR="$WORKDIR/install" \
    GAJAE_APP_SYSTEMCTL="$WORKDIR/bin/fake-systemctl" \
    GAJAE_APP_REPOSITORY="$REPO_BARE" \
    GAJAE_APP_REF="$1" \
    PORT="$PORT" \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_TEMPLATE_DIR= \
    PATH="$WORKDIR/bin:$PATH" \
    bash "$SCRIPT" "$2" --port "$PORT" "${@:3}"
}
fake_state="$WORKDIR/home/.fake-systemctl"
state_file="$WORKDIR/home/.gajae-app/deployment/deployment.env"
value() { awk -F= -v wanted="$1" '$1 == wanted {print substr($0, length(wanted) + 2); exit}' "$state_file"; }
assert_eq() { [[ "$1" == "$2" ]] || { printf 'assertion failed: expected %s, got %s\n' "$2" "$1" >&2; exit 1; }; }
assert_health_root() {
  local root="$1" attempt
  for attempt in 1 2 3 4 5; do
    if curl --fail --silent "http://127.0.0.1:$PORT/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);if(v.root!==process.argv[1])process.exit(1)})' "$root"; then
      return
    fi
    sleep 1
  done
  return 1
}

run_app v0.0.1 install
old_sha="$(value sha)"
old_root="$(value active_root)"
old_pid="$(<"$fake_state/pid")"
assert_eq "$(value release_tag)" v0.0.1
status="$(run_app v0.0.1 status --json)"
printf '%s\n' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);if(v.updateState!=="current"||v.service!=="active"||v.health!=="healthy")process.exit(1)})'
assert_health_root "$old_root"

run_app v0.0.2 update
new_sha="$(value sha)"
new_root="$(value active_root)"
new_pid="$(<"$fake_state/pid")"
[[ "$new_sha" != "$old_sha" && "$new_root" != "$old_root" && "$new_pid" != "$old_pid" ]] || { echo 'update did not replace deployment process' >&2; exit 1; }
assert_eq "$(value release_tag)" v0.0.2
assert_health_root "$new_root"

if run_app failure update; then
  echo 'unhealthy candidate unexpectedly succeeded' >&2
  exit 1
fi
assert_eq "$(value update_state)" rolled_back
assert_eq "$(value sha)" "$new_sha"
assert_eq "$(value active_root)" "$new_root"
assert_eq "$(value release_tag)" v0.0.2
assert_health_root "$new_root"
assert_eq "$(sha256sum "$SENTINEL")" "$SENTINEL_SUM"
if (( ! SKIP_REAL_HOME_CHECK )); then
  assert_eq "$(stat -c %Y "$REAL_HOME_SAMPLE")" "$REAL_HOME_SAMPLE_MTIME"
  assert_eq "$(sha256sum "$REAL_HOME_SAMPLE")" "$REAL_HOME_SAMPLE_SUM"
fi

if (( ! ADVERSARIAL_PROBE )); then
  adversary_dir="$(mktemp -d "${TMPDIR:-/tmp}/gajae-app-sandbox-adversary.XXXXXX")"
  hook_marker="$adversary_dir/hook-ran"
  mkdir -p "$adversary_dir/hooks"
  cat > "$adversary_dir/hooks/post-commit" <<HOOK
#!/usr/bin/env bash
printf 'contaminated\n' > "$hook_marker"
HOOK
  chmod +x "$adversary_dir/hooks/post-commit"
  cat > "$adversary_dir/gitconfig" <<CONFIG
[core]
	hooksPath = $adversary_dir/hooks
CONFIG
  GIT_DIR="$adversary_dir/fake.git" \
    GIT_WORK_TREE="$adversary_dir/fake-work" \
    GIT_INDEX_FILE="$adversary_dir/fake-index" \
    GIT_CONFIG_GLOBAL="$adversary_dir/gitconfig" \
    bash "$0" --adversarial-probe
  [[ ! -e "$hook_marker" ]] || { echo 'adversarial git hook escaped the sanitized harness' >&2; exit 1; }
  rm -rf "$adversary_dir"
fi

printf 'sandbox e2e passed: install, update, health-failure rollback, hostile git environment\n'
