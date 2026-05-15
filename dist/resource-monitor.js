/**
 * resource-monitor.ts — Poll child process resources for lazy-loaded MCP servers.
 *
 * Uses platform-specific methods to find child PIDs and measure RAM:
 *   Linux: /proc/<pid>/status (fast, no subprocess)
 *   macOS: ps -p <pid> -o rss= (fallback)
 *   Other: ps --ppid <ppid> (process tree scan)
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
export class ResourceMonitor {
    intervalId;
    limits = new Map();
    pids = new Map();
    /** Register a server for monitoring */
    register(serverKey, config) {
        const maxRamMb = config.lazy?.maxRamMb || 0;
        const maxUptimeMs = config.lazy?.maxUptimeMs || 0;
        const idleTimeoutMs = config.lazy?.idleTimeoutMs || 0;
        if (maxRamMb > 0 || maxUptimeMs > 0) {
            this.limits.set(serverKey, { serverKey, maxRamMb, maxUptimeMs, idleTimeoutMs });
        }
    }
    /** Unregister a server from monitoring */
    unregister(serverKey) {
        this.limits.delete(serverKey);
        this.pids.delete(serverKey);
    }
    /** Record the PID for a stdio server process */
    setPid(serverKey, pid) {
        this.pids.set(serverKey, pid);
    }
    /** Clear the PID (e.g., on disconnect) */
    clearPid(serverKey) {
        this.pids.delete(serverKey);
    }
    /** Start periodic monitoring */
    startMonitoring(intervalMs, onLimitExceeded) {
        if (this.intervalId)
            return;
        this.intervalId = setInterval(() => {
            for (const [serverKey, limit] of this.limits) {
                const pid = this.pids.get(serverKey);
                if (!pid)
                    continue;
                const usage = this.getUsage(pid);
                if (limit.maxRamMb > 0 && usage.ramMb && usage.ramMb > limit.maxRamMb) {
                    onLimitExceeded(serverKey, usage, `RAM limit exceeded: ${usage.ramMb.toFixed(1)}MB > ${limit.maxRamMb}MB`);
                    continue;
                }
            }
        }, intervalMs);
    }
    /** Stop periodic monitoring */
    stopMonitoring() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }
    /** Get current resource usage for a PID */
    getUsage(pid) {
        return {
            ramMb: this.getProcessRamMB(pid),
            cpuPercent: null, // TODO: implement if needed
        };
    }
    /** Try Linux /proc first, then ps fallback */
    getProcessRamMB(pid) {
        // Linux fast path
        try {
            const status = readFileSync(`/proc/${pid}/status`, "utf-8");
            const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
            if (match) {
                return parseInt(match[1], 10) / 1024;
            }
        }
        catch {
            // Not Linux or no permission
        }
        // macOS / generic fallback
        try {
            const output = execSync(`ps -p ${pid} -o rss=`, { encoding: "utf-8", timeout: 1000 }).trim();
            const kb = parseInt(output, 10);
            if (!isNaN(kb)) {
                return kb / 1024;
            }
        }
        catch {
            // ps failed
        }
        return null;
    }
    /**
     * Find child PIDs spawned by this Node.js process.
     * Used to auto-discover stdio child process PIDs.
     */
    findChildPids(parentPid) {
        try {
            const output = execSync(`ps -o pid,comm --ppid ${parentPid} --no-headers`, { encoding: "utf-8", timeout: 2000 });
            return output
                .trim()
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                const parts = line.split(/\s+/);
                const pid = parseInt(parts[0], 10);
                const cmd = parts.slice(1).join(" ");
                return { pid, cmd };
            })
                .filter((p) => !isNaN(p.pid));
        }
        catch {
            return [];
        }
    }
    /** Match a child PID by command pattern (for stdio servers) */
    findPidByCommand(pattern, parentPid = process.pid) {
        const children = this.findChildPids(parentPid);
        const match = children.find((c) => c.cmd.toLowerCase().includes(pattern.toLowerCase()));
        return match?.pid;
    }
}
//# sourceMappingURL=resource-monitor.js.map