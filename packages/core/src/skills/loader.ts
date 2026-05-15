// Phase 13: load project-level skills at module-load time so Iris's Explorer
// and Judge prompts can consult the skill body as durable evaluator
// discipline. Provider-neutral skills live under `packages/core/src/skills`;
// legacy `.claude/skills/<name>/SKILL.md` files remain as a compatibility
// fallback for older checkouts.
//
// The skill body (frontmatter stripped) is prepended to the system prompts.
// Transport-specific prompt caching is handled by the caller; this loader keeps
// evaluator methodology shared across Claude, Codex, and other providers.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, '.claude', 'skills'))) return dir;
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// Strip YAML frontmatter (--- ... ---) from a markdown file's content. We
// prepend the body to a system prompt; the frontmatter is metadata for skill
// discovery, not runtime instruction.
function stripFrontmatter(content: string): string {
  const m = content.match(/^---\n[\s\S]*?\n---\n/);
  return m ? content.slice(m[0].length) : content;
}

export function loadProjectSkill(name: string): string {
  const moduleDir = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return process.cwd();
    }
  })();

  // Try the runtime CWD first (when iris is run from the project root) and
  // fall back to the module's own location (when iris is run from elsewhere
  // but resolves through dist/).
  const roots = [process.cwd(), moduleDir]
    .map((d) => findProjectRoot(d))
    .filter((r): r is string => r !== null);

  for (const root of roots) {
    const paths = [
      join(root, 'packages', 'core', 'src', 'skills', `${name}.md`),
      join(root, 'packages', 'core', 'dist', 'skills', `${name}.md`),
      join(root, '.claude', 'skills', name, 'SKILL.md'),
    ];
    for (const path of paths) {
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, 'utf8');
        return stripFrontmatter(content).trim();
      } catch {
        // fall through to next candidate
      }
    }
  }
  return '';
}
