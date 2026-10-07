# Session Orchestrator

## Code comments

Do not write comments in the JavaScript, MJS, HTML script or shell code you patch. No block comments, no line comments, no JSDoc, no TODO notes.

Names, types and tests carry the meaning. A comment that explains a change, a workaround or a ticket belongs in the commit, the issue or the PR.

Lint and type directives (`eslint-disable`, `@ts-check`, `@ts-expect-error`), a shebang and legal notices are fine. `local/no-comments` in `eslint.config.js` enforces this. It does not apply to Markdown.

## Zero runtime dependencies

The app (`scan.mjs`, `lib/`, `index.html` and `office/*.js`) imports only `node:` built-ins and loads no external resource: no CDN, no font, no analytics.

`devDependencies` in `package.json` are for tooling only. Never add Playwright to `package.json`; `test/check.mjs` loads it from `PW_DIR`, outside the repo.

## Local-only and privacy

The server binds to 127.0.0.1 and makes no network calls.

Never commit, and never put in an issue or PR: real paths, user names, session ids, transcript text, or screenshots of real data. Tests and the demo use generic made-up names.

## The demo works from disk

`index.html?demo=1` must keep working when opened from disk (`file://`). Page code uses classic scripts, not ES modules: it lives in `office/*.js`, loaded in order by `index.html`. Keep each file under 800 lines.

## Typed state without comments

`tsconfig.page.json` has `strictNullChecks` on. Page code has no JSDoc, so a field that starts empty gets its type from an example behind the `TYPE_ONLY` constant in `office/base.js`: `anim: TYPE_ONLY ? newAnim(0, [], [], [], 0) : null`, `queue: TYPE_ONLY ? [''] : []`. The example is never evaluated. Look up DOM nodes with `elementById` and `canvasById`, and canvas contexts with `context2d`.

## Every PR has a GitHub issue first

Create a GitHub issue before opening a PR. The issue title is the problem. Put `Closes #N` in the PR body. Use existing labels; do not invent new ones.

Keep PRs small and single-purpose.

## Checks before a PR

Run `npm run check` (lint, typecheck, unit tests).

For UI changes also run the Playwright suite and look at the screenshots at 1280x720 and 390x844:

```
PW_DIR=<scratch dir with playwright> SHOTS=<scratch dir> node test/check.mjs
```

## Plugin version

`claude plugin update` compares only the `version` in `.claude-plugin/plugin.json`. A merged commit with the same version reports "already at the latest version" and the cache keeps the old commit.

Bump the patch version in any PR that changes what users run: `scan.mjs`, `lib/`, `index.html`, page scripts, `skills/`, or the plugin manifests.
