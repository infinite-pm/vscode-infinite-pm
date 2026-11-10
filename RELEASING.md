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
   → Add, paste the **profile id**, role **Contributor**. It appears in the list
   as `<tenant-id>\<principal-id>`, which is how you can tell a machine identity
   from a person there. Contributor is what
   Microsoft documents for a publishing identity and is the least privilege that
   can publish: it cannot manage members or delete the publisher.
5. **Add a federated credential** on the managed identity (Settings → Federated
   credentials → Add credential → *GitHub Actions deploying Azure resources*):
   - Organization `infinite-pm` + its **numeric org id**, repository
     `vscode-infinite-pm` + its **numeric repo id**
     (`gh api orgs/infinite-pm --jq .id`,
     `gh api repos/infinite-pm/vscode-infinite-pm --jq .id`)
   - Entity type **Environment**, name **`release`**
   - Audience stays `api://AzureADTokenExchange` — do not edit it

   The portal builds the *immutable* subject form,
   `repo:<org>@<orgid>/<repo>@<repoid>:environment:release`, which pins the
   numeric ids so a renamed org or repo cannot inherit the trust. **Confirmed
   working** — that is what GitHub's token actually carries. Let the portal fill
   it: a wrong subject saves **without error** and only surfaces when the token
   exchange fails, as `AADSTS70021`.
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

After the publish job finishes, the Marketplace shows the extension as
**Verifying <version>** for a few minutes while it scans the upload; its public
item page 404s until that clears. "Works with N" on the publisher page is the
count of platform targets it accepted — nine, if every package uploaded.

## Where everything lives

The chain of trust, once, in order: **GitHub** mints an OIDC token for a job in
the `release` environment → the **federated credential** on the managed identity
accepts that exact subject → the **managed identity** is a Contributor on the
**Marketplace publisher** → `vsce` publishes as it. Nothing in that chain is a
stored secret, and nothing in it expires.

| part | where to manage it |
|---|---|
| Publisher, members, extension stats | <https://marketplace.visualstudio.com/manage/publishers/infinite-pm> |
| Public publisher page | <https://marketplace.visualstudio.com/publishers/infinite-pm> |
| The extension's page (after first publish) | <https://marketplace.visualstudio.com/items?itemName=infinite-pm.vscode-infinite-pm> |
| Managed identity `vscode-infinite-pm-publisher` (client id, federated credentials) | Azure portal → Managed Identities, resource group `rg-infinite-pm` |
| `release` environment: reviewer, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` | <https://github.com/infinite-pm/vscode-infinite-pm/settings/environments> |
| Workflow runs, and the `Marketplace identity id` helper | <https://github.com/infinite-pm/vscode-infinite-pm/actions> |
| Releases and their vsix assets | <https://github.com/infinite-pm/vscode-infinite-pm/releases> |
| The pinned server's releases | <https://github.com/infinite-pm/ipm-tools/releases> |
| Open VSX namespace (phase 2, not yet created) | <https://open-vsx.org/> — check with `https://open-vsx.org/api/infinite-pm` |

Values that are not written down here on purpose: the tenant, subscription and
client ids. They are not secrets, but this repo is public and they belong in the
`release` environment's variables, which is the only place anything reads them.

The `vscode-infinite-pm-publisher` **app registration** created during setup is
not part of this chain — the publisher rejected it, which is why the managed
identity exists. Delete it if it is still there.

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
   version/tag/changelog mismatch. `build` produces nine platform `.vsix` files
   and smoke-runs the native Windows and macOS server binaries. `release`
   attaches them plus `SHA256SUMS` to a **draft** release with provenance
   attestations.
6. **Review the draft**, then approve the `release` environment. `publish`
   pushes the *exact* artifacts to both marketplaces (`--packagePath`, never a
   re-package) and undrafts the GitHub release.

A run that goes wrong before `publish` is safe to delete and redo — the release
is still a draft. After `publish`, the only way forward is a new version.

## What is checked, and what is not

Most of a release is proved automatically before `publish` runs:

| layer | what it proves | when |
| --- | --- | --- |
| `npm test` (182) | renderer, caches, settings blast radius, the manifest, the README tables, the cross-repo token legend | every push + PR |
| `go test ./...` in ipm-tools | the server itself, over a real LSP session | every push there |
| `npm run test:e2e` (16) | commands, tab state, clipboard, diagnostics, embed-to-disk — in a real VS Code | merges to main + nightly |
| `npm run verify-guards` (7) | that the assertions above still fail when the bug returns, each from a green baseline | weekly + on demand |
| `preflight` | version == tag, changelog dated for it | on the tag |
| `smoke` | the SHIPPED vsix's bundled server runs on native Windows and macOS | on the tag |

**These are deliberately not automated.** Not because they do not matter — the
first two are how a user meets this extension — but because automating them
costs more than it catches. Walk them after a publish:

1. **Install from the Marketplace** on a clean profile and open a `.ipmt` file.
   The published listing is a different artifact from the vsix CI built: its
   README is rewritten at package time, and its images are served from
   raw.githubusercontent at the tag. A 404 there is invisible to every test.
2. **The Marketplace page itself** — the recordings play, the badges resolve,
   the size looks sane (0.4.3 is ~2.9MB packed, ~6.8MB unpacked; the bundled
   server is nearly all of it).
3. **Remote-SSH / dev container.** `extensionKind: workspace` means the
   extension runs on the remote and the server is spawned there. Nothing in CI
   exercises that split.
4. **The binary-change restart.** `ipm.restartOnBinaryChange` watches the
   resolved path with `fs.watch`, whose behaviour differs per platform and per
   filesystem. Rebuild `ipm-rpc` under a running window and watch the log say
   it restarted.
5. **Visual crispness of the `.ipmt` preview.** The pane resizes the SVG element
   per zoom step rather than CSS-scaling it, precisely so vectors stay sharp.
   The arithmetic is tested; "does it look right at 400%" is not a test.
6. **The performance numbers in the 0.4.2 notes** (0.5-2ms colour refreshes,
   ~35ms on a 3200-line document). They were measured, not asserted, and they
   will drift.

## Notes

- **Screenshots and images in `README.md`** stay *relative* in the repository —
  that is what renders on GitHub, and what `cmd-dev/assets-dist` writes. The
  release pins them instead: `build-vsix.yml` takes a `readme-ref` input, and
  `release.yml` passes the tag, so `vsce package` runs with `--baseContentUrl`
  and `--baseImagesUrl` pointing at that tag. Left to itself `vsce` derives a
  base URL from `repository` that points at the **default branch**, and a later
  rename then 404s the images on the marketplace page of every already-published
  version — permanently. A tag cannot move, so a published version keeps working.
  CI builds pass no ref: their artifacts are never published, so the default is
  fine there.
- **`npm run package` locally** warns if `bin/<goos>-<goarch>/` has no
  `ipm-rpc`. That vsix still works (it falls back to `PATH` / `ipm.serverPath`),
  it just does not keep the "nothing extra to install" promise. CI always stages
  the binary first.
- **Pre-release channel**, if we ever want one: VS Code's convention is
  `--pre-release` with *odd* minor versions for pre-release and even for stable
  (`0.5.x` pre-release → `0.6.0` stable). Until then we are single-channel.
