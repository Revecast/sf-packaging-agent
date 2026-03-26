# Revecast 2GP Packaging Agent

An interactive CLI for creating and managing Salesforce 2GP managed package versions across all Revecast repos.

---

## Getting started (new developer setup)

### Step 1 — Install prerequisites

| Tool | Install |
|------|---------|
| Node.js 18+ | [nodejs.org](https://nodejs.org) |
| Salesforce CLI (`sf`) | [developer.salesforce.com/tools/salesforcecli](https://developer.salesforce.com/tools/salesforcecli) |

### Step 2 — Clone and install

```bash
git clone https://github.com/Revecast/sf-packaging-agent ~/Documents/sf-packaging-agent
cd ~/Documents/sf-packaging-agent
npm install
```

### Step 3 — Edit repos.json

Open `repos.json` and set the `path` for each repo to wherever you have it cloned on your machine:

```json
[
  {
    "name": "revecast-recruiter",
    "path": "~/Documents/revecast-recruiter"
  },
  {
    "name": "revecast-base",
    "path": "~/Documents/revecast-base"
  },
  {
    "name": "PSACore",
    "path": "~/Documents/PSACore"
  }
]
```

Add or remove repos as needed. Only repos with an `sfdx-project.json` are shown.

### Step 4 — Authenticate your Salesforce orgs

```bash
sf org login web --alias jaxprod    # DevHub (must have Revecast namespace registry)
sf org login web --alias psaDev     # Any dev/sandbox orgs you test in
```

### Step 5 — Run

```bash
cd ~/Documents/sf-packaging-agent && npx tsx package.ts
```

---

## What it does

The agent walks you through each step interactively. At startup you pick:
1. Which repo (revecast-recruiter, revecast-base, PSACore)
2. Which authenticated org is the **DevHub** (the org that owns the package — must have the Revecast namespace registry)

Then an action menu:

| Action | When to use |
|--------|-------------|
| **Register new package** | One-time, per sub-package. Runs `sf package create` and saves the `0Ho...` package ID to `sfdx-project.json`. Prompts for dependencies immediately after. |
| **Create package version** | Each release cycle. Prompts for version bump, runs namespace injection, runs `sf package version create --wait 60`, then generates release notes, install URLs, updates product README, and optionally auto-installs to your test org. |
| **Promote version to Released** | When a beta is ready for production. Irreversible. Shows production install URL after. |
| **Install version in org** | Test a beta in a scratch or sandbox org. |
| **List all versions** | See all beta and released versions in the DevHub. |
| **Manage dependencies** | Set which packages must be installed before this one (e.g. revecast-base before recruiter). |

---

## Namespace injection — how it works

Flows and prompt templates don't automatically pick up a namespace when a package version is created. The agent handles this for you:

**Before** `sf package version create` runs:
- All `.flow-meta.xml` files in the package directory are scanned
- `<object>`, `<field>`, `<targetObject>` etc. tags get `Revecast__` added to custom API names
- All `.genAiPromptTemplate-meta.xml` files get `SOBJECT://` references updated

**After** the command completes (success or failure):
- Every modified file is immediately reverted to its original content

The `namespace: "Revecast"` field is also temporarily added to `sfdx-project.json` during packaging if not present, then removed.

**Result:** repos stay namespace-free at all times, so they can be deployed directly to dev orgs without any special setup.

---

## Release management

After every successful `Create package version`, the agent automatically:

1. **Displays install URLs** for both sandbox and production:
   ```
   Sandbox:    https://test.salesforce.com/packaging/installPackage.apexp?p0=04t...
   Production: https://login.salesforce.com/packaging/installPackage.apexp?p0=04t...
   ```
   And the CLI install command, ready to copy-paste.

2. **Generates release notes** from two sources scoped to this package directory:
   - Git commits to the package directory since the last version (using git tags it creates automatically)
   - Feature entries from `docs/FEATURES.md` in the product repo (written by the AI dev agent each session)

3. **Writes docs/RELEASES.md** in the product repo — newest version first, full history preserved.

4. **Writes a standalone release file**: `docs/<PackageName>-v<version>.md` — useful for sharing with clients or attaching to a GitHub release.

5. **Updates README.md** in the product repo with a `## Latest Package Versions` section showing the current version ID and install commands.

6. **Git tags the product repo** as `pkg/<package-dir>/<version>` — used to scope commits to "since last release" for the next version's release notes.

7. **Auto-installs to your test org** (if `testOrg` is set in repos.json), so you can verify the package installs cleanly immediately after creation.

### Setting up auto-install testing

Edit `repos.json` to add the org alias you want to test against:

```json
{
  "name": "revecast-recruiter",
  "path": "~/Documents/revecast-recruiter",
  "testOrg": "orgfarmDev"
}
```

After version create, the agent will prompt: `Auto-install to test org "orgfarmDev"? (Y/n)`. If it fails, you'll see the error immediately and can fix packaging issues before sharing the install URL.

---

## Version numbers

2GP version numbers follow `major.minor.patch`. The agent always asks before bumping:

```
Current version: 1.0.3
  1. Patch  →  1.0.4   (bug fixes, small changes)
  2. Minor  →  1.1.0   (new features, backwards compatible)
  3. Major  →  2.0.0   (breaking changes)
  4. Keep   →  1.0.3   (only valid if no promoted version exists at this number)
```

**Important:** Once you promote a version at a given `major.minor`, you cannot create new betas at that same `major.minor`. You must bump at least patch before creating the next beta.

---

## Dependencies

In 2GP, packages declare which other packages must be installed first. This is configured in `sfdx-project.json` under each `packageDirectory` entry.

Current dependency chain for Revecast packages:
```
revecast-base
  └── revecast-recruiter (each sub-package depends on revecast-base)
        ├── package-recruiter
        ├── package-hr-agent      (also depends on package-recruiter)
        ├── package-maya          (also depends on package-recruiter)
        ├── package-job-board     (also depends on package-recruiter)
        └── package-post-install  (depends on all of the above)
  └── PSACore
```

Use **"Manage dependencies"** in the action menu to configure these. The agent reads all package IDs from all repos in your `repos.json` and lets you pick.

---

## Installation key

The default installation key is `Jax123`. You can change it per version when prompted. Share the key with whoever needs to install the package.

---

## Important notes

- **DevHub ownership:** The DevHub you select when running `sf package create` permanently owns that package. Packages can be transferred but it's messy — pick the right DevHub from the start.
- **The DevHub must have the Revecast namespace registry attached** before any package can be created. Verify via Setup → Company Profile → Packages → Namespace Registries on the DevHub org.
- **Beta versions** can be installed in dev orgs, sandboxes, and scratch orgs — not in production.
- **Released (promoted) versions** can be installed in production. Promotion is irreversible.
- `sfdx-project.json` is updated automatically by `--wait 60` after a successful version create. The agent offers to commit this update for you.
