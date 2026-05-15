# harshal-mcp-proxy — Agent Context for LLMs

Copy this file into your AI coding agent's project (or feed it directly) so it
understands how to discover, describe, and invoke tools through the gateway.

**Recommended placement:**
- **Pi:** Drop into `.pi/rules/mcp-proxy-context.md` and reference in `.pi/APPEND_SYSTEM.md`
- **Claude Code / Opencode:** Drop into `.opencode/rules/mcp-proxy-context.md`
- **VS Code (Cline etc.):** Include in `.clinerules` or `CLAUDE.md`
- **Cursor:** Add to `.cursorrules`
- **Windsurf:** Add to `.windsurfrules`
- **Any agent:** Paste directly into the conversation or reference in `AGENTS.md`

---

## What Is This?

harshal-mcp-proxy is a shared MCP gateway that sits between AI coding agents and
upstream MCP servers. Instead of your agent connecting to 12+ individual MCP servers
(each with its own tool schemas, processes, and RAM usage), it connects to **6 gateway
tools** via a single MCP connection.

The proxy handles:
- **Schema deferral** — Tool schemas aren't loaded at startup. You `search` to find
  tools by description, `describe` to get the full schema, and `invoke` to execute.
- **Response shielding** — Large responses are auto-truncated and paginated so your
  context window doesn't fill up.
- **Lazy loading** — Upstream MCP servers start at **zero processes**. They
  auto-connect on your first `invoke` and auto-disconnect after 5 minutes of idle.
- **Shared daemon** — One proxy instance serves ALL your clients (pi, VS Code,
  Cursor, etc.), eliminating duplicate MCP server processes.

---

## How to Connect

The proxy speaks standard MCP over HTTP (daemon mode) or stdio. Configure your agent
to connect to it like any other MCP server.

| Agent | Config | Mode |
|-------|--------|------|
| **Pi** | `mcp.json` → `url: "http://localhost:8765/mcp"` | Streamable HTTP |
| **Claude Code / Opencode** | `opencode.json` → `type: "remote"`, `transport: "streamable_http"` | Remote HTTP |
| **VS Code (Cline, Continue)** | `.vscode/mcp.json` → `type: "streamableHttp"`, `url` | Streamable HTTP |
| **Cursor** | `.cursor/mcp.json` → `type: "streamableHttp"` | Streamable HTTP |
| **Any stdio-compatible** | Run `harshal-mcp-proxy` as a subprocess | Stdio |

**Important:** Replace ALL individual MCP server entries in your agent config with
**just this one entry**. The proxy manages all upstream servers internally.

---

## The 6 Gateway Tools

These are the ONLY tools your agent sees. All upstream MCP servers are accessed
through them.

### 1. `gateway.search` — Discover Tools by Description

Search across ALL upstream servers using BM25 fuzzy matching. This is your entry
point — you don't need to know server names or tool IDs upfront.

```
gateway.search(query: string, limit?: number, server?: string)
```

**Returns:**
```json
{
  "query": "run cypher query",
  "found": 3,
  "connectedServers": ["neo4j-cypher", "neo4j-memory"],
  "results": [
    {
      "id": "neo4j-cypher::execute_query",
      "name": "execute_query",
      "displayName": "executeQuery",
      "server": "neo4j-cypher",
      "connected": true,
      "description": "Execute a Cypher query on Neo4j database",
      "fieldNames": ["query", "params"],
      "score": 51.68
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `id` | Tool ID in format `"serverName::toolName"` — use this for `describe` and `invoke` |
| `connected` | `true` = server process active, `false` = lazy (will auto-connect on invoke) |
| `description` | Truncated to 120 chars. Use `describe` for the full description. |
| `fieldNames` | Parameter names (not types). Use `describe` for full schema. |
| `score` | BM25 relevance score (higher = better match) |

### 2. `gateway.describe` — Get Full Parameter Schema

Get the complete input schema (parameter names, types, required/optional, defaults,
valid values) for a specific tool. Use the `id` from `gateway.search` results.

```
gateway.describe(id: string)
```

**Returns:**
```json
{
  "id": "neo4j-cypher::execute_query",
  "server": "neo4j-cypher",
  "name": "execute_query",
  "title": "executeQuery",
  "description": "Execute a Cypher query on Neo4j database",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Cypher query to execute" },
      "params": { "type": "object", "description": "Query parameters" }
    },
    "required": ["query"]
  },
  "outputSchema": { ... }
}
```

### 3. `gateway.invoke` — Execute a Tool (Auto-Connect)

This is where the work happens. Call a tool by its `id` with the arguments from
`describe`. **Lazy servers auto-connect on first invoke** — no manual connect step
needed. After 5 minutes of idle, servers auto-disconnect.

```
gateway.invoke(id: string, args: object, timeoutMs?: number)
```

**Returns:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "{ \"result\": \"...\" }"
    }
  ],
  "metadata": {
    "requestId": "req_xxx",
    "tool": "execute_query",
    "timestamp": "2026-01-01T00:00:00.000Z",
    "duration": "unknown"
  }
}
```

**If the result was truncated** (large responses), `metadata` will include:
- `ref` — use this with `get_result` to paginate
- The response body will include `_ref`, `_truncated: true`, and `_note`

**Example — simple call:**
```
gateway.invoke(id: "neo4j-cypher::execute_query", args: { query: "MATCH (n) RETURN n LIMIT 10" })
```

**Example — with timeout:**
```
gateway.invoke(id: "playwright::browser_navigate", args: { url: "https://example.com" }, timeoutMs: 30000)
```

### 4. `gateway.invoke_async` — Queue Background Execution

For long-running tools (web search, E2E tests, data-heavy queries), queue the job
and poll for results.

```
gateway.invoke_async(id: string, args: object, priority?: number)
```

**Returns:** `{ jobId: "job_xxx", status: "queued", toolId: "..." }`

### 5. `gateway.invoke_status` — Poll Async Job

```
gateway.invoke_status(jobId: string)
```

**Returns:** `{ jobId, status: "queued"|"running"|"completed"|"failed", result?, logs?, ... }`

### 6. `gateway.get_result` — Paginate Truncated Responses

When `gateway.invoke` returns `_ref`, use this to retrieve the full data with
pagination, field projection, and text search.

```
gateway.get_result(ref: string, offset?: number, limit?: number, fields?: string[], search?: string)
```

**Example — get next page:**
```
gateway.get_result(ref: "r3", offset: 50, limit: 50)
```

**Example — project specific fields:**
```
gateway.get_result(ref: "r3", fields: ["name", "id", "status"])
```

**Example — search within results:**
```
gateway.get_result(ref: "r3", search: "error")
```

---

## The Standard Workflow

```
1. SEARCH ────────────────────────
   gateway.search({ query: "cypher query" })
   → "id": "neo4j-cypher::execute_query"

2. DESCRIBE (skip if you know params)
   gateway.describe({ id: "neo4j-cypher::execute_query" })
   → { inputSchema: { query: "string", params: "object" } }

3. INVOKE ────────────────────────
   gateway.invoke({ id: "neo4j-cypher::execute_query", args: { query: "..." } })
   → { content: [...], metadata: { ref: "r3" } }

4. PAGINATE (if _ref present)
   gateway.get_result({ ref: "r3", offset: 50, limit: 50 })
   → next 50 items
```

---

## Lazy Loading (No Manual Steps Needed)

The proxy uses on-demand process management by default:

| Phase | What Happens | RAM |
|-------|-------------|-----|
| **Startup** | Tool schemas loaded from disk snapshots. **0 server processes.** | ~50 MB |
| **First Invoke** | Server process spawns, connects, executes, saves updated snapshot | +RAM for that server |
| **5 min idle** | Idle monitor disconnects server. Still searchable via snapshot. | ~50 MB again |
| **Next Invoke** | Server respawns automatically | +RAM again |

You don't need to pre-connect, check status, or manually disconnect. Just invoke
any tool — if the server isn't running, it starts automatically.

**Note on first invoke latency:** The first call to a lazy server will be slower
(5-15 seconds) because it needs to spawn the process. Subsequent calls to the same
server within the idle window are fast.

---

## Self-Healing Note (Important!)

**If the examples above don't work for your agent:**

1. **Search first** — Use `gateway.search` to discover the actual tool IDs and names.
   Tool names may differ between MCP server versions.

2. **Describe for schema** — Always use `gateway.describe` to get the exact parameter
   schema. Don't assume parameter names from memory.

3. **Try alternative formats** — Some agent frameworks wrap MCP calls differently:
   - Some expect `gateway.invoke` as a function call
   - Some expect JSON-RPC directly
   - Some use `mcp()` wrapper with tool namespacing
   - Try: `gateway.invoke`, `mcp.invoke`, `harshal_mcp_proxy_gateway.invoke`, etc.

4. **Once you find the correct call pattern**, create or update a rules file for your
   agent framework so future sessions don't have to rediscover it:
   - **Pi:** Create `.pi/rules/mcp-proxy-context.md` with the working patterns
   - **Claude Code / Opencode:** Create `.opencode/rules/mcp-proxy-context.md`
   - **VS Code (Cline):** Add to `.clinerules`
   - **Cursor:** Add to `.cursorrules`
   - **Windsurf:** Add to `.windsurfrules`
   - **Any:** Add to `AGENTS.md`, `CLAUDE.md`, or equivalent

---

## Troubleshooting Cheat Sheet

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `Tool not found: myServer::myTool` | Wrong tool ID | Search with `gateway.search` first to find the actual ID |
| `Server not connected: xyz` | Lazy server, first call | This is normal — it will connect. Retry if timeout. |
| Response has `_ref` and `_truncated: true` | Result too large | Call `gateway.get_result({ ref, offset, limit })` |
| `ERROR: ...` in response | Tool returned an error | Check the error message and fix your args |
| Slow first call to a server (5-15s) | Server process spawning | Normal for lazy servers. Subsequent calls are fast. |
| `Parse error` from gateway | Invalid JSON in args | Double-check your argument JSON |
| `Method not found` | Wrong tool name | Gateway exposes ONLY 6 tools: `gateway.search`, `gateway.describe`, `gateway.invoke`, `gateway.invoke_async`, `gateway.invoke_status`, `gateway.get_result` |

---

## Quick Reference (TL;DR)

```text
SEARCH:    gateway.search({ query: "natural language", limit: 5 })
           → find tool IDs

DESCRIBE:  gateway.describe({ id: "server::tool" })
           → get parameter schema

INVOKE:    gateway.invoke({ id: "server::tool", args: { ... } })
           → execute (auto-connects lazy servers)

PAGINATE:  gateway.get_result({ ref: "r3", offset: 50, limit: 50 })
           → read truncated data

ASYNC:     gateway.invoke_async({ id: "server::tool", args: { ... } })
           → gateway.invoke_status({ jobId: "job_xxx" })
           → poll for completion
```
