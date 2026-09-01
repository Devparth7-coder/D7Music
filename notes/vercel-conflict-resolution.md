# Resolving the five conflicted files on the Vercel branch

Two of these files exist only on your side (`apps/api/tsconfig.json`, `apps/web/tsconfig.json`), and
`.vercelignore` is new; the two that collide with my changes are `vercel.json` and
`apps/api/package.json`. Everything below is the state that passes the full sweep in the reference
workspace — `typecheck` clean, `npm run typecheck -w @d7/api` clean, `npm run deploy:check` →
`vercel layout OK`, `npm run docs:check` OK, **56 tests passed** — so overwriting both sides of a
hunk with these contents is safe; there is nothing in the conflicted versions that this set lacks
except your two tsconfigs, which are handled in §3 and §4.

## 1. `vercel.json` — take this side

Three lines in it are what made the last two deploys fail, so a hand-merge that keeps your old
values re-breaks them: `installCommand` (devDependencies under `NODE_ENV=production`), `buildCommand`
(a layout/toolchain check before `tsc`), and `functions.runtime`.

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "installCommand": "npm ci --include=dev",
  "buildCommand": "npm run deploy:check && npm run typecheck",
  "framework": null,
  "functions": {
    "api/index.ts": {
      "runtime": "nodejs22.x",
      "maxDuration": 60,
      "memory": 1024,
      "includeFiles": "packages/database/migrations/**"
    }
  },
  "rewrites": [{ "source": "/(.*)", "destination": "/api/index" }],
  "crons": [
    { "path": "/api/jobs/release-sync", "schedule": "0 3 * * *" },
    { "path": "/api/jobs/recommendations", "schedule": "0 4 * * *" },
    { "path": "/api/jobs/trending", "schedule": "0 5 * * *" },
    { "path": "/api/jobs/reindex", "schedule": "0 6 * * *" },
    { "path": "/api/jobs/queue-drain", "schedule": "0 7 * * *" }
  ],
  "headers": [
    { "source": "/api/(.*)", "headers": [{ "key": "Cache-Control", "value": "no-store" }] },
    { "source": "/media/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] }
  ]
}
```

Validated against Vercel's published JSON schema (which sets `additionalProperties: false`, so do not
add comments or a `_comment` key — that alone will fail the build). Keep the file minifiable either
way: pretty-printed or not, the keys are what matter.

## 2. `apps/api/package.json` — only the `typecheck` line matters

```json
  "scripts": {
    "dev": "tsx watch --clear-screen=false src/main.ts",
    "start": "node --import tsx src/main.ts",
    "typecheck": "tsc -p ../../tsconfig.json --noEmit"
  }
```

`tsc -p tsconfig.json` (the older line) is what produced `error TS5058` — this repository typechecks
as one project at the root, so the workspace script has to point at the root manifest to work when a
platform runs it with the cwd inside `apps/api`. If your side of the conflict also touched
`optionalDependencies` (`@aws-sdk/*`) or `dependencies`, keep yours — those are independent of the
deploy failure, and note that `tsx` must stay in `dependencies`, not `devDependencies`: it is how the
function runs, and a production install will not fetch a devDependency.

## 3. `apps/api/tsconfig.json` — either delete it or widen its `include`

I tested both, with a deliberate type error injected into `api/index.ts` (then reverted byte-identical):

| Version | Result |
| --- | --- |
| `{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts"] }` | `tsc -p apps/api/tsconfig.json` exits **0** — it does not see the error, because `api/index.ts` (the deploy entry) and `tests/` are outside `src` |
| same, with `"include": ["src/**/*.ts", "../../api/**/*.ts"]` | exits **2**, `api/index.ts(19,7): error TS2322` — the same message the root project prints |
| the root project, unchanged | exits **2**, same error ✓ |

So: **deleting the file costs nothing** (the root project already covers `apps/api/**/*.ts` and
`api/**/*.ts`), and if you keep it for editor/IDE reasons, keep it only with the widened `include`, or
you have quietly created a typecheck that skips the one file Vercel builds:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "../../api/**/*.ts"]
}
```

If you do keep it, revert §2's script back to `tsc -p tsconfig.json --noEmit` — one of the two, not
both, or the API gets checked twice per CI run.

## 4. `apps/web/tsconfig.json` — delete it

`apps/web` contains `package.json` and nothing else, so any tsconfig with real `include` patterns
fails on the spot:

```
error TS18003: No inputs were found in config file '/…/apps/web/tsconfig.json'.
Specified 'include' paths were '["**/*.ts","**/*.tsx"]' and 'exclude' paths were '[]'.   (exit 2)
```

The web tier is documented as pending in `docs/DEPLOYMENT.md` §7, and its `typecheck` script is an
`echo` saying so. Add the tsconfig back with the front end itself (`next.config.*`, `app/` or `pages/`)
— at which point Vercel's framework detection changes the picture entirely and this file deserves a
re-read.

## 5. `.vercelignore` — keep it to build artefacts, or drop the file

There is no `.vercelignore` in the reference workspace and nothing needs one: `node_modules`, `.data/`,
`storage/`, `dist/` and `*.log` are already in `.gitignore`, and a Git-based deploy starts from the
commit. An over-broad pattern here is the same class of self-inflicted failure as a wrong Root
Directory — the build silently never sees the file. Anything under `api/`, `apps/`, `packages/`,
`services/`, `jobs/`, `scripts/`, `vercel.json`, `tsconfig*.json` or `package-lock.json` must stay.
If it lists e.g. `docs/` or `*.md`, that is harmless; if it lists `scripts/`, `npm run deploy:check`
cannot even start. If you tell me what you added it for, I will pick the exact lines; the safe minimal
version is:

```
.vercel/
*.tsbuildinfo
coverage/
```

## 6. After you resolve

```bash
grep -rn '^<<<<<<<\|^>>>>>>>\|^=======$' --include='*.json' --include='*.ts' --include='*.mts' . \
  | grep -v node_modules              # must print nothing
npm ci --include=dev                  # proves the lockfile is still in sync
npm run deploy:check                  # → vercel layout OK — /path/to/d7music
npm run typecheck                     # clean
npm run typecheck -w @d7/api          # clean — this is the one that used to fail with TS5058
npm run docs:check                    # → docs check OK — 6 documents, 12 migrations, 94 env vars
npm test                              # → 56 passed
git add -A && git commit              # only once the four commands above are silent/green
```

`deploy:check` will keep telling you the truth about the two ways this deploy has failed so far: a
build rooted in `apps/api`, and a `NODE_ENV=production` install with no devDependencies.
