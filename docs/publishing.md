# Publishing a New Version

Sticky Note uses tag-based publishing. When you push a version tag
(`v*`) to GitHub, a CI workflow runs tests and publishes to npm
automatically.

## One-time setup

1. Generate an npm access token at https://www.npmjs.com/settings/tokens
   — choose **Automation** type.
2. Add it as a repository secret in GitHub:
   **Settings → Secrets and variables → Actions → New repository secret**
   — name it `NPM_TOKEN`.

## Releasing a new version

```bash
# 1. Make sure you're on main with a clean working tree
git checkout main
git pull

# 2. Bump the version (pick one)
npm version patch   # bug fixes:      2.5.1 → 2.5.2
npm version minor   # new features:   2.5.1 → 2.6.0
npm version major   # breaking changes: 2.5.1 → 3.0.0

# 3. Push the commit and tag
git push && git push --tags
```

That's it. `npm version` updates `package.json`, creates a commit, and
creates a `v<version>` git tag. Pushing the tag triggers the GitHub
Actions workflow.

## What the workflow does

1. Checks out the code
2. Runs `npm test`
3. Verifies the git tag matches the version in `package.json`
4. Publishes to npm with provenance (links the package back to this repo)

If tests fail or the version doesn't match, the publish is skipped.

## Monitoring

After pushing a tag, check the workflow status at:
https://github.com/BandaruDheeraj/sticky-note/actions/workflows/publish.yml

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Workflow didn't run | Make sure you pushed the tag: `git push --tags` |
| `npm ERR! 401` | Check that `NPM_TOKEN` secret is set and not expired |
| Version mismatch error | The tag and `package.json` version must match. Use `npm version`, not manual edits |
| Tests failed | Fix tests locally, then `npm version` and push again |

## Undoing a bad release

```bash
# Unpublish within 72 hours (npm policy)
npm unpublish sticky-note-cli@<version>

# Or deprecate it instead
npm deprecate sticky-note-cli@<version> "Use <newer-version> instead"
```
