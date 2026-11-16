# Release process

How changes reach `main` and how a new version is published. This is the only flow used for this repo —
the maintainer and Claude both follow it.

- [Part 1 — for Claude (publishing changes)](#part-1--for-claude-publishing-changes)
- [Part 2 — for the maintainer (publishing a release)](#part-2--for-the-maintainer-publishing-a-release)
- [Reference](#reference)

---

## Part 1 — for Claude (publishing changes)

Follow these steps in order whenever the maintainer asks to publish, commit, push, merge or release.

### 1. Is this a release or not?

| Change | New version? | Release? |
|---|---|---|
| App behavior: feature, fix, UI, settings defaults… | yes | yes (maintainer publishes it) |
| Only docs, README, screenshots | no | no |
| Only the release workflow (`.github/workflows/release.yml`) | **no** — fix it and re-run the existing release (step 8) | no |

When unsure, ask the maintainer before bumping the version.

### 2. Branch

- Work on **`feature/initial-pr`** (the long-lived branch every PR comes from). Never commit to `main`
  directly and never force-push `main`.
- Start from the latest `main`, because the previous PR already merged the branch into it:
  ```bash
  git fetch --depth=20 origin main feature/initial-pr
  git checkout -B feature/initial-pr origin/main
  ```
  Pushing it afterwards is a fast-forward of `origin/feature/initial-pr` (its tip is an ancestor of `main`).

### 3. Version (only when step 1 says so)

`version.json` is the source of truth. Bump it by hand (`autoBump` stays `false`):

- **patch** (`1.1.0 → 1.1.1`): fixes and small adjustments;
- **minor** (`1.1.0 → 1.2.0`): new features or anything the maintainer calls a "minor";
- **`build`: always +1** on every release — it is Android's `versionCode`, and a phone refuses an apk with
  a lower one.

Write the same version to every file (the PowerShell build scripts do this on the maintainer's PC, but CI
and Claude don't run them):

| File | Field |
|---|---|
| `version.json` | `version`, `build` |
| `desktop/package.json`, `frontend/package.json` | `"version"` |
| `desktop/package-lock.json`, `frontend/package-lock.json` | top-level `"version"` and `packages[""].version` |
| `frontend/android/app/build.gradle` | `versionName "x.y.z"`, `versionCode <build>` |

The version bump goes in the same commit as the change.

### 4. Check before committing

From `frontend/`:

```bash
npx tsc -p tsconfig.app.json --noEmit
npx vitest run
npx ng build
```

All three must pass. Also make sure the commit has **no credentials**: no keystores, `.jks`, tokens,
passwords, `local.properties`, `config/` or `library/` content. Secrets live only in GitHub
(Settings → Secrets) and are referenced from the workflow by name.

### 5. Commit

- **Author:** the maintainer's identity, the same name and email as their previous commits
  (`git log -1 --format='%an <%ae>' origin/main^2`). Pass it with `git -c user.name=… -c user.email=…`;
  don't change the global git config.
- **Message:** English, lowercase type prefix, short summary of what changed for the user:
  - `feat:` new behavior or a release with features (e.g. `feat: default delay on pc is now 60ms and mobile 110ms`);
  - `fix:` bug fixes, including workflow fixes (e.g. `fix: release workflow attaches only the exe and the apk`);
  - `docs:` documentation only; `chore:` maintenance (deps, README tweaks, renames).
- **One commit per PR**, ending with the attribution trailers Claude's session gives (`Co-Authored-By`,
  `Claude-Session`).

### 6. Push, PR, merge

```bash
git -c push.negotiate=true push origin feature/initial-pr
```

Open the PR to `main` with the GitHub API (`gh api repos/<owner>/<repo>/pulls`):

- **title** = the commit's first line;
- **body** = a short bullet list of what changed (and "No app change, no new version." for workflow/docs
  PRs), then the Claude Code footer;
- **merge** with a **merge commit** (`merge_method=merge`), never squash or rebase — `main` history is
  `Merge pull request #N from <owner>/feature/initial-pr` followed by the change.

### 7. Hand the release to the maintainer

Claude's session **cannot create releases** (GitHub refuses it for this session type). After the merge, give
the maintainer, ready to paste:

- **tag:** `vX.Y.Z` (matches `version.json`), target `main`;
- **title:** `vX.Y.Z`;
- **notes:** one short English sentence about what changed for the player, like the previous releases
  (e.g. *"Set default delay to 60ms on pc and 110ms mobile."*).

Then point them to [Part 2](#part-2--for-the-maintainer-publishing-a-release).

### 8. Watch the build, fix the workflow if needed

Publishing the release starts **Release builds** (`.github/workflows/release.yml`). Follow it:

```bash
gh api "repos/<owner>/<repo>/actions/runs?per_page=3" --jq '.workflow_runs[] | "\(.id) \(.event) \(.status) \(.conclusion)"'
gh api repos/<owner>/<repo>/actions/runs/<run>/jobs --jq '.jobs[] | "\(.id) \(.name) \(.conclusion)"'
gh api repos/<owner>/<repo>/actions/jobs/<job>/logs      # read the failing job's log
```

If a job fails:

1. Find the cause in the log. Network refusals (e.g. Maven Central `429 Too Many Requests`) are usually
   transient — the apk job already retries after 1 and 3 minutes.
2. Fix **only the workflow**, with a `fix:` PR (steps 2, 4–6). **Don't bump the version, don't create a
   new tag or release.**
3. Re-run the same release from `main` — the workflow file comes from `main`, the app code from the tag:
   ```bash
   gh api -X POST repos/<owner>/<repo>/actions/workflows/release.yml/dispatches -f ref=main -f 'inputs[tag]=vX.Y.Z'
   ```
   (Re-running a failed run from the Actions tab reuses the old workflow file, so it won't pick up the fix.)
4. Done when every job is green and the release holds **exactly** `OpenDrumHero-X.Y.Z.exe` and
   `OpenDrumHero-X.Y.Z.apk`:
   ```bash
   gh api repos/<owner>/<repo>/releases/tags/vX.Y.Z --jq '.assets[] | "\(.name) \(.size)"'
   ```

### 9. Sync the maintainer's local clone

If the session is linked to the maintainer's computer and their clone had the same changes uncommitted:

1. `git fetch origin`, then compare with `git diff --stat origin/feature/initial-pr -- . ':!.github'` — it
   must be empty before touching anything (otherwise stop and tell the maintainer).
2. Point the branch at the remote without touching files: `git reset origin/feature/initial-pr`
   (mixed reset, never `--hard`), and `git branch -f main origin/main`.
3. `.github/` is protected on their computer — Claude doesn't write there (not even through git). If
   `git status` shows `.github/…` as deleted, tell the maintainer to run `git checkout -- .github`.

### Never

- Commit credentials or signing keys, or put them in workflow files.
- Push to `main` directly, force-push, delete branches or tags, or change repo settings.
- Create, edit or delete releases or release assets by hand — the workflow manages the assets.
- Bump the version for docs-only or workflow-only changes.

---

## Part 2 — for the maintainer (publishing a release)

Once the change is merged into `main` (by Claude or by you, through a PR from `feature/initial-pr`) and
`version.json` has the new version:

1. On GitHub: **Releases → Draft a new release**.
2. **Choose a tag:** type `vX.Y.Z` (the same version as `version.json`) → *Create new tag on publish*.
   **Target:** `main`.
3. **Release title:** `vX.Y.Z`.
4. **Description:** one short sentence about what changed.
5. **Publish release.**

That's all: the **Release builds** action starts by itself (Actions tab). In a few minutes it builds
`OpenDrumHero-X.Y.Z.exe` and `OpenDrumHero-X.Y.Z.apk` and attaches them to the release. If the tag doesn't
match `version.json`, the run shows a warning and the files keep the `version.json` number.

**If the action fails:** ask Claude to look at it ("a action deu erro, analise"). It fixes the workflow
without creating a new version and re-runs it for the same tag. To re-run it yourself after a workflow fix:
**Actions → Release builds → Run workflow**, branch `main`, tag `vX.Y.Z`. The files on the release are
replaced.

**Optional — keep the apk signature across releases:** add the repository secret
`ANDROID_DEBUG_KEYSTORE` (Settings → Secrets and variables → Actions) with the base64 of the keystore you
want to sign with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.android\debug.keystore")) | Set-Clipboard
```

Without it, each run signs the apk with a new key, and phones have to uninstall the old apk (losing the
library) before installing the new one.

**Doing a change yourself:** commit on `feature/initial-pr` with the same message style
(`feat:` / `fix:` / `docs:` / `chore:`), push, open a PR to `main`, merge it with a merge commit, then
publish the release as above.

---

## Reference

| Item | Value |
|---|---|
| Working branch | `feature/initial-pr` → PR → `main` (merge commit) |
| Version source | `version.json` (`version` + `build`, `autoBump: false`) |
| Tag / release name | `vX.Y.Z`, target `main` |
| Release assets | `OpenDrumHero-X.Y.Z.exe`, `OpenDrumHero-X.Y.Z.apk` — nothing else |
| Workflow | `.github/workflows/release.yml` — on release published, or Run workflow with a tag |
| Secrets | `ANDROID_DEBUG_KEYSTORE` (optional, apk signing) |
| Who can merge and release | the repo owner (and collaborators, if any are added) |
