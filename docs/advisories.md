# npm audit: what it reports, and why each advisory does not apply here

Read on 2026-10-19 against `package-lock.json` at `@mastra/core` 1.78.0, `@mastra/mcp` 2.4.1 and
`mastra` 1.34.2, the newest stable versions on that day. `npm audit` reports 10 packages, 5 high and
5 moderate. All of them come from two advisories. Neither advisory has a patched version, so no
override or pin can fix them. The way out is upstream: `@mastra/deployer` and `@mastra/core`
1.79.0-alpha.3 no longer depend on `find-workspaces` or `gray-matter`. Bump when 1.79.0 is released
as stable, then read `npm audit` again.

## GHSA-vfj7-8cjw-p6xm: braces, high (the 5 high entries)

- **The advisory.** braces through 3.0.3 overflows the stack on deeply nested brace patterns. There
  is no patched version: 3.0.3 is the newest on npm.
- **The path.** `mastra` (the CLI, a dev dependency), then `@mastra/deployer`, `find-workspaces`,
  `fast-glob`, `micromatch` and `braces`. npm reports each package on the path, which makes up the
  five.
- **Why it does not apply.** Only the CLI loads it, at `mastra dev` and `mastra build`, to find the
  project's workspaces. It matches patterns from this repository's own files, never from a contact,
  the node or a web page. The served process does not have it: after `mastra build`,
  `.mastra/output/node_modules` holds none of `braces`, `micromatch`, `fast-glob` or
  `find-workspaces`.

## GHSA-hp3w-g68c-fv3c: sprintf-js, moderate (the 5 moderate entries)

- **The advisory.** sprintf-js through 1.1.3 throws on a format string with an unbounded precision.
  There is no patched version.
- **The path.** `@mastra/core`, then `gray-matter`, `js-yaml` 3, `argparse` 1 and `sprintf-js`.
  The served process ships all four: `.mastra/output/node_modules` holds `gray-matter`, `js-yaml`,
  `argparse` and `sprintf-js`.
- **Why it does not apply.**
  - Only `argparse` calls sprintf-js, and only `js-yaml`'s command-line script
    (`bin/js-yaml.js`) requires `argparse`. The library that `gray-matter` loads does not.
  - `@mastra/core` calls `gray-matter` only for skills: it reads a skill file's front matter
    (`extractSkillFrontmatter`), and it writes the SKILL.md of an inline skill
    (`InlineSkillSource`, with `matter.stringify`). This agent is given no workspace and no
    skills.
  - The format strings `argparse` passes are its own constants, never input.
