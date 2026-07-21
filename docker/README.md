# Gaminus sandboxes

Gaminus sandbox templates are built and used locally. The application template tags are:

| Agent | Local template |
| --- | --- |
| Claude Code | `gaminus-sandbox:claude-code` |
| Codex | `gaminus-sandbox:codex` |

The local lifecycle never pulls or publishes an application image and never installs Gaminus from a package registry. Build the template from a prepared repository runtime before invoking `sbx`.

## Prerequisites

- Docker and the `sbx` CLI. See the [Docker Sandboxes guide](https://docs.docker.com/ai/sandboxes/get-started/).
- A local Gaminus repository runtime for Linux x64 and Node 22. It must contain the built client and server plus its local dependencies.
- Agent credentials stored with `sbx`, for example `sbx secret set -g anthropic` or `sbx secret set -g openai`.

From the repository root, confirm the required local source exists:

```bash
test -f package.json
test -f dist/index.html
test -f dist-server/server/cli.js
test -d node_modules
```

The Dockerfiles validate these inputs, Node 22, Linux x64, and the required native modules. A missing input stops the build with a `Gaminus sandbox build failed` message; obtain or build the prepared repository runtime locally rather than falling back to an external application image or package installation.

## Build local templates

Run these commands from the repository root. The build context must be the repository root, not `docker/`.

```bash
docker build --file docker/claude-code/Dockerfile --tag gaminus-sandbox:claude-code .
docker build --file docker/codex/Dockerfile --tag gaminus-sandbox:codex .
```

Each image installs the prepared repository runtime at `/opt/gaminus` and exposes its canonical CLI as `gaminus`. Sandbox data and logs remain under `/home/agent/.gaminus`; the server log is `/home/agent/.gaminus/logs/sandbox.log`.

Before starting a sandbox, verify that the exact local template exists. Do not substitute a different image when this check fails.

```bash
AGENT=claude-code
docker image inspect "gaminus-sandbox:${AGENT}" >/dev/null 2>&1 || {
  printf 'Missing local template gaminus-sandbox:%s. Build it from this repository first.\n' "$AGENT" >&2
  exit 1
}
```

## Launch and manage

The installed CLI selects the local template for its supported agents:

```bash
gaminus sandbox ~/my-project
gaminus sandbox ~/my-project --agent codex --port 8080
gaminus sandbox ls
gaminus sandbox logs my-project
```

Use `sbx` directly for branch mode, multiple workspaces, prompts, and other generic agent workflows. Supply one of the local Gaminus templates explicitly:

```bash
sbx run --template gaminus-sandbox:claude-code claude ~/my-project --branch my-feature
sbx run --template gaminus-sandbox:codex codex ~/my-project -- "Fix the auth bug"
sbx ports my-project --publish 3001:3001
```

Generic agents remain usable through `sbx` with a user-provided local template. Only `gaminus-sandbox:claude-code` and `gaminus-sandbox:codex` include Gaminus.

Manage sandbox lifecycle with `sbx`:

```bash
sbx ls
sbx stop my-project
sbx start my-project
sbx rm my-project
sbx exec my-project bash
```

## Logs and configuration

The sandbox startup script runs from the agent shell and starts Gaminus on port `3001` unless `SERVER_PORT` is set. It binds to `0.0.0.0` so `sbx ports` can publish it.

Read the canonical server log with:

```bash
sbx exec my-project bash -c 'cat ~/.gaminus/logs/sandbox.log'
```

`/tmp/gaminus-ui.log` is an internal compatibility symlink to that canonical log. Do not use it as a data location.

Use `--env SERVER_PORT=<port>` with `gaminus sandbox` when creating a sandbox, then publish the matching port with `sbx ports`.
