# harshal-mcp-proxy

Custom MCP gateway that sits between opencode and your upstream MCP servers. Combines
**schema deferral** (from [mcp-gateway](https://github.com/eznix86/mcp-gateway)) with
**response shielding** (from [tldr](https://github.com/robinojw/tldr)) in a single
TypeScript server — built specifically for your 7-server setup.

## What it does

Instead of opencode loading 40-70K tokens of tool schemas from 7 MCP servers at startup,
it loads **6 tool definitions from this proxy** (~375 tokens). The proxy then:

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

## Architecture

```
┌─────────────────┐     stdio      ┌──────────────────────────┐
│    opencode      │ ──────────── → │   harshal-mcp-proxy      │
│  (sees 6 tools)  │ ← ──────────  │                          │
└─────────────────┘                │  ┌──────────────────┐    │
                                   │  │  SearchEngine     │    │  ← BM25 index
                                   │  │  (MiniSearch)     │    │
                                   │  └──────────────────┘    │
                                   │  ┌──────────────────┐    │
                                   │  │  ResponseShield   │    │  ← Truncation engine
                                   │  │  ResponseStore    │    │  ← Ring buffer (100)
                                   │  └──────────────────┘    │
                                   │  ┌──────────────────┐    │
                                   │  │  ConnectionMgr    │ ───── → upstream MCP servers
                                   │  └──────────────────┘    │     (7 servers, stdio)
                                   └──────────────────────────┘
```

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

## Installation

```bash
# 1. Clone/copy to your machine
cp -r harshal-mcp-proxy /home/harshal/harshal/harshal-mcp-proxy

# 2. Install dependencies
cd /home/harshal/harshal/harshal-mcp-proxy
npm install

# 3. Build
npm run build

# 4. Create config directory and copy config
mkdir -p ~/.config/harshal-mcp-proxy
cp config.json ~/.config/harshal-mcp-proxy/config.json

# 5. Verify it starts
node dist/index.js
# Should print: harshal-mcp-proxy starting (stdio)...
# Then: __MCP_GATEWAY_STDIO_READY__
# Ctrl+C to stop
```

## OpenCode Configuration

Replace your entire MCP block in `opencode.json` with:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    // The gateway — replaces all 7 active servers with 1 entry
    "harshal-mcp-proxy": {
      "type": "local",
      "command": ["node", "/home/harshal/harshal/harshal-mcp-proxy/dist/index.js"]
    },

    // Keep disabled servers as-is (they bypass the gateway)
    "context7": { "enabled": false, "type": "local", "command": ["npx", "-y", "@upstash/context7-mcp"] },
    "shadcn": { "enabled": false, "type": "local", "command": ["npx", "shadcn@latest", "mcp"] },
    "radix-ui": { "enabled": false, "type": "local", "command": ["npx", "@gianpieropuleo/radix-mcp-server@latest"] },
    "stackoverflow": { "enabled": false, "type": "local", "command": ["npx", "-y", "@notalk-tech/stackoverflow-mcp"] },
    "next-devtools": { "enabled": false, "type": "local", "command": ["npx", "-y", "next-devtools-mcp@latest"] },
    "lucide-icons": { "enabled": false, "type": "local", "command": ["npx", "lucide-icons-mcp", "--stdio"] },
    "qdrant": { "enabled": false, "type": "local", "command": ["/home/harshal/harshal/qdrant-mcp/bin/mcp-server-qdrant"] },
    "vercel": { "enabled": false, "type": "remote", "url": "https://mcp.vercel.com" }
  }
}
```

## AGENTS.md Snippet

Add this to your `~/.config/opencode/AGENTS.md` or project `AGENTS.md`:

```markdown
## MCP Tool Usage (harshal-mcp-proxy gateway)

All active MCP tools are accessed through the gateway proxy.
ALWAYS use this 3-step pattern — never guess tool names:

1. `gateway.search` { query: "what you need", limit: 5 }
2. `gateway.describe` { id: "serverKey::toolName" }
3. `gateway.invoke` { id: "serverKey::toolName", args: {...} }

If a response includes `_ref` (e.g. "r3"), the result was truncated.
Use `gateway.get_result` { ref: "r3", offset: 0, limit: 50 } to paginate.
Use `fields: ["name", "id"]` to project only needed columns.
Use `search: "keyword"` to filter within stored results.

Available servers: repeato-backend-mcp-server, sequential-thinking, playwright,
tavily-remote-mcp, neo4j-memory, neo4j-cypher, searxng

Tool ID format: `serverKey::toolName` (e.g. `playwright::browser_navigate`)
```

## Also Enable Auto-Compaction

Add this to your `opencode.json` alongside the MCP block:

```json
{
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 8000
  }
}
```

- `auto: true` — triggers compaction when context fills up
- `prune: true` — removes stale tool outputs automatically each turn
- `reserved: 8000` — keeps 8K tokens free for model generation

## Token Savings Breakdown

| Component | Before | After | Savings |
|-----------|--------|-------|---------|
| MCP tool schemas (7 servers) | ~50,000 tokens | ~375 tokens (6 gateway tools) | **99.3%** |
| Tool response overhead | Unbounded | Max 64KB per response | Bounded |
| Rules files (see LAZY-RULES.md) | ~12,500 tokens | ~1,125 tokens | **91%** |
| **Total per-session baseline** | **~62,500 tokens** | **~1,500 tokens** | **~97.6%** |

## Config Hot-Reload

The proxy watches `~/.config/harshal-mcp-proxy/config.json` for changes. When you edit it:

- New servers are connected automatically
- Removed servers are disconnected
- Changed configs trigger reconnection
- `"enabled": false` disables a server without removing it

No need to restart opencode.

## Files

```
harshal-mcp-proxy/
├── src/
│   ├── index.ts           # Entry point — starts stdio transport
│   ├── gateway.ts         # Orchestrator — wires everything together
│   ├── handlers.ts        # 6 gateway tool registrations
│   ├── connections.ts     # Upstream MCP server connections
│   ├── search.ts          # BM25 search engine (MiniSearch)
│   ├── response-store.ts  # ResponseStore + ResponseShield (the novel piece)
│   ├── jobs.ts            # Async job queue
│   ├── config.ts          # Config loader + file watcher
│   └── types.ts           # All TypeScript interfaces
├── dist/                  # Compiled JS output
├── config.json            # Default upstream server config
├── LAZY-RULES.md          # Guide for lazy-loading opencode rules
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
| Built for opencode | Generic | Multi-harness | opencode-specific |
| Dependencies | SDK + MiniSearch + LRU | Go stdlib | SDK + MiniSearch + Zod |
