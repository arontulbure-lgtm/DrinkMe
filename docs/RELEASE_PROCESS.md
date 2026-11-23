# Release process: the clean release repository

The development repository (this one, `arontulbure-lgtm/DrinkMe`) holds the app, the server, the ai-service and the development tooling with its run logs. Releases are published from a **separate, clean repository**, `arontulbure-lgtm/drinkme-release` (private), which holds only what the product needs. This file stays in the development repository; the export leaves it out.

## 1. Regenerate the export
```powershell
cd D:\DrinkMeApp\DrinkMeFinal
git checkout main; git pull
npm run release:export                     # main → D:\DrinkMeApp\_release\drinkme-clean
npm run release:export -- --ref v1.0.0-rc1 # a tag or any committed ref
npm run release:export -- --out D:\some\empty\folder
npm run release:export -- --check-only     # only the zero-hit check on an existing export
```
What it does (`scripts/release-export.mjs`, tests in `server/test/release-export.test.js`):
1. `git archive` of the committed ref into the output folder: a plain folder, not a git worktree. Untracked and git-ignored files (`.env`, service-account keys, `server/data`, `logs/`, `node_modules`) can never be in it. The folder is replaced only if an earlier export made it (marker file `.drinkme-release-export` with the source commit).
2. Leaves out:
   - the development tooling: `.claude/`, `agents/`, every `CLAUDE.md`, `memory.md` and `codex.memory.md`
   - run logs and run release notes: `*RUN_LOG*.md`, `docs/RELEASE_NOTES_run-*.md`
   - session data: `reports/`, `logs/`
   - `.vscode/`
   - internal process and history documents: `docs/JOHN_TODO.md`, `docs/SECURITY_ROTATION.md`, `docs/ai/PROGRESS.md`, this file
   - the export script and its test
3. Copies the internal contract documents (AI service, recipe schema, ingredient taxonomy, backend API, legal framework) to `docs/contracts/<name>.md` without their front matter, and rewrites every reference to them.
4. `package.json`: removes the agents tooling dependency and the `agent:*` and `release:export` scripts. It then regenerates `package-lock.json` (lock only, npm cache on `D:\DrinkMeApp\.npm-cache`).
5. `.gitignore`: drops the tooling lines.
6. **Zero-hit check:** a case-insensitive search over every exported file, lock files and Python requirements included. The forbidden terms are listed in the script: AI-assistant and vendor names, commit trailers, `agent:` tooling scripts, and AI SDK packages (`openai`, `@anthropic-ai/*`). Any hit fails the command and lists `file:line`.

If the check fails, fix the source in this repository (reword the product file, or add a development-only file to the exclude list in the script and its test), commit, and export again. Never edit the export by hand.

## 2. Verify the export
In `D:\DrinkMeApp\_release\drinkme-clean`:
```powershell
npm ci --cache D:\DrinkMeApp\.npm-cache
npm run check                     # typecheck + lint
cd server; npm ci --cache D:\DrinkMeApp\.npm-cache; npm test; cd ..   # port 5055, one run at a time
npx expo config --type public     # config resolves
npx expo export --platform android --output-dir D:\DrinkMeApp\_release\export-check   # release bundle builds
```
The ai-service tests need its Python venv (`docs/ai/LOCAL_SETUP.md`). The EAS build itself runs from the release repository (`eas build --profile production`), see `docs/RELEASE_BUILD.md`.

## 3. Publish
The release repository gets one commit per release, by the owner, with no tool trailers:
```powershell
cd D:\DrinkMeApp\_release\drinkme-clean
git init -b main
git add -A
git -c user.name="John" -c user.email="<owner email>" commit -m "DrinkMe <version>"
git remote add origin https://github.com/arontulbure-lgtm/drinkme-release.git
git push -u origin main
```
For later releases, export into a fresh folder, then copy its contents over a clone of `drinkme-release`, keeping that clone's `.git`. Then commit "DrinkMe <version>" and push. Never push the development repository's history to the release repository, or the reverse.
