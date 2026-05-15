# Auto-Setup Prompt for harshal-mcp-proxy

Copy the entire content below and paste it into your AI coding agent (Claude Code, pi, opencode, etc.) to automatically set up and configure harshal-mcp-proxy on your machine.

---

````
You are setting up harshal-mcp-proxy — a shared MCP gateway that sits between AI coding agents and upstream MCP servers.

## Goal

Install and configure harshal-mcp-proxy so that ALL of the user's AI tools (pi, VS Code, opencode) share ONE set of MCP server processes, eliminating duplicate memory usage.

## Architecture

Instead of each AI client spawning its own MCP servers:

┌──────────────┐     ┌────────────────────────┐     ┌──────────────────┐
│  pi session  │────►│                        │────►│  12 MCP servers  │
├──────────────┤     │  harshal-mcp-proxy     │     │  (ONE set,       │
│  pi session 2│────►│  daemon (port 8765)    │────►│  1.3 GB RAM)     │
├──────────────┤     │                        │     └──────────────────┘
│  VS Code     │────►│                        │
└──────────────┘     └────────────────────────┘

Saves ~2.7 GB RAM versus running 3 separate MCP process fleets.

## Steps

### Step 1: Install

**Option A — Install from npm (recommended, no clone needed):**

```bash
npm install -g harshal-mcp-proxy
```

**Option B — Clone from source:**

```bash
gh repo clone HarshalRathore/harshal-mcp-proxy
cd harshal-mcp-proxy
npm install
npm run build
```

### Step 2: Create config

Copy the example config and customize it:

```bash
mkdir -p ~/.config/harshal-mcp-proxy

# If installed from npm:
cp $(npm root -g)/harshal-mcp-proxy/config.example.json ~/.config/harshal-mcp-proxy/config.json

# If cloned from source:
# cp config.example.json ~/.config/harshal-mcp-proxy/config.json
```

Edit `~/.config/harshal-mcp-proxy/config.json`:
- Set `{env:VAR_NAME}` placeholders by exporting environment variables, OR replace them inline
- Disable servers the user doesn't need by setting `"enabled": false`
- For any server with an absolute path, update it to the user's system

### Step 3: Enable systemd user service

```bash
mkdir -p ~/.config/systemd/user

# If installed from npm, get the service file:
cp $(npm root -g)/harshal-mcp-proxy/harshal-mcp-proxy.service ~/.config/systemd/user/

# If cloned from source:
# cp harshal-mcp-proxy.service ~/.config/systemd/user/

# Edit the service file to match your setup:
# - For npm install: uncomment the "harshal-mcp-proxy --daemon" ExecStart line
# - For source clone: set the full path to dist/index.js
# Update the config path to your actual home directory:
sed -i "s|/home/username/|$HOME/|" ~/.config/systemd/user/harshal-mcp-proxy.service
```

Enable and start the service:

```bash
systemctl --user daemon-reload
systemctl --user enable harshal-mcp-proxy
systemctl --user start harshal-mcp-proxy
```

### Step 4: Verify daemon is working

```bash
curl http://localhost:8765/health
# Expected: {"status":"ok","servers":12,"tools":130,...}

curl -X POST http://localhost:8765/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# Expected: 6 gateway tools
```

### Step 5: Configure pi

Create or update `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "harshal-mcp-proxy": {
      "url": "http://localhost:8765/mcp"
    }
  }
}
```

Then reload pi with `/mcp reconnect` or restart pi.

### Step 6: Configure VS Code

Update `<project>/.vscode/mcp.json`:

```json
{
  "servers": {
    "harshal-mcp-proxy": {
      "type": "streamableHttp",
      "url": "http://localhost:8765/mcp"
    }
  }
}
```

Remove all individual MCP server entries. Restart VS Code or reload MCP extension.

### Step 7: Clean up old processes

```bash
# Kill any old individually-spawned MCP servers
pkill -f "npm exec" 2>/dev/null

# Verify only ONE set remains
ps aux | grep "npm exec" | grep -v grep | wc -l
# Should show ~10 processes (one set), not 30+
```

## Verification Checklist

- [ ] `curl http://localhost:8765/health` returns `"status": "ok"`
- [ ] `systemctl --user is-active harshal-mcp-proxy` returns `active`
- [ ] `systemctl --user is-enabled harshal-mcp-proxy` returns `enabled`
- [ ] Daemon auto-starts on boot
- [ ] pi can discover and use tools via `mcp({ search: "..." })`
- [ ] Only ~10 npm exec processes running (one set)
- [ ] Memory usage is ~2-3 GB lower than before

## Troubleshooting

- **Daemon won't start**: Check `journalctl --user -u harshal-mcp-proxy -f` for errors
- **Config not loading**: Ensure config.json is valid JSON at `~/.config/harshal-mcp-proxy/config.json`
- **Cannot connect on port 8765**: Check if port is already in use with `lsof -i :8765`
- **pi can't find tools**: Run `/mcp reconnect` in pi, or check `~/.pi/agent/mcp.json` exists
- **VS Code shows no tools**: Restart VS Code after updating `.vscode/mcp.json`
- **Fallback to stdio**: If daemon fails, run `harshal-mcp-proxy` directly for single-client mode

## Post-Setup: Teach Your Agent (Final Step)

After installation, verify the agent can actually use the proxy:

1. Check that `AGENT-CONTEXT.md` is loaded by your agent
2. Ask your agent to run: `gateway.search({ query: "health" })`
3. If it works, great! Your agent learned the call pattern.
4. If it doesn't, the agent should use the **Self-Healing Note** in AGENT-CONTEXT.md
   to try alternative call formats, discover the correct one, and **update its own
   rules file** so it doesn't forget.

Once verified, you're done. The proxy is running, your agent knows how to use it,
and all your AI tools share one efficient set of MCP servers.
````
