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
import type { UpstreamConfig } from "./types.js";

export interface ResourceUsage {
  ramMb: number | null;
  cpuPercent: number | null; // not yet implemented, always null
}

export interface ResourceLimit {
  serverKey: string;
  maxRamMb: number;
  maxUptimeMs: number;
  idleTimeoutMs: number;
}

export class ResourceMonitor {
  private intervalId?: ReturnType<typeof setInterval>;
  private limits = new Map<string, ResourceLimit>();
  private pids = new Map<string, number>();

  /** Register a server for monitoring */
  register(serverKey: string, config: UpstreamConfig): void {
    const maxRamMb = config.lazy?.maxRamMb || 0;
    const maxUptimeMs = config.lazy?.maxUptimeMs || 0;
    const idleTimeoutMs = config.lazy?.idleTimeoutMs || 0;

    if (maxRamMb > 0 || maxUptimeMs > 0) {
      this.limits.set(serverKey, { serverKey, maxRamMb, maxUptimeMs, idleTimeoutMs });
    }
  }

  /** Unregister a server from monitoring */
  unregister(serverKey: string): void {
    this.limits.delete(serverKey);
    this.pids.delete(serverKey);
  }

  /** Record the PID for a stdio server process */
  setPid(serverKey: string, pid: number): void {
    this.pids.set(serverKey, pid);
  }

  /** Clear the PID (e.g., on disconnect) */
  clearPid(serverKey: string): void {
    this.pids.delete(serverKey);
  }

  /** Start periodic monitoring */
  startMonitoring(
    intervalMs: number,
    onLimitExceeded: (serverKey: string, usage: ResourceUsage, reason: string) => void
  ): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      for (const [serverKey, limit] of this.limits) {
        const pid = this.pids.get(serverKey);
        if (!pid) continue;

        const usage = this.getUsage(pid);

        if (limit.maxRamMb > 0 && usage.ramMb && usage.ramMb > limit.maxRamMb) {
          onLimitExceeded(serverKey, usage, `RAM limit exceeded: ${usage.ramMb.toFixed(1)}MB > ${limit.maxRamMb}MB`);
          continue;
        }
      }
    }, intervalMs);
  }

  /** Stop periodic monitoring */
  stopMonitoring(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  /** Get current resource usage for a PID */
  getUsage(pid: number): ResourceUsage {
    return {
      ramMb: this.getProcessRamMB(pid),
      cpuPercent: null, // TODO: implement if needed
    };
  }

  /** Try Linux /proc first, then ps fallback */
  private getProcessRamMB(pid: number): number | null {
    // Linux fast path
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf-8");
      const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
      if (match) {
        return parseInt(match[1], 10) / 1024;
      }
    } catch {
      // Not Linux or no permission
    }

    // macOS / generic fallback
    try {
      const output = execSync(`ps -p ${pid} -o rss=`, { encoding: "utf-8", timeout: 1000 }).trim();
      const kb = parseInt(output, 10);
      if (!isNaN(kb)) {
        return kb / 1024;
      }
    } catch {
      // ps failed
    }

    return null;
  }

  /**
   * Find child PIDs spawned by this Node.js process.
   * Used to auto-discover stdio child process PIDs.
   */
  findChildPids(parentPid: number): Array<{ pid: number; cmd: string }> {
    try {
      const output = execSync(
        `ps -o pid,comm --ppid ${parentPid} --no-headers`,
        { encoding: "utf-8", timeout: 2000 }
      );
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
    } catch {
      return [];
    }
  }

  /** Match a child PID by command pattern (for stdio servers) */
  findPidByCommand(pattern: string, parentPid: number = process.pid): number | undefined {
    const children = this.findChildPids(parentPid);
    const match = children.find((c) => c.cmd.toLowerCase().includes(pattern.toLowerCase()));
    return match?.pid;
  }
}
