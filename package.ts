/**
 * Revecast 2GP Packaging Agent
 *
 * Usage:
 *   npm install        (first time only)
 *   npx tsx package.ts
 *
 * What it does:
 *   - Guides you through 2GP managed package creation, versioning, promoting,
 *     and installing — for any Revecast repo
 *   - Injects namespace (Revecast__) into flows and prompt templates at
 *     packaging time only; repos stay namespace-free for dev deploys
 *   - Auto-increments version numbers with a major/minor/patch prompt
 *   - Works with repos that already have packages and repos that don't yet
 */

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ─── Config ─────────────────────────────────────────────────────────────────────

const NAMESPACE = "Revecast";
const DEFAULT_INSTALL_KEY = "Jax123";

// XML tags whose text content is a Salesforce object API name
const FLOW_OBJECT_TAGS = [
  "object", "targetObject", "lookupObject", "queryObject", "referencedObject",
];

// XML tags whose text content is a Salesforce field API name
const FLOW_FIELD_TAGS = [
  "field", "targetField", "mapKey", "objectType",
];

// ─── Types ───────────────────────────────────────────────────────────────────────

interface OrgInfo {
  alias: string;
  username: string;
  orgId: string;
  isDevHub: boolean;
  isSandbox: boolean;
}

interface PackageDependency {
  package: string;       // package alias (key in packageAliases)
  versionNumber?: string; // e.g. "1.0.0.LATEST" or specific version
}

interface PackageDir {
  path: string;
  package?: string;
  versionName?: string;
  versionNumber?: string;
  versionDescription?: string;
  dependencies?: PackageDependency[];
  default?: boolean;
}

interface SfdxProject {
  packageDirectories: PackageDir[];
  namespace?: string;
  packageAliases?: Record<string, string>;
  name?: string;
  sfdcLoginUrl?: string;
  sourceApiVersion?: string;
}

interface RepoEntry {
  name: string;
  path: string;
}

interface VersionParts {
  major: number;
  minor: number;
  patch: number;
}

// ─── I/O ────────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, a => resolve(a.trim())));
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(process.env.HOME!, p.slice(2)) : p;
}

function run(cmd: string, cwd?: string): string {
  return execSync(cmd, { encoding: "utf8", cwd, stdio: "pipe" }).trim();
}

function runLive(cmd: string, cwd?: string): void {
  execSync(cmd, { stdio: "inherit", cwd });
}

function hr(w = 64): string { return "─".repeat(w); }

function banner(): void {
  console.log();
  console.log("  " + "═".repeat(64));
  console.log("    REVECAST  ·  2GP PACKAGING AGENT");
  console.log("  " + "═".repeat(64));
  console.log();
}

// ─── Org Detection ──────────────────────────────────────────────────────────────

function listOrgs(): OrgInfo[] {
  try {
    const raw = run("sf org list --json");
    const data = JSON.parse(raw);
    const orgs: OrgInfo[] = [];

    const push = (list: any[], isDevHub: boolean, isSandbox: boolean) => {
      for (const o of list ?? []) {
        orgs.push({
          alias: o.alias ?? o.username,
          username: o.username ?? "",
          orgId: o.orgId ?? "",
          isDevHub,
          isSandbox,
        });
      }
    };

    // sf org list --json returns these buckets — devHubs appear in both devHubs AND nonScratchOrgs
    push(data.result?.devHubs,        true,  false);
    push(data.result?.sandboxes,      false, true);
    push(data.result?.scratchOrgs,    false, false);
    push(data.result?.nonScratchOrgs, false, false);

    // Deduplicate: if an alias appeared in devHubs first, skip its nonScratchOrgs duplicate
    const seen = new Set<string>();
    return orgs.filter(o => {
      const key = o.alias || o.username;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return [];
  }
}

// ─── Repo Registry ───────────────────────────────────────────────────────────────

function loadRepos(): RepoEntry[] {
  const file = path.join(__dirname, "repos.json");
  if (!fs.existsSync(file)) return [];
  const raw: { name: string; path: string }[] = JSON.parse(fs.readFileSync(file, "utf8"));
  return raw.map(r => ({ name: r.name, path: expandHome(r.path) }));
}

// ─── sfdx-project.json ──────────────────────────────────────────────────────────

function readProject(repoPath: string): SfdxProject {
  const file = path.join(repoPath, "sfdx-project.json");
  if (!fs.existsSync(file)) throw new Error(`No sfdx-project.json in ${repoPath}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeProject(repoPath: string, proj: SfdxProject): void {
  fs.writeFileSync(
    path.join(repoPath, "sfdx-project.json"),
    JSON.stringify(proj, null, 2) + "\n",
    "utf8"
  );
}

// ─── Version Helpers ────────────────────────────────────────────────────────────

/** Parse "1.2.3.NEXT" → { major:1, minor:2, patch:3 } */
function parseVersion(v: string): VersionParts | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(NEXT|\d+)$/);
  if (!m) return null;
  return { major: parseInt(m[1]), minor: parseInt(m[2]), patch: parseInt(m[3]) };
}

function formatVersion(v: VersionParts): string {
  return `${v.major}.${v.minor}.${v.patch}.NEXT`;
}

/**
 * Show current version and ask user whether to bump major, minor, or patch.
 * Returns the new versionNumber string (with .NEXT) to write to sfdx-project.json.
 */
async function promptVersionBump(current: string): Promise<string> {
  const parts = parseVersion(current);
  if (!parts) {
    console.log(`  Current version: ${current} (unrecognized format, will use as-is)`);
    return current;
  }

  const { major, minor, patch } = parts;
  console.log(`\n  Current version: ${major}.${minor}.${patch}`);
  console.log(`    1. Patch  →  ${major}.${minor}.${patch + 1}  (bug fixes, small changes)`);
  console.log(`    2. Minor  →  ${major}.${minor + 1}.0          (new features, backwards compatible)`);
  console.log(`    3. Major  →  ${major + 1}.0.0                 (breaking changes)`);
  console.log(`    4. Keep   →  ${major}.${minor}.${patch}        (use current — only valid if no promoted version exists at this number)`);

  const choice = await ask("\n  Version bump: ");

  switch (choice) {
    case "1": return formatVersion({ major, minor, patch: patch + 1 });
    case "2": return formatVersion({ major, minor: minor + 1, patch: 0 });
    case "3": return formatVersion({ major: major + 1, minor: 0, patch: 0 });
    case "4": return formatVersion({ major, minor, patch });
    default:
      console.log("  Invalid — defaulting to patch bump.");
      return formatVersion({ major, minor, patch: patch + 1 });
  }
}

// ─── Namespace Injection ────────────────────────────────────────────────────────

/**
 * Add Revecast__ prefix to a custom API name.
 * No-op if it's a standard name (no __c) or already namespaced.
 *
 *   Job__c                → Revecast__Job__c
 *   Status__c             → Revecast__Status__c
 *   Recruiter_Config__mdt → Revecast__Recruiter_Config__mdt
 *   Contact               → Contact          (standard, unchanged)
 *   Revecast__Job__c      → Revecast__Job__c  (already namespaced, unchanged)
 */
function nsName(value: string): string {
  // Match custom names ending in __c / __mdt / __e / __b
  // Negative lookbehind: skip if already preceded by __  (i.e. already has a namespace prefix)
  return value.replace(
    /(?<![A-Za-z0-9]__)[A-Za-z][A-Za-z0-9_]*(__c|__mdt|__e|__b)\b/g,
    match => `${NAMESPACE}__${match}`
  );
}

function injectFlow(content: string): string {
  let out = content;
  for (const tag of [...FLOW_OBJECT_TAGS, ...FLOW_FIELD_TAGS]) {
    out = out.replace(
      new RegExp(`(<${tag}>)([^<]+)(<\\/${tag}>)`, "g"),
      (_, open, val, close) => `${open}${nsName(val.trim())}${close}`
    );
  }
  return out;
}

function injectPromptTemplate(content: string): string {
  return content.replace(
    /SOBJECT:\/\/([A-Za-z][A-Za-z0-9]*)(__c|__mdt)/g,
    (match, name, suffix) => name.includes("__") ? match : `SOBJECT://${NAMESPACE}__${name}${suffix}`
  );
}

/** Inject namespace into all flows and prompt templates under a directory. Returns backup map. */
function injectAll(sourceDir: string): Map<string, string> {
  const backups = new Map<string, string>();

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }

      let modified: string | null = null;
      const original = fs.readFileSync(full, "utf8");

      if (entry.name.endsWith(".flow-meta.xml")) {
        modified = injectFlow(original);
      } else if (
        entry.name.endsWith(".genAiPromptTemplate-meta.xml") ||
        entry.name.endsWith(".promptTemplate-meta.xml")
      ) {
        modified = injectPromptTemplate(original);
      }

      if (modified && modified !== original) {
        backups.set(full, original);
        fs.writeFileSync(full, modified, "utf8");
      }
    }
  }

  walk(sourceDir);
  return backups;
}

function revertAll(backups: Map<string, string>): void {
  for (const [file, content] of backups) {
    fs.writeFileSync(file, content, "utf8");
  }
}

/** Return a preview of what would be injected (dry run). */
function previewInjection(sourceDir: string): { file: string; additions: number }[] {
  const results: { file: string; additions: number }[] = [];

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }

      const original = fs.readFileSync(full, "utf8");
      let modified: string | null = null;

      if (entry.name.endsWith(".flow-meta.xml")) {
        modified = injectFlow(original);
      } else if (
        entry.name.endsWith(".genAiPromptTemplate-meta.xml") ||
        entry.name.endsWith(".promptTemplate-meta.xml")
      ) {
        modified = injectPromptTemplate(original);
      }

      if (modified && modified !== original) {
        const before = (original.match(new RegExp(`${NAMESPACE}__`, "g")) ?? []).length;
        const after  = (modified.match(new RegExp(`${NAMESPACE}__`, "g")) ?? []).length;
        results.push({
          file: path.relative(sourceDir, full),
          additions: after - before,
        });
      }
    }
  }

  walk(sourceDir);
  return results;
}

// ─── Actions ─────────────────────────────────────────────────────────────────────

/**
 * Interactively build a dependencies array for a packageDirectory entry.
 * Looks at all known package aliases (from all repos' sfdx-project.json files)
 * plus any already declared in this repo, and lets the user pick.
 */
async function promptDependencies(
  repo: RepoEntry,
  allRepos: RepoEntry[],
  existingDeps: PackageDependency[]
): Promise<PackageDependency[]> {
  // Collect all known packages across all repos
  const knownPackages: { label: string; alias: string; id: string }[] = [];

  for (const r of allRepos) {
    try {
      const proj = readProject(r.path);
      for (const [alias, id] of Object.entries(proj.packageAliases ?? {})) {
        // Only package wrappers (0Ho) — not version IDs (04t)
        if (id.startsWith("0Ho")) {
          knownPackages.push({ label: `${r.name} → ${alias}`, alias, id });
        }
      }
      // Also include unregistered packages that exist as packageDirectory entries
      for (const d of proj.packageDirectories) {
        if (d.package && !knownPackages.find(k => k.alias === d.package)) {
          knownPackages.push({ label: `${r.name} → ${d.package} (no ID yet)`, alias: d.package!, id: "" });
        }
      }
    } catch { /* skip repos that can't be read */ }
  }

  // Dedupe
  const seen = new Set<string>();
  const unique = knownPackages.filter(k => {
    if (seen.has(k.alias)) return false;
    seen.add(k.alias);
    return true;
  });

  if (unique.length === 0) {
    console.log("  No other packages found to add as dependencies.");
    return existingDeps;
  }

  const deps = [...existingDeps];

  console.log();
  console.log("  Configure dependencies (packages that must be installed before this one).");
  console.log("  Current dependencies: " + (deps.length ? deps.map(d => d.package).join(", ") : "none"));
  console.log();

  while (true) {
    console.log("  Available packages:");
    unique.forEach((k, i) => {
      const already = deps.find(d => d.package === k.alias) ? "  ✓ already added" : "";
      console.log(`    ${i + 1}. ${k.label}${already}`);
    });
    console.log(`    ${unique.length + 1}. Done`);

    const choice = parseInt(await ask("\n  Add dependency #: "));
    if (choice === unique.length + 1 || isNaN(choice)) break;
    if (choice < 1 || choice > unique.length) { console.log("  Invalid."); continue; }

    const selected = unique[choice - 1];
    if (deps.find(d => d.package === selected.alias)) {
      console.log(`  Already added: ${selected.alias}`);
      continue;
    }

    const versionInput = await ask(`  Version constraint for ${selected.alias} (default: LATEST, or enter e.g. 1.0): `);
    const versionNumber = versionInput ? `${versionInput}.0.LATEST` : "LATEST";

    deps.push({ package: selected.alias, versionNumber });
    console.log(`  ✓ Added dependency: ${selected.alias} @ ${versionNumber}`);
  }

  return deps;
}

async function actionManageDependencies(repo: RepoEntry, allRepos: RepoEntry[]): Promise<void> {
  const proj = readProject(repo.path);
  const packaged = proj.packageDirectories.filter(d => d.package);

  if (packaged.length === 0) {
    console.log("\n  No registered packages found. Register a package first.");
    return;
  }

  console.log("\n  Which sub-package to configure dependencies for?");
  packaged.forEach((d, i) => {
    const depStr = d.dependencies?.length
      ? d.dependencies.map(dep => dep.package).join(", ")
      : "none";
    console.log(`    ${i + 1}. ${d.package}  (${d.path})  deps: ${depStr}`);
  });

  const idx = parseInt(await ask("\n  Sub-package #: ")) - 1;
  if (idx < 0 || idx >= packaged.length) { console.log("  Cancelled."); return; }

  const entry = packaged[idx];
  const updated = await promptDependencies(repo, allRepos, entry.dependencies ?? []);

  // Write back
  const fresh = readProject(repo.path);
  const freshEntry = fresh.packageDirectories.find(d => d.path === entry.path)!;
  freshEntry.dependencies = updated.length > 0 ? updated : undefined;
  writeProject(repo.path, fresh);

  console.log(`\n  ✓ Dependencies updated for ${entry.package}:`);
  if (updated.length === 0) {
    console.log("  (none)");
  } else {
    updated.forEach(d => console.log(`  • ${d.package} @ ${d.versionNumber ?? "LATEST"}`));
  }
  console.log("\n  sfdx-project.json updated. Commit when ready.");
}

async function actionCreatePackage(repo: RepoEntry, devHub: string, allRepos: RepoEntry[]): Promise<void> {
  const proj = readProject(repo.path);

  console.log();
  console.log("  Register a new 2GP package wrapper in the DevHub.");
  console.log("  Run this once per sub-package. The package ID (0Ho...) is saved to sfdx-project.json.");
  console.log();

  const unregistered = proj.packageDirectories.filter(d => !d.package);
  const registered   = proj.packageDirectories.filter(d =>  d.package);

  if (registered.length > 0) {
    console.log("  Already registered:");
    registered.forEach(d => console.log(`    • ${d.path}  →  ${d.package}`));
    console.log();
  }

  if (unregistered.length === 0) {
    console.log("  All package directories are already registered.");
    return;
  }

  console.log("  Unregistered directories:");
  unregistered.forEach((d, i) => console.log(`    ${i + 1}. ${d.path}`));

  const idx = parseInt(await ask("\n  Which directory to register? ")) - 1;
  if (idx < 0 || idx >= unregistered.length) { console.log("  Cancelled."); return; }
  const dir = unregistered[idx];

  const defaultName = repo.name + (unregistered.length > 1 ? `-${dir.path}` : "");
  const pkgName = await ask(`  Package name (default: ${defaultName}): `) || defaultName;

  console.log();
  console.log(`  Running: sf package create --name "${pkgName}" --package-type Managed --path ${dir.path} --target-dev-hub ${devHub}`);
  console.log();

  try {
    runLive(
      `sf package create --name "${pkgName}" --package-type Managed --path ${dir.path} --target-dev-hub ${devHub}`,
      repo.path
    );

    // sf package create writes the 0Ho... ID to packageAliases in sfdx-project.json.
    // Also fill in the package/version fields on the packageDirectory entry.
    const updated = readProject(repo.path);
    const entry = updated.packageDirectories.find(d => d.path === dir.path);
    if (entry && !entry.package) {
      entry.package       = pkgName;
      entry.versionName   = "ver 1.0";
      entry.versionNumber = "1.0.0.NEXT";
      writeProject(repo.path, updated);
    }

    console.log(`\n  ✓ Package "${pkgName}" registered. sfdx-project.json updated.`);

    // Offer to configure dependencies immediately
    const addDeps = await ask("\n  Configure dependencies now? (e.g. revecast-base must install first) (Y/n) ");
    if (addDeps.toLowerCase() !== "n") {
      await actionManageDependencies(repo, allRepos);
    }

    console.log("\n  Next: run 'Create package version' to build a beta version.");

  } catch (err: any) {
    console.error(`\n  ✗ Failed: ${err.message}`);
  }
}

async function actionCreateVersion(repo: RepoEntry, devHub: string): Promise<void> {
  const proj = readProject(repo.path);
  const packaged = proj.packageDirectories.filter(d => d.package);

  if (packaged.length === 0) {
    console.log("\n  No packages registered in sfdx-project.json.");
    console.log("  Run 'Register new package' first.");
    return;
  }

  // Pick sub-package
  console.log();
  if (packaged.length === 1) {
    console.log(`  Package: ${packaged[0].package}  (${packaged[0].path})`);
  } else {
    console.log("  Packages:");
    packaged.forEach((d, i) => {
      const v = d.versionNumber ?? "?";
      console.log(`    ${i + 1}. ${d.package}  (${d.path})  current: ${v}`);
    });
  }

  let pkgDir: PackageDir;
  if (packaged.length === 1) {
    pkgDir = packaged[0];
  } else {
    const idx = parseInt(await ask("\n  Which package to version? ")) - 1;
    if (idx < 0 || idx >= packaged.length) { console.log("  Cancelled."); return; }
    pkgDir = packaged[idx];
  }

  // Version bump
  const currentVersion = pkgDir.versionNumber ?? "1.0.0.NEXT";
  const newVersion = await promptVersionBump(currentVersion);

  // Install key
  const keyInput = await ask(`\n  Installation key (default: ${DEFAULT_INSTALL_KEY}, press Enter to use default): `);
  const installKey = keyInput || DEFAULT_INSTALL_KEY;

  // Version description
  const description = await ask("  Version description (optional): ");

  // Namespace injection preview
  const sourceDir = path.join(repo.path, pkgDir.path);
  const preview = previewInjection(sourceDir);

  console.log();
  if (preview.length > 0) {
    console.log(`  Namespace injection  (${NAMESPACE}__ added before package version create, reverted after):`);
    preview.forEach(({ file, additions }) =>
      console.log(`    ${file}  (+${additions} references)`)
    );
  } else {
    console.log("  No namespace injection needed (no un-prefixed custom API names found in flows/prompt templates).");
  }

  // Summary before proceeding
  const hadNamespace = !!proj.namespace;
  console.log();
  console.log("  " + hr());
  console.log(`  Package:        ${pkgDir.package}`);
  console.log(`  Version:        ${newVersion.replace(".NEXT", "")}  (${currentVersion} → ${newVersion})`);
  console.log(`  Install key:    ${installKey}`);
  console.log(`  DevHub:         ${devHub}`);
  console.log(`  Namespace:      ${hadNamespace ? "already set" : "will be added temporarily"}`);
  console.log("  " + hr());

  const go = await ask("\n  Proceed? (Y/n) ");
  if (go.toLowerCase() === "n") { console.log("  Cancelled."); return; }

  // Apply version bump to sfdx-project.json
  const workProj = readProject(repo.path);
  const workDir = workProj.packageDirectories.find(d => d.path === pkgDir.path)!;
  workDir.versionNumber = newVersion;
  if (description) workDir.versionDescription = description;
  if (!workProj.namespace) workProj.namespace = NAMESPACE;
  writeProject(repo.path, workProj);

  // Apply namespace injection
  const backups = injectAll(sourceDir);
  if (backups.size > 0) {
    console.log(`\n  ✓ Namespace injected into ${backups.size} file(s)`);
  }

  // Run package version create
  const args = [
    `sf package version create`,
    `--package "${pkgDir.package}"`,
    `--installation-key ${installKey}`,
    `--wait 60`,
    `--target-dev-hub ${devHub}`,
  ];
  if (description) args.push(`--version-description "${description}"`);

  console.log();
  console.log("  Creating package version — this takes 10–30 minutes...");
  console.log();

  let success = false;
  try {
    runLive(args.join(" "), repo.path);
    success = true;

    console.log();
    console.log("  ✓ Package version created.");
    console.log("  sfdx-project.json updated with new version alias by --wait 60.");
    console.log();
    console.log("  Next steps:");
    console.log("  • Install in a dev/scratch org to test");
    console.log("  • When ready: Promote to Released");

  } catch (err: any) {
    console.error("\n  ✗ Version creation failed:\n");
    console.error("  " + (err.message ?? "").split("\n").join("\n  "));
    console.log();
    console.log("  Common causes:");
    console.log("  • No namespace registry on DevHub — Setup → Company Profile → Packages → Namespace Registries");
    console.log("  • Apex test failures (required 75% coverage for managed packages)");
    console.log("  • Metadata type not supported in managed packages");
    console.log("  • Already promoted a version at this major.minor — bump version and retry");
    console.log("  • Component exists in multiple package directories (2GP allows only one owner)");
  }

  // Always revert namespace injection and sfdx-project.json namespace field
  if (backups.size > 0) {
    revertAll(backups);
    console.log(`\n  ✓ Namespace injection reverted — files back to dev-friendly state`);
  }

  if (!hadNamespace) {
    const clean = readProject(repo.path);
    delete clean.namespace;
    writeProject(repo.path, clean);
    console.log("  ✓ Temporary namespace removed from sfdx-project.json");
  }

  // Commit sfdx-project.json if version was created
  if (success) {
    const commitAns = await ask("\n  Commit updated sfdx-project.json? (Y/n) ");
    if (commitAns.toLowerCase() !== "n") {
      try {
        run("git add sfdx-project.json", repo.path);
        run(
          `git commit -m "chore(packaging): ${pkgDir.package} version ${newVersion.replace(".NEXT", "")}"`,
          repo.path
        );
        console.log("  ✓ Committed");
      } catch (e: any) {
        console.log(`  ! Git commit skipped: ${e.message}`);
      }
    }
  }
}

async function actionPromote(repo: RepoEntry, devHub: string): Promise<void> {
  const proj = readProject(repo.path);
  const aliases = Object.entries(proj.packageAliases ?? {}).filter(([, id]) => id.startsWith("04t"));

  if (aliases.length === 0) {
    console.log("\n  No package versions found in sfdx-project.json.");
    console.log("  Create a version first.");
    return;
  }

  console.log("\n  Package versions (from sfdx-project.json):");
  aliases.forEach(([alias, id], i) => console.log(`    ${i + 1}. ${alias}  (${id})`));
  console.log();
  console.log("  Not seeing all versions? Run 'List all versions' to see everything in the DevHub.");

  const idx = parseInt(await ask("\n  Which version to promote? ")) - 1;
  if (idx < 0 || idx >= aliases.length) { console.log("  Cancelled."); return; }

  const [alias, versionId] = aliases[idx];

  console.log();
  console.log("  ⚠️  WARNING: Promotion cannot be undone.");
  console.log(`  ${alias} will become a Released version installable in production.`);
  console.log("  After promotion, you must bump the version number before creating new betas at this major.minor.");
  console.log();

  const confirm = await ask("  Type PROMOTE to confirm: ");
  if (confirm.toUpperCase() !== "PROMOTE") { console.log("  Cancelled."); return; }

  try {
    runLive(`sf package version promote --package ${versionId} --target-dev-hub ${devHub}`, repo.path);
    console.log(`\n  ✓ ${alias} promoted to Released.`);
  } catch (err: any) {
    console.error(`\n  ✗ Promote failed: ${err.message}`);
  }
}

async function actionInstall(repo: RepoEntry, allOrgs: OrgInfo[]): Promise<void> {
  const proj = readProject(repo.path);
  const aliases = Object.entries(proj.packageAliases ?? {}).filter(([, id]) => id.startsWith("04t"));

  if (aliases.length === 0) {
    console.log("\n  No package versions found in sfdx-project.json.");
    return;
  }

  console.log("\n  Package versions:");
  aliases.forEach(([alias, id], i) => console.log(`    ${i + 1}. ${alias}  (${id})`));

  const vIdx = parseInt(await ask("\n  Which version to install? ")) - 1;
  if (vIdx < 0 || vIdx >= aliases.length) { console.log("  Cancelled."); return; }
  const [, versionId] = aliases[vIdx];

  // Target org — exclude DevHubs from this list since you don't install packages in DevHubs
  const targetOrgs = allOrgs.filter(o => !o.isDevHub);
  if (targetOrgs.length === 0) {
    console.log("  No target orgs found. Authenticate with: sf org login web --alias <alias>");
    return;
  }

  console.log("\n  Target org:");
  targetOrgs.forEach((o, i) => {
    const type = o.isSandbox ? "Sandbox" : "Scratch/Dev";
    console.log(`    ${i + 1}. ${o.alias}  (${type}  ${o.username})`);
  });

  const oIdx = parseInt(await ask("\n  Install in which org? ")) - 1;
  if (oIdx < 0 || oIdx >= targetOrgs.length) { console.log("  Cancelled."); return; }
  const targetOrg = targetOrgs[oIdx].alias;

  const keyInput = await ask(`\n  Installation key (default: ${DEFAULT_INSTALL_KEY}): `);
  const installKey = keyInput || DEFAULT_INSTALL_KEY;

  console.log();
  try {
    runLive(
      `sf package install --package ${versionId} --target-org ${targetOrg} --installation-key ${installKey} --wait 10`,
      repo.path
    );
    console.log(`\n  ✓ Installed in ${targetOrg}.`);
  } catch (err: any) {
    console.error(`\n  ✗ Install failed: ${err.message}`);
    console.log("  If this is a dependency error, make sure revecast-base is installed first.");
  }
}

async function actionListVersions(repo: RepoEntry, devHub: string): Promise<void> {
  const proj = readProject(repo.path);
  const packaged = proj.packageDirectories.filter(d => d.package);

  if (packaged.length === 0) {
    console.log("\n  No packages registered in sfdx-project.json.");
    return;
  }

  let pkgName: string;
  if (packaged.length === 1) {
    pkgName = packaged[0].package!;
  } else {
    console.log("\n  Packages:");
    packaged.forEach((d, i) => console.log(`    ${i + 1}. ${d.package}`));
    const idx = parseInt(await ask("\n  Which package? ")) - 1;
    if (idx < 0 || idx >= packaged.length) { console.log("  Cancelled."); return; }
    pkgName = packaged[idx].package!;
  }

  console.log();
  try {
    runLive(`sf package version list --packages "${pkgName}" --target-dev-hub ${devHub}`, repo.path);
  } catch (err: any) {
    console.error(`  ✗ ${err.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner();

  // ── 1. Select repo ──────────────────────────────────────────────────────────
  const repos = loadRepos().filter(r => fs.existsSync(r.path));

  if (repos.length === 0) {
    console.log("  No repos found. Edit repos.json to add your repo paths.");
    rl.close();
    return;
  }

  console.log("  Repos:");
  repos.forEach((r, i) => {
    const proj = (() => { try { return readProject(r.path); } catch { return null; } })();
    const pkgCount = proj?.packageDirectories.filter(d => d.package).length ?? 0;
    const total    = proj?.packageDirectories.length ?? 0;
    const status   = pkgCount > 0
      ? `${pkgCount}/${total} sub-packages registered`
      : total > 0 ? `${total} sub-package(s), none registered yet` : "no packageDirectories";
    console.log(`    ${i + 1}. ${r.name.padEnd(24)} ${status}`);
  });

  const rIdx = parseInt(await ask("\n  Select repo: ")) - 1;
  if (rIdx < 0 || rIdx >= repos.length) {
    console.log("  Invalid selection.");
    rl.close();
    return;
  }
  const repo = repos[rIdx];

  // ── 2. Select DevHub ────────────────────────────────────────────────────────
  const allOrgs = listOrgs();

  if (allOrgs.length === 0) {
    console.log("\n  No authenticated orgs found.");
    console.log("  Run: sf org login web --alias <alias>");
    rl.close();
    return;
  }

  console.log("\n  Authenticated orgs:");
  allOrgs.forEach((o, i) => {
    const tags: string[] = [];
    if (o.isDevHub)  tags.push("DevHub");
    if (o.isSandbox) tags.push("Sandbox");
    const tagStr = tags.length ? `  [${tags.join(", ")}]` : "";
    console.log(`    ${i + 1}. ${o.alias.padEnd(20)} ${o.username}${tagStr}`);
  });

  console.log();
  console.log("  Which org is the DevHub for this package?");
  console.log("  (Must have the Revecast namespace registry attached — Setup → Packages → Namespaces)");

  const hubIdx = parseInt(await ask("\n  DevHub org #: ")) - 1;
  if (hubIdx < 0 || hubIdx >= allOrgs.length) {
    console.log("  Invalid selection.");
    rl.close();
    return;
  }
  const devHub = allOrgs[hubIdx].alias;

  // ── 3. Action loop ──────────────────────────────────────────────────────────
  while (true) {
    console.log();
    console.log("  " + hr());
    console.log(`  Repo: ${repo.name}   DevHub: ${devHub}`);
    console.log("  " + hr());
    console.log();
    console.log("    1. Register new package          first-time setup per sub-package");
    console.log("    2. Create package version        builds a beta; injects namespace in flows");
    console.log("    3. Promote version to Released   irreversible — enables prod installs");
    console.log("    4. Install version in org        test a beta in scratch or sandbox");
    console.log("    5. List all versions             see betas and released in DevHub");
    console.log("    6. Manage dependencies           set which packages must install first");
    console.log("    7. Exit");
    console.log();

    const action = await ask("  Action: ");

    try {
      if (action === "1")      await actionCreatePackage(repo, devHub, repos);
      else if (action === "2") await actionCreateVersion(repo, devHub);
      else if (action === "3") await actionPromote(repo, devHub);
      else if (action === "4") await actionInstall(repo, allOrgs);
      else if (action === "5") await actionListVersions(repo, devHub);
      else if (action === "6") await actionManageDependencies(repo, repos);
      else if (action === "7") { console.log("\n  Goodbye.\n"); break; }
      else console.log("  Invalid selection.");
    } catch (err: any) {
      console.error(`\n  Error: ${err.message}`);
    }
  }

  rl.close();
}

main().catch(err => {
  console.error("Fatal:", err.message);
  rl.close();
  process.exit(1);
});
