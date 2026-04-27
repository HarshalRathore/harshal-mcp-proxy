# harshal-mcp-proxy

Custom MCP gateway that sits between your AI clients (pi, VS Code, opencode) and your
upstream MCP servers. Combines **schema deferral** (from
[mcp-gateway](https://github.com/eznix86/mcp-gateway)) with **response shielding**
(from [tldr](https://github.com/robinojw/tldr)) in a single TypeScript server.

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
integration, verification, and troubleshooting — all in one shot.

---

## Installation

```bash
# 1. Clone to your machine
git clone <repo-url> /path/to/harshal-mcp-proxy
cd /path/to/harshal-mcp-proxy

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Create config from template (EDIT THIS with your values)
cp config.example.json ~/.config/harshal-mcp-proxy/config.json
# ⚠️ Edit ~/.config/harshal-mcp-proxy/config.json with your API keys and paths

# 5. Verify it works (stdio mode)
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

Copy the service file to your user systemd directory:

```bash
mkdir -p ~/.config/systemd/user
cp harshal-mcp-proxy.service ~/.config/systemd/user/
# OR create it manually:
cat > ~/.config/systemd/user/harshal-mcp-proxy.service << 'SERVICEEOF'
[Unit]
Description=harshal-mcp-proxy daemon — shared MCP gateway
Documentation=https://github.com/your-org/harshal-mcp-proxy
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/harshal-mcp-proxy/dist/index.js --daemon /home/your-user/.config/harshal-mcp-proxy/config.json
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
SERVICEEOF
```

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

`~/.config/harshal-mcp-proxy/config.json` defines all upstream MCP servers:

```json
{
  "server-name": {
    "type": "local",
    "command": ["npx", "-y", "some-mcp-package"],
    "enabled": true
  },
  "remote-server": {
    "type": "remote",
    "url": "http://remote-server/mcp",
    "transport": "streamable_http"
  }
}
```

Environment variable substitution (`{env:VAR_NAME}`) is supported in environment fields.

---

## Token Savings Breakdown

| Component | Before | After | Savings |
|-----------|--------|-------|---------|
| MCP tool schemas (12 servers) | ~50,000 tokens | ~375 tokens (6 gateway tools) | **99.3%** |
| Tool response overhead | Unbounded | Max 64KB per response | **Bounded** |
| **Total per-session baseline** | **~50,000 tokens** | **~375 tokens** | **~99.3%** |

## Memory Savings (Daemon Mode)

| Scenario | MCP Processes | RAM Used | Available |
|----------|--------------|----------|-----------|
| 2 pi sessions + VS Code (before) | ~35 processes | ~4 GB MCP overhead | ~1.5 GB |
| Shared daemon (after) | ~10 processes | ~1.3 GB MCP overhead | ~4.8 GB |
| **Saved** | **25 processes** | **~2.7 GB** | **+3.3 GB** |

---

## Files

```
harshal-mcp-proxy/
├── src/
│   ├── index.ts           # Entry point — stdio or HTTP daemon mode
│   ├── gateway.ts         # Orchestrator — wires everything together
│   ├── http-server.ts     # HTTP daemon — JSON-RPC 2.0 over HTTP POST
│   ├── handlers.ts        # 6 gateway tool registrations
│   ├── connections.ts     # Upstream MCP server connections
│   ├── search.ts          # BM25 search engine (MiniSearch)
│   ├── response-store.ts  # ResponseStore + ResponseShield
│   ├── jobs.ts            # Async job queue
│   ├── config.ts          # Config loader + file watcher
│   └── types.ts           # All TypeScript interfaces
├── dist/                  # Compiled JS output
├── harshal-mcp-proxy.service  # Systemd user service unit
├── config.json            # Default upstream server config
├── README.md              # This file
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
| Dependencies | SDK + MiniSearch + LRU | Go stdlib | SDK + MiniSearch + Zod |
