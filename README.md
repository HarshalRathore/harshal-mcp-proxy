# harshal-mcp-proxy

Custom MCP gateway that slashes costs: load **6 gateway tools** (~375 tokens) instead
of 40-70K tokens of upstream MCP server schemas — a ~99.3% reduction — and run **one
shared daemon** instead of a server farm per agent session, saving ~2.7 GB RAM.
Combines **schema deferral** (from [mcp-gateway](https://github.com/eznix86/mcp-gateway))
with **response shielding** (from [tldr](https://github.com/robinojw/tldr)) in a single
TypeScript server.

## What it does

Instead of your AI client loading 40-70K tokens of tool schemas from 12+ MCP servers at
startup, it loads **6 tool definitions from this proxy** (~375 tokens). The proxy then:

1. **Schema deferral** — Tools are discovered via BM25 search (`gateway.search`), full
   schemas loaded on demand (`gateway.describe`), and executed through the proxy
   (`gateway.invoke`). The model never sees schemas it doesn't need.

2. **Response shielding** — Every tool response passes through a truncation engine before
   reaching the model context:
   - Arrays >50 items → capped at 50, remainder stored for pagination
   - Strings >8192 chars → truncated with marker
   - Heavy fields in array-of-objects → stripped (avg >256 bytes), signal fields preserved
   - Total response >64KB → iteratively shrunk to fit
   - Full untruncated responses stored in a ring buffer (last 100), accessible via
     `gateway.get_result` with pagination, field projection, and text search

3. **Shared process elimination** — In daemon mode, ONE proxy instance serves ALL your AI
   clients (pi, VS Code, etc.), eliminating duplicate MCP server processes.

4. **On-demand lazy loading** — MCP server processes are no longer started at boot.
   Instead, tool schemas are loaded from disk-based **catalog snapshots** at startup.
   The actual server process is spawned only when you first invoke a tool on that server.
   After 5 minutes of inactivity, the idle monitor auto-disconnects it — freeing RAM
   and CPU without losing searchability.

---

## Why the Shared Daemon?

Every AI coding agent (pi session, VS Code MCP extension) traditionally spawns its own
complete set of MCP server processes. With 12+ MCP servers in your config, this means:

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  pi session 1│────►│  harshal-mcp-    │────►│  12 MCP servers  │
│              │     │  proxy (stdio)   │     │  (1.3 GB)        │
├──────────────┤     └──────────────────┘     └──────────────────┘
│  pi session 2│────►┌──────────────────┐     ┌──────────────────┐
│              │     │  harshal-mcp-    │────►│  12 MCP servers  │
├──────────────┤     │  proxy (stdio)   │     │  (1.3 GB)        │
│  VS Code     │────►└──────────────────┘     └──────────────────┘
└──────────────┘                               ┌──────────────────┐
                                               │  12 MCP servers  │
                                               │  (1.3 GB)        │
                                               └──────────────────┘
```

**3 sets × 12 servers = 36 processes, ~4 GB wasted RAM.**

With the shared daemon:

```
┌──────────────┐     ┌────────────────────────┐     ┌──────────────────┐
│  pi session 1│────►│                        │     │                  │
├──────────────┤     │  harshal-mcp-proxy     │────►│  12 MCP servers  │
│  pi session 2│────►│  daemon (HTTP port     │     │  (1.3 GB)        │
├──────────────┤     │  8765)                 │     │     ONE SET      │
│  VS Code     │────►│                        │     │                  │
└──────────────┘     └────────────────────────┘     └──────────────────┘
```

**3 clients × 1 daemon = ~10 MCP processes, saves ~2.7 GB RAM.**

---

## Two Modes

### Mode 1: Stdio (original, single-client)

Each client spawns its own proxy instance via stdio. One consumer at a time.

```bash
node dist/index.js
```

### Mode 2: HTTP Daemon (recommended, multi-client)

One proxy daemon serves all clients over HTTP. Uses MCP Streamable HTTP transport
(JSON-RPC 2.0).

```bash
node dist/index.js --daemon
# or with custom port:
node dist/index.js --port 8765
```

### Mode 3: Catalog Discovery (snapshot builder)

Build tool schema snapshots for all servers without keeping them running. Run this
once after adding a new server or updating tool schemas.

```bash
node dist/index.js --discover
# Connects to ALL servers, fetches tool schemas, saves snapshots to disk, then exits
```

Catalog snapshots are stored in `~/.cache/harshal-mcp-proxy/catalogs/`.

---

## The 6 Gateway Tools

| Tool | Purpose | Token Cost |
|------|---------|------------|
| `gateway.search` | BM25 fuzzy search over all upstream tools | Returns IDs + descriptions only |
| `gateway.describe` | Get full inputSchema for one tool | On-demand, only when needed |
| `gateway.invoke` | Execute tool synchronously (with response shielding) | Response auto-truncated |
| `gateway.invoke_async` | Queue tool for async execution | Returns jobId immediately |
| `gateway.invoke_status` | Poll async job status | Minimal response |
| `gateway.get_result` | Paginate through truncated responses | Offset/limit/fields/search |

## Model Workflow

```
1. gateway.search { query: "cypher query", limit: 5 }
   → Returns: [ { id: "neo4j-cypher::run_cypher_query", score: 4.2 }, ... ]

2. gateway.describe { id: "neo4j-cypher::run_cypher_query" }
   → Returns: { inputSchema: { query: "string", params: "object" } }

3. gateway.invoke { id: "neo4j-cypher::run_cypher_query", args: { query: "MATCH (n) RETURN n LIMIT 10" } }
   → Returns: { content: [...], _ref: "r3", _truncated: true }

4. gateway.get_result { ref: "r3", offset: 50, limit: 50, fields: ["name", "id"] }
   → Returns: next page of results with field projection
```

---

## Quick Start (AI-Powered Setup)

Want an AI agent to set this up for you? Give it the prompt in
[`SETUP_PROMPT.md`](./SETUP_PROMPT.md).

```bash
cat SETUP_PROMPT.md | pbcopy  # macOS
cat SETUP_PROMPT.md | xclip   # Linux (or just cat the file and copy it)
```

The prompt covers: installation, config, systemd service, pi integration, VS Code
integration, agent context installation, verification, and troubleshooting — all in
one shot.

### For existing installations: Teach Your Agent

If you already have harshal-mcp-proxy running but your agent doesn't know how to
call the gateway tools, use the [AGENT-CONTEXT.md](./AGENT-CONTEXT.md) file:

```bash
# Copy into your agent's config:

# For Pi:
cp AGENT-CONTEXT.md .pi/rules/mcp-proxy-context.md

# For Claude Code / Opencode:
cp AGENT-CONTEXT.md .opencode/rules/mcp-proxy-context.md

# For Cline (VS Code):
cp AGENT-CONTEXT.md .clinerules

# For Cursor:
cp AGENT-CONTEXT.md .cursorrules
```

Then reference it in your agent's startup config (e.g., `.pi/APPEND_SYSTEM.md`,
`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, etc.) so every session loads it.

---

## Installation

### Option 1: Install from npm (recommended)

```bash
# Global install — binary available as `harshal-mcp-proxy` in PATH
npm install -g harshal-mcp-proxy

# Or run directly without installing:
npx harshal-mcp-proxy

# Create config from template (EDIT THIS with your values)
mkdir -p ~/.config/harshal-mcp-proxy
cp $(npm root -g)/harshal-mcp-proxy/config.example.json ~/.config/harshal-mcp-proxy/config.json
# ⚠️ Edit ~/.config/harshal-mcp-proxy/config.json with your API keys and paths

# Verify it works (stdio mode)
harshal-mcp-proxy
# Should print: harshal-mcp-proxy starting (stdio)...
# Then: __MCP_GATEWAY_STDIO_READY__
# Ctrl+C to stop
```

### Option 2: Clone from source

```bash
# Clone the repo
gh repo clone HarshalRathore/harshal-mcp-proxy
cd harshal-mcp-proxy

# Install dependencies
npm install

# Build
npm run build

# Create config from template (EDIT THIS with your values)
cp config.example.json ~/.config/harshal-mcp-proxy/config.json
# ⚠️ Edit ~/.config/harshal-mcp-proxy/config.json with your API keys and paths

# Verify it works (stdio mode)
node dist/index.js
# Should print: harshal-mcp-proxy starting (stdio)...
# Then: __MCP_GATEWAY_STDIO_READY__
# Ctrl+C to stop
```

> ⚠️ **Security**: `config.json` contains API keys and secrets. It is excluded from
> version control via `.gitignore`. Always use `config.example.json` as the template
> and keep your actual `config.json` local.

## Setup: HTTP Daemon Mode (Systemd User Service)

This is the recommended setup — runs the proxy as a persistent background service
that all your AI clients connect to remotely.

### Step 1: Install the systemd unit

The `.service` file ships with the package. Copy it to your user systemd directory:

```bash
mkdir -p ~/.config/systemd/user

# If installed from npm:
cp $(npm root -g)/harshal-mcp-proxy/harshal-mcp-proxy.service ~/.config/systemd/user/

# If cloned from source:
# cp harshal-mcp-proxy.service ~/.config/systemd/user/

# Edit the path in the service file to match your setup:
sed -i "s|/home/username/|$HOME/|" ~/.config/systemd/user/harshal-mcp-proxy.service
# If using npm global install, the binary is already in PATH — just uncomment the right line
```

The service file supports two modes (edit it to choose one):
- **npm global install**: `ExecStart=harshal-mcp-proxy --daemon` (binary in PATH)
- **Source clone**: `ExecStart=/usr/bin/node /path/to/dist/index.js --daemon`

### Step 2: Enable and start

```bash
systemctl --user daemon-reload
systemctl --user enable harshal-mcp-proxy   # auto-start at boot
systemctl --user start harshal-mcp-proxy    # start now
systemctl --user status harshal-mcp-proxy   # verify
```

### Step 3: Verify

```bash
# Health check
curl http://localhost:8765/health

# MCP initialize
curl -X POST http://localhost:8765/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# List tools
curl -X POST http://localhost:8765/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

### Step 4: Manage the service

```bash
systemctl --user stop harshal-mcp-proxy     # stop daemon
systemctl --user restart harshal-mcp-proxy  # restart
systemctl --user disable harshal-mcp-proxy  # disable auto-start
journalctl --user -u harshal-mcp-proxy -f   # follow logs
```

---

## Client Configuration

### For pi (pi-mcp-adapter)

Create or update `~/.pi/agent/mcp.json` (global) or `<project>/.pi/mcp.json` (project-level):

```json
{
  "mcpServers": {
    "harshal-mcp-proxy": {
      "url": "http://localhost:8765/mcp",
      "description": "Shared MCP gateway — search, describe, invoke access to all tools"
    }
  }
}
```

Then reload pi's MCP config with `/mcp reconnect` or restart the pi session.

### For VS Code

Update `<project>/.vscode/mcp.json` (project-level) or `~/.config/Code/User/mcp.json` (global):

```json
{
  "servers": {
    "harshal-mcp-proxy": {
      "type": "streamableHttp",
      "url": "http://localhost:8765/mcp",
      "description": "Shared MCP gateway — provides search, describe, and invoke access to all tools"
    }
  }
}
```

Replace all individual MCP server entries (playwright, shadcn, neo4j, etc.) with this
single entry. Restart VS Code or reload the MCP extension.

### For opencode

Update `opencode.json`:

```jsonc
{
  "mcp": {
    "harshal-mcp-proxy": {
      "type": "remote",
      "url": "http://localhost:8765/mcp",
      "transport": "streamable_http"
    }
  }
}
```

---

## Architecture

### Stdio Mode (legacy, single-client)

```
┌──────────────┐     stdio      ┌──────────────────────────┐
│  AI Client   │ ──────────── → │   harshal-mcp-proxy      │
│  (sees 6     │ ← ──────────  │                          │
│   tools)     │                │  ┌──────────────────┐    │
└──────────────┘                │  │  SearchEngine     │    │  ← BM25 index
                                │  │  (MiniSearch)     │    │
                                │  └──────────────────┘    │
                                │  ┌──────────────────┐    │
                                │  │  ResponseShield   │    │  ← Truncation
                                │  │  ResponseStore    │    │  ← Ring buffer
                                │  └──────────────────┘    │
                                │  ┌──────────────────┐    │
                                │  │  ConnectionMgr    │ ───── → Upstream MCP
                                │  └──────────────────┘    │     servers (stdio)
                                └──────────────────────────┘
```

### HTTP Daemon Mode (recommended, multi-client)

```
┌──────────────┐    HTTP POST    ┌──────────────────────────┐
│  pi #1       │ ──────────────► │                          │
├──────────────┤                 │  harshal-mcp-proxy       │
│  pi #2       │ ──────────────► │  daemon (port 8765)      │
├──────────────┤                 │                          │
│  VS Code     │ ──────────────► │  ┌──────────────────┐    │
├──────────────┤                 │  │  JSON-RPC 2.0    │    │
│  opencode    │ ──────────────► │  │  over HTTP POST  │    │
└──────────────┘                 │  └──────────────────┘    │
                                 │  ┌──────────────────┐    │
                                 │  │  SearchEngine     │    │
                                 │  └──────────────────┘    │
                                 │  ┌──────────────────┐    │
                                 │  │  ResponseShield   │    │
                                 │  │  ResponseStore    │    │
                                 │  └──────────────────┘    │
                                 │  ┌──────────────────┐    │
                                 │  │  ConnectionMgr    │ ───── → ONE set of
                                 │  └──────────────────┘    │     upstream MCP
                                 └──────────────────────────┘     servers

All clients share ONE set of upstream MCP server processes.
No duplicate npm exec, no wasted RAM.
```

---

## Migration Guide

### From stdio to daemon mode

**1. Install the service:**

```bash
# Build the proxy if not already built
cd /path/to/harshal-mcp-proxy && npm run build

# Enable and start the daemon
systemctl --user daemon-reload
systemctl --user enable harshal-mcp-proxy
systemctl --user start harshal-mcp-proxy
```

**2. Update your clients:**

| Client | Config file | Change |
|--------|-------------|--------|
| pi | `~/.pi/agent/mcp.json` or `<project>/.pi/mcp.json` | Set `url` to `http://localhost:8765/mcp` |
| VS Code | `<project>/.vscode/mcp.json` | Set `type: "streamableHttp"` + `url` |
| opencode | `opencode.json` | Set `type: "remote"` + `url` |

**3. Remove old local command configs:**

Delete entries that used `type: "local"` with individual `command` arrays for each
MCP server (e.g., playwright, shadcn, neo4j, searxng, etc.). The daemon manages all
upstream servers via its own `~/.config/harshal-mcp-proxy/config.json`.

**4. Reload / restart clients:**

- pi: run `/mcp reconnect` or restart pi session
- VS Code: restart the MCP extension or VS Code itself
- opencode: close and reopen

**5. Verify:**

Check the daemon health:
```bash
curl http://localhost:8765/health
# Expected: {"status":"ok","servers":12,"tools":130,...}
```

Check that only ONE set of MCP server processes is running:
```bash
ps aux | grep "npm exec" | grep -v grep | wc -l
# Before (3 clients): ~35 processes
# After (daemon): ~10 processes
```

### Configuration Hot-Reload

The daemon watches `~/.config/harshal-mcp-proxy/config.json` for changes, just like the
stdio mode. When you edit it:

- New servers are connected automatically
- Removed servers are disconnected
- Changed configs trigger reconnection
- `"enabled": false` disables a server without removing it

No restart needed.

---

## Config File

`~/.config/harshal-mcp-proxy/config.json` defines all upstream MCP servers.

The `lazy` field controls on-demand loading per server. When enabled, the server
process is NOT started at boot — tool schemas are loaded from a cached snapshot.
The process spawns on first use and auto-disconnects after idle timeout.

### Minimal config (one lazy server)

```json
{
  "playwright": {
    "type": "local",
    "command": ["npx", "@playwright/mcp@latest", "--extension"],
    "lazy": { "enabled": true }
  }
}
```

### All 12 servers lazy (paste this pattern on every server)

```json
{
  "repeato-backend-mcp-server": {
    "type": "local",
    "command": ["node", "server/index.js"],
    "lazy": { "enabled": true }
  },
  "neo4j-cypher": {
    "type": "local",
    "command": ["npx", "-y", "mcp-neo4j-server"],
    "lazy": { "enabled": true }
  },
  ...
}
```

```json
{
  "server-name": {
    "type": "local",
    "command": ["npx", "-y", "some-mcp-package"],
    "enabled": true,
    "lazy": {
      "enabled": true,
      "idleTimeoutMs": 300000,
      "connectTimeoutMs": 10000,
      "maxRamMb": 512,
      "prewarm": false
    }
  },
  "remote-server": {
    "type": "remote",
    "url": "http://remote-server/mcp",
    "transport": "streamable_http"
  }
}
```

### Lazy Config Options

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Enable lazy loading for this server |
| `idleTimeoutMs` | `300000` (5 min) | Disconnect after inactivity |
| `connectTimeoutMs` | `10000` (10 sec) | Abort connect if it takes longer |
| `maxRamMb` | `512` | Force-disconnect if RSS exceeds this |
| `prewarm` | `false` | Connect at startup (ignores lazy if true, but still idle-timeouts) |

### How to make all servers lazy

Simply add `"lazy": { "enabled": true }` to every server in your config.
The daemon starts instantly with 0 server processes, loading only from
catalog snapshots on disk.

### Building catalog snapshots

After enabling lazy on servers with no cached snapshot, run `--discover` once:

```bash
node dist/index.js --discover
```

This connects to ALL servers, fetches tool schemas, saves them to
`~/.cache/harshal-mcp-proxy/catalogs/<server>.json`, then exits.
After that, the daemon can load schemas from disk without spawning processes.

Environment variable substitution (`{env:VAR_NAME}`) is supported in environment fields.

---

## Token Savings Breakdown

| Component | Before | After | Savings |
|-----------|--------|-------|---------|
| MCP tool schemas (12 servers) | ~50,000 tokens | ~375 tokens (6 gateway tools) | **99.3%** |
| Tool response overhead | Unbounded | Max 64KB per response | **Bounded** |
| **Total per-session baseline** | **~50,000 tokens** | **~375 tokens** | **~99.3%** |

## Memory Savings (Daemon + Lazy Mode)

With lazy loading enabled, the daemon starts with **zero MCP server processes** — only
catalog snapshots are loaded from disk. Servers spawn on-demand and auto-disconnect
after 5 minutes of inactivity.

| Scenario | MCP Processes | RAM Used | Available |
|----------|--------------|----------|-----------|
| 2 pi sessions + VS Code (before) | ~35 processes | ~4 GB MCP overhead | ~1.5 GB |
| Shared daemon (eager) | ~10 processes | ~1.3 GB MCP overhead | ~4.8 GB |
| Shared daemon (lazy, idle) | **0 processes** | **~50 MB** | **~6.2 GB** |
| Shared daemon (lazy, active) | ~10 processes | ~1.3 GB MCP overhead | ~4.8 GB |

**At idle with lazy loading: 0 server processes, ~50 MB total RAM.**

---

## On-Demand Lazy Loading

Lazy loading is the gateway's built-in mechanism for MCP server process lifecycle
management. Instead of spawning all servers at boot, it uses **catalog snapshots** to
make tool schemas searchable immediately, while deferring process creation until
a tool is actually invoked.

### How It Works

```
STARTUP (all servers lazy):

  gateway.connectAll()
    ├─ Load searchable tool schemas from disk snapshots
    └─ Start idle monitor (checks every 30s)

  Result: 138 tools searchable, 0 server processes, ~50 MB RAM

FIRST INVOKE (e.g. gateway.invoke "playwright::browser_navigate"):

  gateway.invoke handler
    ├─ connections.ensureConnected("playwright")   ← spawns process
    ├─ connections.markServerUsed("playwright")    ← records timestamp
    └─ client.callTool("browser_navigate")         ← executes

  Result: Playwright process running, tool executed, snapshot saved

IDLE (5+ minutes of no use):

  idle monitor (every 30s):
    └─ "playwright" idle for 319s > 300s timeout → disconnect

  Result: Playwright process killed, still searchable via snapshot

NEXT INVOKE:
  └─ ensureConnected() → respawns from scratch (snapshot already cached)
```

### What happens to `gateway.search`?

Search results show a `connected` field so you can tell at a glance which servers
are active vs. available-on-demand:

```json
{
  "results": [
    {
      "id": "neo4j-cypher::execute_query",
      "server": "neo4j-cypher",
      "connected": false,     // ← not running, will spawn on invoke
      "score": 51.68
    },
    {
      "id": "repeato-backend-mcp-server::health_check",
      "server": "repeato-backend-mcp-server",
      "connected": true,      // ← currently active
      "score": 42.0
    }
  ]
}
```

### Per-Server vs Global Lazy

- **Per-server `lazy.enabled`** — set in `config.json`. Each server independently
  controls whether it loads on-demand or eagerly. You can mix eager (frequently used)
  and lazy (rarely used) servers in the same config.
- **`--discover` mode** — force-connects ALL servers (ignoring lazy) to build or
  refresh catalog snapshots. Run once after adding a new server, then shut down.

### Auto-Disconnect: Idle Monitor

The idle monitor checks every 30 seconds and disconnects servers that have been
inactive longer than `idleTimeoutMs` (default 5 minutes).

- Uses `lastUsedAt` timestamp updated by every `gateway.invoke` call
- 5-second safety buffer prevents disconnect during rapid successive calls
- Resource monitor can also force-disconnect if RSS exceeds `maxRamMb`
- Disconnected servers remain searchable — their tool schemas stay in SearchEngine

### Auto-Disconnect: Resource Monitor

For servers with `maxRamMb` set, the resource monitor polls RSS every 10 seconds.
If a server exceeds the limit, it's force-disconnected regardless of idle time.

### Catalog Snapshots

When a server connects (eagerly or on-demand), its tool schemas are saved to disk:

```
~/.cache/harshal-mcp-proxy/catalogs/
├── repeato-backend-mcp-server.json   # 51 tools
├── neo4j-cypher.json                 # 3 tools
├── playwright.json                   # 23 tools
├── ...
```

These snapshots are loaded at startup so the SearchEngine knows every tool without
spawning a single process. They're refreshed each time a server reconnects.

### CLI Reference

| Flag | Purpose |
|------|---------|
| `(none)` | Stdio mode — config-driven lazy loading |
| `--daemon` | HTTP daemon mode — config-driven lazy loading |
| `--port <N>` | HTTP daemon on custom port |
| `--discover` | Force-connect ALL servers, build snapshots, exit |

---

## Files

```
harshal-mcp-proxy/
├── src/
│   ├── index.ts              # Entry point — stdio, HTTP daemon, or --discover
│   ├── gateway.ts            # Orchestrator — wires everything together
│   ├── http-server.ts        # HTTP daemon — JSON-RPC 2.0 over HTTP POST
│   ├── handlers.ts           # 6 gateway tool registrations
│   ├── connections.ts        # Upstream MCP server connections + lazy loading
│   ├── search.ts             # BM25 search engine (MiniSearch)
│   ├── response-store.ts     # ResponseStore + ResponseShield
│   ├── jobs.ts               # Async job queue
│   ├── config.ts             # Config loader + file watcher
│   ├── types.ts              # All TypeScript interfaces
│   ├── connection-state.ts   # Connection state machine helpers
│   ├── lazy-config.ts        # Lazy config normalization + defaults
│   ├── catalog-snapshot.ts   # Disk-based tool schema snapshots
│   └── resource-monitor.ts   # PID discovery + RSS polling
├── dist/                  # Compiled JS output
├── harshal-mcp-proxy.service  # Systemd user service unit
├── config.json            # Default upstream server config
├── README.md              # This file
├── AGENT-CONTEXT.md       # Teach any LLM how to call the gateway
├── SETUP_PROMPT.md        # AI-pasteable setup instructions
├── package.json
└── tsconfig.json
```

## Differences from mcp-gateway and tldr

| Feature | mcp-gateway | tldr | harshal-mcp-proxy |
|---------|------------|------|-------------------|
| Schema deferral (search→describe→invoke) | ✅ | ✅ | ✅ |
| Response shielding (truncation) | ❌ | ✅ | ✅ |
| Response pagination (get_result) | ❌ | ✅ | ✅ |
| Smart field stripping | ❌ | ✅ | ✅ |
| Language | TypeScript | Go | TypeScript |
| MCP SDK | JS SDK | Go SDK | JS SDK |
| Async job queue | ✅ | ❌ | ✅ |
| Config hot-reload | ✅ | ❌ | ✅ |
| Text search in stored results | ❌ | ✅ (ripgrep) | ✅ (in-memory) |
| Multi-client HTTP daemon mode | ❌ | ❌ | ✅ |
| Systemd service integration | ❌ | ❌ | ✅ |
| On-demand lazy loading | ❌ | ❌ | ✅ |
| Catalog snapshots (disk cache) | ❌ | ❌ | ✅ |
| Idle monitor (auto-disconnect) | ❌ | ❌ | ✅ |
| CLI snapshot builder (--discover) | ❌ | ❌ | ✅ |
| Dependencies | SDK + MiniSearch + LRU | Go stdlib | SDK + MiniSearch + Zod |
