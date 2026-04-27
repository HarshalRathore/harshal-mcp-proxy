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
import { readdirSync, existsSync } from "fs";
import { join } from "path";
export class ProjectRegistry {
    scanRoots;
    projects = new Map();
    defaultProject = null;
    constructor(scanRoots = []) {
        this.scanRoots = scanRoots;
    }
    /**
     * Scan all roots for `.codegraph/` directories and register them.
     * Sets the first-discovered as default unless config specifies one.
     */
    discover(configDefaultProject) {
        this.projects.clear();
        const discovered = [];
        for (const root of this.scanRoots) {
            if (!existsSync(root))
                continue;
            try {
                const entries = readdirSync(root, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory())
                        continue;
                    const codegraphPath = join(root, entry.name, ".codegraph");
                    if (existsSync(codegraphPath)) {
                        this.projects.set(entry.name, join(root, entry.name));
                        discovered.push(entry.name);
                    }
                }
            }
            catch {
                // Skip roots we can't read
            }
        }
        if (configDefaultProject && this.projects.has(configDefaultProject)) {
            this.defaultProject = configDefaultProject;
        }
        else if (discovered.length > 0) {
            const preferred = discovered.find((n) => n.includes("backend")) || discovered[0];
            this.defaultProject = preferred;
        }
    }
    /**
     * Resolve a project name or path to an absolute path.
     * - If already absolute path with .codegraph/, return as-is
     * - If project name, look up in registry
     * - If not found, return as-is (let codegraph fail naturally)
     */
    resolveProjectPath(input) {
        if (!input) {
            return this.defaultProject ? this.projects.get(this.defaultProject) : undefined;
        }
        // Already an absolute path ending in .codegraph
        if (input.endsWith(".codegraph") && existsSync(input)) {
            return input;
        }
        // Project name
        if (this.projects.has(input)) {
            return this.projects.get(input);
        }
        return undefined;
    }
    get projectsList() {
        return Array.from(this.projects.entries()).map(([name, path]) => ({ name, path }));
    }
    get defaultProjectName() {
        return this.defaultProject;
    }
}
//# sourceMappingURL=projectRegistry.js.map