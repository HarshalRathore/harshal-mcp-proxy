# Auto-Setup Prompt for harshal-mcp-proxy

Copy the entire content below and paste it into your AI coding agent (Claude Code, pi, opencode, etc.) to automatically set up and configure harshal-mcp-proxy on your machine.

---

````
You are setting up harshal-mcp-proxy — a shared MCP gateway that sits between AI coding agents and upstream MCP servers. Follow the steps below exactly, substituting placeholders when needed. Explain each command before running it and stop if any command fails (return non-zero). When you write a file or service unit, show the exact file content and the absolute path you will use.

Placeholders you MUST replace before running:
- <REPO_PATH> = absolute path to the harshal-mcp-proxy repo on disk (e.g., /home/USERNAME/projects/harshal-mcp-proxy)
- <USERNAME> = system username running the service (for systemd user typically the same as the current user)
- <NODE_BIN> = absolute path to node (use `which node` to find it). If you prefer PATH lookup, use `/usr/bin/env node` in ExecStart.
- <CONFIG_PATH> = ~/.config/harshal-mcp-proxy/config.json (expand ~ to absolute path)

Goal:
- Build the project, create a user config, install a systemd user service (or give cross-platform alternative), start it, and verify the daemon responds at http://localhost:8765.

Step 0: Sanity and environment checks
- Print working directory and node/npm versions:
  - `pwd`
  - `<NODE_BIN> --version` (or `node --version`)
  - `npm --version`
- If node version < 16, warn and stop. Ask user if they want to continue anyway.

Step 1: Build (reproducible)
- Instruct: "I'll change to the repo and install dependencies."
- Commands:
  - `cd "<REPO_PATH>"`
  - If package-lock.json exists use `npm ci`, else `npm install`
  - `npm run build`
- If any step fails, show the failing output and stop.

Step 2: Create config
- Copy example to user config dir:
  - `mkdir -p "$HOME/.config/harshal-mcp-proxy"`
  - `cp config.example.json "$HOME/.config/harshal-mcp-proxy/config.json"`
  - `chmod 600 "$HOME/.config/harshal-mcp-proxy/config.json"`
- Validate JSON:
  - `jq . "$HOME/.config/harshal-mcp-proxy/config.json"` (if jq missing, `node -e "console.log(JSON.stringify(require(process.argv[1]),null,2))" "$HOME/.config/harshal-mcp-proxy/config.json"`)
- Replace `{env:VAR_NAME}` placeholders by:
  - Either export environment variables in the shell or edit the file in-place. If editing, show the exact JSON patch you will make.
- Note: If any server paths are absolute in config, update them to your system executable paths.

Step 3: Systemd user service (preferred on Linux)
- Explain how to find node path: `which node` → set <NODE_BIN>.
- Create the systemd user unit file at: `~/.config/systemd/user/harshal-mcp-proxy.service`
- Suggest content (use exact paths):
  - ExecStart example:
    - Preferred: `ExecStart=<NODE_BIN> <REPO_PATH>/dist/index.js --daemon <CONFIG_PATH>`
    - Alternative: `ExecStart=/usr/bin/env node <REPO_PATH>/dist/index.js --daemon <CONFIG_PATH>` (note: systemd uses a clean PATH)
- Create the file, set owner and permissions.
- Commands to run:
  - `systemctl --user daemon-reload`
  - `systemctl --user enable --now harshal-mcp-proxy`
- If you want the service to run at boot without an interactive login, instruct the user to run (administrator privilege may be required):
  - `sudo loginctl enable-linger <USERNAME>`
- If systemd is not available (macOS/Windows), provide alternatives:
  - macOS: create a launchd plist (example) or run as `brew services`/`launchctl`.
  - Windows: recommend NSSM/winsw or Task Scheduler to run node with the same ExecStart command.

Step 4: Verify daemon
- Health check:
  - `curl -sS http://localhost:8765/health | jq .`
  - Expected top-level keys: status:"ok", servers: numeric
- Example tool query:
  - `curl -sS -X POST http://localhost:8765/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq .`
- If curl fails, show `journalctl --user -u harshal-mcp-proxy -n 200 --no-pager` output.
- If port 8765 is in use, show `lsof -i :8765` and suggest alternatives.

Step 5: Configure clients
- For pi:
  - Ensure file `~/.pi/agent/mcp.json` contains:
    {
      "mcpServers": {
        "harshal-mcp-proxy": { "url": "http://localhost:8765/mcp" }
      }
    }
  - Validate JSON and instruct how to reload pi: `/mcp reconnect` or restart.
- For VS Code:
  - Update `.vscode/mcp.json` in project(s):
    {
      "servers": {
        "harshal-mcp-proxy": {
          "type": "streamableHttp",
          "url": "http://localhost:8765/mcp"
        }
      }
    }
  - Restart VS Code or reload the MCP extension.

Step 6: Clean up old processes
- Show safe kill procedure:
  - `pkill -f "npm exec" || true`
  - Verify remaining: `ps aux | grep "npm exec" | grep -v grep | wc -l`
  - Explain expected counts.

Step 7: Troubleshooting and logs
- To watch logs in real time:
  - `journalctl --user -u harshal-mcp-proxy -f`
- Common checks:
  - Config JSON invalid → jq parse error
  - Permission errors → check ownership and chmod 600 config file
  - Port conflict → `lsof -i :8765`
  - SELinux: `sudo ausearch -m avc -ts recent` (or temporarily set permissive)
- Suggest running `node dist/index.js --daemon "$HOME/.config/harshal-mcp-proxy/config.json"` interactively for debugging.

Security & operational notes
- Do not expose port 8765 publicly. If you need remote access, put it behind an SSH tunnel or reverse proxy with auth.
- Keep config.json permissions tight (chmod 600).
- Consider using system-level process supervisors (systemd/podman/containers) in production to manage restarts and isolation.

Confirmation
- At the end of the run, print:
  - `systemctl --user is-active harshal-mcp-proxy` (should be active)
  - `curl -sS http://localhost:8765/health | jq .status` (should be "ok")
  - `ps aux | grep -E "node .*dist/index.js|npm exec"` (show lines)

Stop and report back any non-zero exit code, errors, or unexpected responses, and include the last 200 lines of the service log.

---

If you want, I can now:
1) Produce a ready-to-run systemd unit file and exact commands with your replacements filled in (give me <REPO_PATH> and <USERNAME>), or
2) Walk through the setup interactively and explain each command before running it.
````
