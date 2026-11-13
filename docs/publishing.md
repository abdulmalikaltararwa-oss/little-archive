# Publishing the source and demo

This guide describes the first public release and optional synthetic demo deployment. Completing local checks does not establish that a repository, release, or Pages site is live. Verify each remote result before sharing its URL or reporting a successful CI run.

The commands use `abdulmalikaltararwa-oss/little-archive` as the intended repository. Substitute your own owner when publishing a fork.

## Prepare the source

Work from the project directory. Install the development dependencies as described in the [README](../README.md), then run:

```sh
.venv/bin/python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
node --test web/*.test.mjs
python3 scripts/build_demo.py
python3 scripts/release_check.py
git status --short
```

The release check detects missing required files and common runtime data accidentally included in the source package. Review the files being committed as well: publish code, documentation, and synthetic fixtures; keep owner configuration, tokens, databases, platform exports, backups, and personal screenshots private. `dist-demo` is generated and excluded from source control.

If you received a source archive without Git history, initialize a repository first with `git init -b main`, then run the checks. If a Git repository already exists, keep its history and review its current branch and remotes with `git branch --show-current` and `git remote -v`.

Commit reviewed changes before publishing:

```sh
git add .
git diff --cached --stat
git diff --cached
git commit -m "Initial open-source release"
```

Skip the commit command when the intended release is already committed. The examples below assume the release branch is `main`.

## Create a public repository

Choose one of these paths. Both require an authenticated GitHub account with permission to create the repository. Authenticate in GitHub or the CLI; do not put a credential into source files, issue reports, or command examples.

### GitHub website

1. Sign in to GitHub and choose **New repository**.
2. Choose the correct owner and repository name `little-archive`, then choose **Public**.
3. Leave the options to add a README, license, or `.gitignore` unchecked; the local project already supplies them.
4. Create the repository and copy its remote URL.
5. From the local project, add that remote and push the committed branch:

```sh
git remote add origin https://github.com/abdulmalikaltararwa-oss/little-archive.git
git push -u origin main
```

If `origin` already exists, check that it points to the intended repository before pushing; do not add a second remote with the same name. For an existing repository, use its normal contribution and branch rules instead of repeating creation.

### Authenticated GitHub CLI

After making the local commit, check the CLI's account and create the public repository:

```sh
gh auth login
gh auth status
gh repo create abdulmalikaltararwa-oss/little-archive --public --source=. --remote=origin --push --description "A warm, self-hosted library for saved posts and links."
```

Skip `gh auth login` if the correct account is already authenticated. The create command is for a repository that does not yet exist and a local checkout without an `origin` remote. If the repository was created in the browser, use the remote and push commands in the previous section instead. See the [official `gh repo create` reference](https://cli.github.com/manual/gh_repo_create) for these flags.

Open the resulting repository and check its default branch, files, license, and **Actions → Checks** results. A workflow file in the repository is not evidence that its jobs have run successfully. Address failed jobs before describing the release as passing CI.

## Preview the static demo locally

The demo uses only original synthetic records. It has no owner account, live import connection, model service, or application backend. Edits remain in page memory and reset on reload. It can export those in-memory demo records, but cannot restore a private library.

```sh
python3 scripts/build_demo.py
python3 -m http.server 8090 --bind 127.0.0.1 --directory dist-demo
```

Open `http://localhost:8090/`. Inspect the gallery, a collection filter, a search, a note edit, and a reload. Assets are relative to the demo directory, so the same build works at a project path such as `https://OWNER.github.io/little-archive/`; no root-path rewrite or API proxy is needed.

## Publish the demo with GitHub Pages

The included [demo Pages workflow](../.github/workflows/demo-pages.yml) runs only when a maintainer starts it. It builds the default branch and uploads **only `dist-demo`**, with an exact file allowlist checked before upload. Pushes and pull requests do not deploy the demo.

1. Ensure the workflow file is committed to the repository's default branch.
2. In the repository, open **Settings → Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**. Use the included workflow; no additional starter workflow is needed.
3. Open **Actions → Publish synthetic demo → Run workflow** and select the default branch. Other branches are skipped by the workflow's branch guard.
4. Wait for both the build and deployment jobs to succeed. Open the URL shown by the deployment's `github-pages` environment.
5. Confirm the page displays the synthetic demo banner and that its styles and interactions load at the project subpath. Add this verified URL to the repository's website field and announcement drafts.

For the intended repository, the expected default address after a successful deployment is `https://abdulmalikaltararwa-oss.github.io/little-archive/`. A custom domain or a renamed repository changes the address; use the actual deployment result. This guide does not claim that the expected address is already live.

The build job has read access to repository contents and Pages metadata. The separate deployment job has only the Pages write and OIDC token permissions required for deployment. It uses GitHub's official checkout, Python setup, Pages configuration, artifact upload, and deployment actions. No project secret or private application password is required. The workflow does not enable Pages on your behalf; configure its source first.

Follow GitHub's instructions for [configuring a Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) and [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) if repository policies or permissions prevent deployment.

GitHub Pages serves the public demo, not the Python application. Never change the Pages artifact path to the repository root, `web`, `server`, or a runtime data directory. Deploy a real, authenticated instance using the [self-hosting guide](self-hosting.md).

## Prepare the release announcement

Use [CHANGELOG.md](../CHANGELOG.md) for the release scope and [the launch kit](launch-kit.md) for draft copy. Mark the initial release as an alpha or prerelease. Keep the experimental importer and source-text-only AI limitations visible, and use synthetic screenshots. Publish only verified repository, release, and demo URLs.

Issue forms are included for bug reports and feature requests. Enable private vulnerability reporting if the repository supports it, and follow [SECURITY.md](../SECURITY.md) for sensitive reports. Announcements, paid services, and hosted subscriptions are separate maintainer actions; these files do not publish messages or create a managed service.
