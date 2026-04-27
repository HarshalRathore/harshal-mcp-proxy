/**
 * projectRegistry.ts — Auto-discovers codegraph projects from the filesystem.
 *
 * Scans a root directory for `.codegraph/` folders and registers them as projects.
 * This means new projects are auto-available without any config changes.
 *
 * Scan roots are provided via constructor and can come from:
 *   - The `SCAN_ROOTS` environment variable (comma-separated paths)
 *   - The current working directory (default)
 *
 * Example:
 *   SCAN_ROOTS=/home/user/project1,/home/user/project2
 *     → project1/.codegraph/ → project "project1"
 *     → project2/.codegraph/ → project "project2"
 */
import type { CodeGraphProject } from "./types.js";
export declare class ProjectRegistry {
    private scanRoots;
    private projects;
    private defaultProject;
    constructor(scanRoots?: string[]);
    /**
     * Scan all roots for `.codegraph/` directories and register them.
     * Sets the first-discovered as default unless config specifies one.
     */
    discover(configDefaultProject?: string): void;
    /**
     * Resolve a project name or path to an absolute path.
     * - If already absolute path with .codegraph/, return as-is
     * - If project name, look up in registry
     * - If not found, return as-is (let codegraph fail naturally)
     */
    resolveProjectPath(input?: string): string | undefined;
    get projectsList(): CodeGraphProject[];
    get defaultProjectName(): string | null;
}
