/**
 * jobs.ts — Async job queue for long-running tool invocations.
 *
 * When the model calls gateway.invoke_async, the job is queued here.
 * Max 3 concurrent jobs run at once. The model polls via gateway.invoke_status.
 *
 * Jobs are stored in a Map with a max of 200 entries (oldest evicted).
 * No LRU dependency — we use a simple insertion-order eviction.
 */
import type { JobRecord } from "./types.js";
export declare class JobManager {
    /** All jobs (queued, running, completed, failed) */
    private jobs;
    /** Insertion order for eviction */
    private jobOrder;
    /** Queue of job IDs waiting to run */
    private queue;
    /** Currently running job count */
    private runningCount;
    /** The function that actually executes a job (set by gateway after construction) */
    private executeFn;
    constructor();
    /** Set the job execution function (called by gateway with access to connections) */
    setExecuteJob(fn: (job: JobRecord) => Promise<void>): void;
    /**
     * Create a new queued job.
     *
     * @param toolId - Composite tool ID (e.g. "neo4j-cypher::run_cypher_query")
     * @param args - Arguments to pass to the tool
     * @param priority - Higher priority jobs run first (default 0)
     * @returns The created job record
     */
    createJob(toolId: string, args: unknown, priority?: number): JobRecord;
    /** Get a job by ID */
    getJob(jobId: string): JobRecord | undefined;
    /**
     * Process the queue — start jobs up to MAX_CONCURRENT_JOBS.
     * Called after createJob and after a job finishes.
     */
    processQueue(): void;
    /** Graceful shutdown: drain queue, wait for running jobs */
    shutdown(): Promise<void>;
    /** Get queue stats for debugging */
    getStats(): {
        queued: number;
        running: number;
        total: number;
    };
}
