/**
 * jobs.ts — Async job queue for long-running tool invocations.
 *
 * When the model calls gateway.invoke_async, the job is queued here.
 * Max 3 concurrent jobs run at once. The model polls via gateway.invoke_status.
 *
 * Jobs are stored in a Map with a max of 200 entries (oldest evicted).
 */

import type { JobRecord } from "./types.js";

/** Max concurrent job executions */
const MAX_CONCURRENT_JOBS = 3;

/** Max time to wait for running jobs during shutdown */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/** Max stored jobs before eviction */
const MAX_JOBS = 200;

export class JobManager {
  /** All jobs (queued, running, completed, failed) */
  private jobs = new Map<string, JobRecord>();

  /** Insertion order for eviction */
  private jobOrder: string[] = [];

  /** Queue of job IDs waiting to run, highest priority first */
  private queue: string[] = [];

  /** Currently running job count */
  private runningCount = 0;

  /** The function that actually executes a job (set by gateway after construction) */
  private executeFn: ((job: JobRecord) => Promise<void>) | null = null;

  /** Set the job execution function (called by gateway with access to connections) */
  setExecuteJob(fn: (job: JobRecord) => Promise<void>): void {
    this.executeFn = fn;
  }

  /**
   * Create a new queued job.
   *
   * @param toolId - Composite tool ID (e.g. "neo4j-cypher::run_cypher_query")
   * @param args - Arguments to pass to the tool
   * @param priority - Higher priority jobs run first (default 0)
   */
  createJob(toolId: string, args: Record<string, unknown>, priority = 0): JobRecord {
    const job: JobRecord = {
      id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      status: "queued",
      toolId,
      args,
      priority,
      createdAt: Date.now(),
      logs: [`Job created: ${toolId}`],
    };

    // Evict oldest jobs if at capacity
    while (this.jobs.size >= MAX_JOBS) {
      const oldest = this.jobOrder.shift();
      if (oldest === undefined) break;
      this.jobs.delete(oldest);
    }

    this.jobs.set(job.id, job);
    this.jobOrder.push(job.id);

    // Insert into queue sorted by priority (descending)
    this.queue.push(job.id);
    this.queue.sort((a, b) => (this.jobs.get(b)?.priority ?? 0) - (this.jobs.get(a)?.priority ?? 0));

    return job;
  }

  /** Get a job by ID */
  getJob(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Process the queue — start jobs up to MAX_CONCURRENT_JOBS.
   * Called after createJob and again whenever a job finishes.
   */
  processQueue(): void {
    while (this.runningCount < MAX_CONCURRENT_JOBS && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (jobId === undefined) break;

      const job = this.jobs.get(jobId);
      if (!job || !this.executeFn) continue;

      this.runningCount++;
      job.status = "running";
      job.startedAt = Date.now();
      job.logs.push(`Started at ${new Date().toISOString()}`);

      this.executeFn(job)
        .then(() => {
          job.status = "completed";
          job.finishedAt = Date.now();
          job.logs.push(`Completed in ${job.finishedAt - (job.startedAt ?? job.createdAt)}ms`);
        })
        .catch((err) => {
          job.status = "failed";
          job.finishedAt = Date.now();
          job.error = err instanceof Error ? err.message : String(err);
          job.logs.push(`Failed: ${job.error}`);
        })
        .finally(() => {
          this.runningCount--;
          this.processQueue(); // Try to start the next queued job
        });
    }
  }

  /** Graceful shutdown: drain queue, wait for running jobs */
  async shutdown(): Promise<void> {
    // Clear the queue so no new jobs start
    this.queue = [];

    // Wait for running jobs to finish (with timeout)
    const startTime = Date.now();
    while (this.runningCount > 0 && Date.now() - startTime < SHUTDOWN_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (this.runningCount > 0) {
      console.error(`  [jobs] Shutdown timeout — ${this.runningCount} jobs still running`);
    }
  }

  /** Get queue stats for debugging */
  getStats(): { queued: number; running: number; total: number } {
    return {
      queued: this.queue.length,
      running: this.runningCount,
      total: this.jobs.size,
    };
  }
}
