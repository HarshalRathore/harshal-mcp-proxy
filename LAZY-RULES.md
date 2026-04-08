# Lazy Rules Loading for OpenCode

## The Problem

Your `instructions: [".opencode/rules/*.md"]` loads **all 12 rule files (~50KB+)** into
context on every session start. This is the single biggest per-session token leak — it
costs ~12,500 tokens before you even type anything.

## The Solution: Skills + Domain-Scoped Agents

OpenCode has two native mechanisms that together replace the "load everything upfront" pattern:

### Strategy 1: Convert Rules to Skills (Lazy-Loaded on Demand)

OpenCode skills are loaded **only when the agent calls the `skill` tool**. They're
announced in context as ~150-token summaries, not full content.

**Before (eager, ~50KB in context):**
```
instructions: [".opencode/rules/*.md"]
```

**After (lazy, ~1.5KB of skill summaries):**

1. Create `.opencode/skills/` directory
2. For each rule domain, create a `SKILL.md`:

```
.opencode/skills/
├── testing/
│   └── SKILL.md          # E2E testing rules, Playwright patterns
├── neo4j/
│   └── SKILL.md          # Cypher query rules, graph patterns
├── nextjs/
│   └── SKILL.md          # Next.js conventions, App Router rules
├── api-design/
│   └── SKILL.md          # REST/GraphQL conventions
├── git-workflow/
│   └── SKILL.md          # Commit message format, branch naming
├── security/
│   └── SKILL.md          # Auth patterns, input validation
└── code-style/
    └── SKILL.md          # Linting rules, naming conventions
```

Each `SKILL.md` follows this format:

```markdown
---
name: testing
description: E2E testing rules for Playwright and Vitest. Load when writing or debugging tests.
---

# Testing Rules

## Playwright E2E Tests
- Always use `page.waitForSelector()` before interactions
- Use `data-testid` attributes, never CSS selectors
- ...your actual rules here...

## Vitest Unit Tests
- Co-locate tests with source files as `*.test.ts`
- ...
```

The agent sees only the `name` + `description` line in its context.
When it encounters a testing task, it calls `skill("testing")` and
the full rules are loaded into context for that task only.

### Strategy 2: Scope Remaining Rules to Specific Agents

For rules that MUST be enforced on every interaction (not suitable for lazy loading),
assign them to specific subagents instead of loading them globally.

**In `opencode.json`, scope agent instructions:**

```jsonc
{
  "agents": {
    // Main orchestrator — minimal rules only
    "main": {
      "model": "anthropic:claude-sonnet-4-20250514",
      "instructions": [
        // ONLY load the absolute essentials here (~2-3KB max):
        ".opencode/rules/core.md"   // project structure, build commands
      ]
    },
    // Testing agent — gets testing rules
    "tester": {
      "model": "qwen:qwen3-plus-free",
      "instructions": [
        ".opencode/rules/testing.md",
        ".opencode/rules/playwright.md"
      ]
    },
    // Database agent — gets Neo4j rules
    "db": {
      "model": "qwen:qwen3-plus-free",
      "instructions": [
        ".opencode/rules/neo4j.md",
        ".opencode/rules/cypher-patterns.md"
      ]
    },
    // Code explorer — gets code style rules
    "explorer": {
      "model": "qwen:qwen3-plus-free",
      "instructions": [
        ".opencode/rules/code-style.md"
      ]
    }
  }
}
```

Each subagent only loads the rules it needs. The main Sonnet agent
stays lean with just the core project context.

### Strategy 3: Compress Your Core Rules

For the rules that DO stay in `instructions`, apply these compression techniques:

**1. Remove guidance the model already knows:**

```markdown
<!-- REMOVE — GPT-4/Sonnet already know this -->
- Write clean, readable code
- Use descriptive variable names
- Handle errors properly

<!-- KEEP — project-specific, model can't infer this -->
- All API routes must use the `withAuth()` middleware from `lib/auth.ts`
- Neo4j connections use the shared pool from `lib/neo4j.ts`, never direct
- The `repeato-backend` test suite requires `NODE_ENV=test` and a running Neo4j
```

**2. Replace examples with imperative rules:**

```markdown
<!-- BEFORE: 15 lines, ~300 tokens -->
## Example: Creating a new API route
Here's an example of a properly structured API route:
```typescript
// app/api/users/route.ts
import { withAuth } from '@/lib/auth'
import { db } from '@/lib/neo4j'
// ... 10 more lines of example code
```

<!-- AFTER: 3 lines, ~60 tokens -->
## API Routes
- File: `app/api/{resource}/route.ts`
- Wrap handler with `withAuth()` from `@/lib/auth`
- Use `db` from `@/lib/neo4j` for all graph queries
```

**3. Use tabular format for dense rules:**

```markdown
| Pattern | File | Convention |
|---------|------|------------|
| API routes | `app/api/*/route.ts` | Always use `withAuth()` wrapper |
| Components | `components/*.tsx` | PascalCase, co-locate styles |
| Tests | `__tests__/*.test.ts` | Mirror source structure |
| Neo4j queries | `lib/queries/*.ts` | Parameterized, never string concat |
```

## Implementation Checklist

1. **Audit your 12 rule files** — categorize each as:
   - `CORE` — must load every session (project structure, build commands)
   - `DOMAIN` — convert to skill (testing, neo4j, nextjs, etc.)
   - `REMOVE` — model already knows this (general coding best practices)

2. **Create skills** for each DOMAIN category:
   ```bash
   mkdir -p .opencode/skills/{testing,neo4j,nextjs,api-design,git-workflow,security,code-style}
   # Move rule content into SKILL.md files
   ```

3. **Compress CORE rules** using the techniques above — target <3KB

4. **Update `instructions` array** to only reference the compressed core:
   ```json
   {
     "instructions": [".opencode/rules/core.md"]
   }
   ```

5. **Scope agent instructions** in `opencode.json` for domain-specific agents

## Expected Token Savings

| Component | Before | After |
|-----------|--------|-------|
| Rules loaded at session start | ~12,500 tokens (50KB) | ~750 tokens (3KB core) |
| Skill summaries in context | 0 | ~375 tokens (7 skills × ~50 tokens) |
| Domain rules when needed | always loaded | ~1,500 tokens per skill (on demand) |
| **Per-session baseline** | **~12,500 tokens** | **~1,125 tokens** |
| **Reduction** | | **~91%** |
