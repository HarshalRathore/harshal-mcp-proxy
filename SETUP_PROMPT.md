# Auto-Setup Prompt for harshal-mcp-proxy

Copy the entire content below and paste it into your AI coding agent (Claude Code, pi, opencode, etc.) to automatically set up and configure harshal-mcp-proxy on your machine.

---

```
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

### Step 1: Build

```bash
cd /path/to/harshal-mcp-proxy
npm install
npm run build
```

### Step 2: Create config

Copy the example config and customize it:

```bash
cp config.example.json ~/.config/harshal-mcp-proxy/config.json
```

Edit `~/.config/harshal-mcp-proxy/config.json`:
- Set `{env:VAR_NAME}` placeholders by exporting environment variables, OR replace them inline
- Disable servers the user doesn't need by setting `"enabled": false`
- For any server with an absolute path, update it to the user's system

### Step 3: Enable systemd user service

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/harshal-mcp-proxy.service << 'EOF'
[Unit]
Description=harshal-mcp-proxy daemon — shared MCP gateway
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /ABSOLUTE/PATH/TO/harshal-mcp-proxy/dist/index.js --daemon /home/USERNAME/.config/harshal-mcp-proxy/config.json
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

# Fix the ExecStart path to match actual location
```

Update the `ExecStart` path in the service file to match the actual installation directory.

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
- **Fallback to stdio**: If daemon fails, run `node dist/index.js` directly for single-client mode
```
