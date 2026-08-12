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
| account | Microsoft account + Microsoft Entra ID (free — **no paid Azure subscription**) | Eclipse Foundation account |
| create | <https://marketplace.visualstudio.com/manage> → Create publisher, id `infinite-pm` | sign the publisher agreement, then `npx ovsx create-namespace infinite-pm -p $OVSX_PAT` |
| auth | Entra app registration federated to this repo — no stored token (below) | Eclipse access token |

Open VSX matters: VSCodium, Cursor, Windsurf, Gitpod and code-server resolve
extensions from there, not from Microsoft's marketplace.

Optional but worth it: **domain-verify** the Marketplace publisher against
`infinite.pm` (a DNS TXT record) for the verified badge — the only signal a
visitor has that `infinite-pm` is really us.

### 2. The `release` environment

Create a GitHub environment named **`release`** with **at least one required
reviewer**. The reviewer is the point: a tag push builds, checksums, attests and
drafts the GitHub release unattended, then stops and waits. Only the `publish`
job is irreversible — a marketplace version can never be replaced, only
superseded.

### 3. Entra ID instead of a publishing token

Publishing authenticates with **Microsoft Entra ID over GitHub's OIDC**, not a
Personal Access Token. Nothing long-lived is stored in the repo, and it is the
only option with a future: Microsoft retires *global* Azure DevOps PATs — the
kind publishing requires — on **1 December 2026**.

**The identity must be a user-assigned managed identity, not an app
registration.** This was tested: adding an app registration's client ID to the
publisher's Members list fails with `TF14045: The identity could not be found`.
Microsoft's guide says to add "the managed identity (using its resource ID)" —
the members list resolves Azure DevOps identities and managed-identity resource
IDs, not bare Entra application objects.

A managed identity is an Azure resource, so this needs an Azure **subscription**
(a free one is fine — a user-assigned managed identity itself costs nothing).
That is the one place the OIDC path is not free-of-Azure; the token flow after
that stores no secret and never expires.

One-time setup:

1. **Create a user-assigned managed identity** in Azure (portal → Managed
   Identities → Create, or `az identity create -g <rg> -n vscode-infinite-pm-publisher`).
   Note its **client ID** (for the workflow) and its **resource ID**
   (`/subscriptions/…/resourceGroups/…/providers/Microsoft.ManagedIdentity/userAssignedIdentities/…`,
   for the publisher).
2. **Add the federated credential and the environment variables first** (steps 5
   and 6 below) — the profile-id step needs them.
3. **Get the identity's Azure DevOps profile id** by running the
   `Marketplace identity id` workflow (Actions → Run workflow). It logs in as the
   identity over OIDC and asks VSSPS who it is; the id is printed in the job
   summary.

   This indirection is the whole trick. The publisher's Members list resolves
   **only** that profile id — a managed identity's client id, object/principal id
   and ARM resource id are all rejected (`TF14045: The identity could not be
   found`, or `Not a valid User Id` for the resource id), because the identity has
   no Azure DevOps profile until it has authenticated to Azure DevOps once. The
   helper workflow *is* that first authentication.
4. **Add it to the publisher** —
   <https://marketplace.visualstudio.com/manage/publishers/infinite-pm> → Members
   → Add, paste the **profile id**, role **Contributor**. Contributor is what
   Microsoft documents for a publishing identity and is the least privilege that
   can publish: it cannot manage members or delete the publisher.
5. **Add a federated credential** on the managed identity (Settings → Federated
   credentials → Add credential → *GitHub Actions deploying Azure resources*):
   - Organization `infinite-pm`, repository `vscode-infinite-pm`
   - Entity type **Environment**, name **`release`**
   - which auto-fills subject
     `repo:infinite-pm/vscode-infinite-pm:environment:release`,
     issuer `https://token.actions.githubusercontent.com`,
     audience `api://AzureADTokenExchange`

   Let the portal fill the subject from those fields rather than typing it. A
   wrong subject saves **without error** and only surfaces when the token
   exchange fails at publish time.
6. **Record the identity on the `release` environment** as *variables* (not
   secrets — neither value is sensitive):
   - `AZURE_CLIENT_ID` — the managed identity's client ID
   - `AZURE_TENANT_ID` — the Directory (tenant) ID

The publish job checks both are present and fails in seconds with a pointer here
if they are not, rather than halfway through a release.

Open VSX is unaffected — its token is an Eclipse credential, not an Azure one.
Its `OVSX_PAT` secret is what switches phase 2 on; while it is absent the Open
VSX step skips itself and says so in the run summary.

- `OVSX_PAT` expires: _(fill in when phase 2 starts)_

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
