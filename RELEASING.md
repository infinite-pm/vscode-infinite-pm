# Releasing

Everything is driven by a tag. `.github/workflows/release.yml` does the work;
this file is the part a workflow cannot do for you.

## One-time setup

### 1. Claim the publisher on both marketplaces

The manifest declares `"publisher": "infinite-pm"`, so the extension's unique id
is **`infinite-pm.vscode-infinite-pm`**. That id cannot be changed later without
orphaning every install, so claim the name on both sides *before* the first
publish and confirm it is really available.

| | Visual Studio Marketplace | Open VSX |
| --- | --- | --- |
| account | Azure DevOps organization | Eclipse Foundation account |
| create | <https://marketplace.visualstudio.com/manage> → Create publisher, id `infinite-pm` | sign the publisher agreement, then `npx ovsx create-namespace infinite-pm -p $OVSX_PAT` |
| token | Azure DevOps → Personal Access Tokens: **All accessible organizations**, scope **Marketplace → Manage** | Eclipse access token |
| verify | `npx vsce verify-pat infinite-pm` | `npx ovsx verify-pat infinite-pm` |

Open VSX matters: VSCodium, Cursor, Windsurf, Gitpod and code-server resolve
extensions from there, not from Microsoft's marketplace.

Optional but worth it: **domain-verify** the Marketplace publisher against
`infinite.pm` (a DNS TXT record) for the verified badge — the only signal a
visitor has that `infinite-pm` is really us.

### 2. The `release` environment

Create a GitHub environment named **`release`** with:

- secrets `VSCE_PAT` and `OVSX_PAT`,
- **at least one required reviewer**.

The reviewer is the point. A tag push builds, checksums, attests and drafts the
GitHub release unattended, then stops and waits. Only the `publish` job is
irreversible: a marketplace version can never be replaced, only superseded.

Both tokens expire (an Azure DevOps PAT lasts at most a year). Record the expiry
here when you create them, or the first failed release is a mystery:

- `VSCE_PAT` expires: _(fill in)_
- `OVSX_PAT` expires: _(fill in)_

Before relying on PATs, check whether `vsce`/`ovsx` now support OIDC / trusted
publishing from GitHub Actions — short-lived federated credentials are strictly
better than long-lived secrets in a repo.

## Cutting a release

1. **Pin the server.** `.github/ipm-tools.ref` names the `infinite-pm/ipm-tools`
   ref the bundled `ipm-rpc` is built from. The workflow resolves it to a SHA
   once and records that SHA in the release notes, so a release is always
   identifiable — but pin it to a tag rather than `main` if you want it
   *reproducible*. (CI, by contrast, deliberately builds against `main` so drift
   surfaces on the next push.)
2. **Bump `package.json`'s `version`.**
3. **Write `CHANGELOG.md`.** Add or complete the `## X.Y.Z — YYYY-MM-DD`
   section. `scripts/release-notes.ts` refuses to release while the heading
   still says *unreleased*, and its body becomes the GitHub release notes — so
   the changelog, the release and the marketplace Changelog tab cannot disagree.
4. **Commit, then tag and push:**

   ```bash
   git tag v0.4.1 && git push origin v0.4.1
   ```

5. **Watch the run.** `preflight` fails in the first minute on a
   version/tag/changelog mismatch. `build` produces five platform `.vsix` files
   and smoke-runs the native Windows and macOS server binaries. `release`
   attaches them plus `SHA256SUMS` to a **draft** release with provenance
   attestations.
6. **Review the draft**, then approve the `release` environment. `publish`
   pushes the *exact* artifacts to both marketplaces (`--packagePath`, never a
   re-package) and undrafts the GitHub release.

A run that goes wrong before `publish` is safe to delete and redo — the release
is still a draft. After `publish`, the only way forward is a new version.

## Notes

- **Screenshots and images in `README.md`** must use absolute
  `https://raw.githubusercontent.com/infinite-pm/vscode-infinite-pm/<tag>/media/…`
  URLs. `vsce` can derive a base URL from `repository`, but it points at the
  default branch, so a later rename 404s on the marketplace page of every
  already-published version — permanently.
- **`npm run package` locally** warns if `bin/<goos>-<goarch>/` has no
  `ipm-rpc`. That vsix still works (it falls back to `PATH` / `ipm.serverPath`),
  it just does not keep the "nothing extra to install" promise. CI always stages
  the binary first.
- **Pre-release channel**, if we ever want one: VS Code's convention is
  `--pre-release` with *odd* minor versions for pre-release and even for stable
  (`0.5.x` pre-release → `0.6.0` stable). Until then we are single-channel.
