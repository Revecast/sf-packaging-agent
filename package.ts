/**
 * Revecast 2GP Packaging Agent
 *
 * Usage:
 *   npm install        (first time only)
 *   npx tsx package.ts
 */

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ─── Config ──────────────────────────────────────────────────────────────────

const NAMESPACE = "Revecast";
const DEFAULT_INSTALL_KEY = "Jax123";

const FLOW_OBJECT_TAGS = ["object", "targetObject", "lookupObject", "queryObject", "referencedObject"];
const FLOW_FIELD_TAGS  = ["field", "targetField", "mapKey", "objectType"];

// ─── Types ───────────────────────────────────────────────────────────────────

interface OrgInfo {
  alias: string;
  username: string;
  orgId: string;
  isDevHub: boolean;
  isSandbox: boolean;
}

interface PackageDependency {
  package: string;
  versionNumber?: string;
}

interface PackageDir {
  path: string;
  package?: string;
  packageType?: "Managed" | "Unlocked";
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
  testOrg?: string;
  oneGPOrg?: string;
  gitUrl?: string;
}

interface VersionParts {
  major: number;
  minor: number;
  patch: number;
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

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

// ─── Pre-flight Checks ────────────────────────────────────────────────────────

function preflight(): boolean {
  const checks: { label: string; pass: boolean; fix: string }[] = [];

  // sf CLI installed
  try {
    const ver = run("sf --version");
    checks.push({ label: `Salesforce CLI: ${ver.split("\n")[0]}`, pass: true, fix: "" });
  } catch {
    checks.push({ label: "Salesforce CLI: not found", pass: false, fix: "Install from https://developer.salesforce.com/tools/salesforcecli" });
  }

  // gh CLI installed (optional — used for GitHub releases)
  try {
    run("gh --version");
    checks.push({ label: "GitHub CLI: installed", pass: true, fix: "" });
  } catch {
    checks.push({ label: "GitHub CLI: not found (optional — needed for GitHub Release creation)", pass: true, fix: "Install from https://cli.github.com if you want automatic GitHub releases" });
  }

  // At least one org authenticated
  try {
    const orgs = listOrgs();
    if (orgs.length > 0) {
      checks.push({ label: `Authenticated orgs: ${orgs.length} found`, pass: true, fix: "" });
    } else {
      checks.push({ label: "Authenticated orgs: none", pass: false, fix: "Run: sf org login web --alias <alias>" });
    }
  } catch {
    checks.push({ label: "Authenticated orgs: could not check", pass: false, fix: "Run: sf org login web --alias <alias>" });
  }

  const failed = checks.filter(c => !c.pass);

  if (checks.some(c => c.label.includes("CLI") && c.pass)) {
    // Only print if there's something notable
  }

  if (failed.length > 0) {
    console.log("  Pre-flight check failed:\n");
    failed.forEach(c => {
      console.log(`  ✗ ${c.label}`);
      if (c.fix) console.log(`    Fix: ${c.fix}`);
    });
    console.log();
    return false;
  }

  return true;
}

/** Warn if the product repo has uncommitted changes — they won't be in the package. */
function warnUncommittedChanges(repoPath: string, pkgDirPath: string): void {
  try {
    const status = run(`git status --porcelain -- ${pkgDirPath}`, repoPath);
    if (status) {
      const lines = status.split("\n").filter(Boolean);
      console.log();
      console.log(`  ⚠️  Uncommitted changes in ${pkgDirPath} (${lines.length} file(s)):`);
      lines.slice(0, 5).forEach(l => console.log(`     ${l}`));
      if (lines.length > 5) console.log(`     ...and ${lines.length - 5} more`);
      console.log("  These changes will NOT be included in the package unless committed first.");
    }
  } catch { /* non-fatal */ }
}

// ─── Org Detection ───────────────────────────────────────────────────────────

function listOrgs(): OrgInfo[] {
  try {
    const raw  = run("sf org list --json");
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

    push(data.result?.devHubs,        true,  false);
    push(data.result?.sandboxes,      false, true);
    push(data.result?.scratchOrgs,    false, false);
    push(data.result?.nonScratchOrgs, false, false);

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

// ─── Repo Registry ────────────────────────────────────────────────────────────

const REPOS_FILE = path.join(__dirname, "repos.json");

/**
 * Load repos from repos.json if it exists, otherwise auto-discover by scanning
 * ~/Documents/ for directories that contain an sfdx-project.json.
 * Discovered repos are saved back to repos.json so future runs are instant.
 */
function loadRepos(): RepoEntry[] {
  if (fs.existsSync(REPOS_FILE)) {
    const raw: { name: string; path: string; testOrg?: string; oneGPOrg?: string; gitUrl?: string }[] =
      JSON.parse(fs.readFileSync(REPOS_FILE, "utf8"));
    return raw.map(r => ({ name: r.name, path: expandHome(r.path), testOrg: r.testOrg, oneGPOrg: r.oneGPOrg, gitUrl: r.gitUrl }));
  }
  return discoverAndSaveRepos();
}

function discoverRepos(): RepoEntry[] {
  const searchRoot = expandHome("~/Documents");
  const found: RepoEntry[] = [];

  if (!fs.existsSync(searchRoot)) return found;

  for (const entry of fs.readdirSync(searchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const repoPath  = path.join(searchRoot, entry.name);
    const sfdxFile  = path.join(repoPath, "sfdx-project.json");
    if (!fs.existsSync(sfdxFile)) continue;
    try {
      const proj = JSON.parse(fs.readFileSync(sfdxFile, "utf8"));
      if (Array.isArray(proj.packageDirectories)) {
        let gitUrl = "";
        try { gitUrl = run("git remote get-url origin", repoPath); } catch { /* no remote */ }
        found.push({ name: entry.name, path: repoPath, testOrg: "", oneGPOrg: "", gitUrl });
      }
    } catch { /* skip malformed */ }
  }

  return found;
}

function saveRepos(repos: RepoEntry[]): void {
  fs.writeFileSync(
    REPOS_FILE,
    JSON.stringify(repos.map(r => ({
      name: r.name,
      path: r.path,
      testOrg: r.testOrg ?? "",
      oneGPOrg: r.oneGPOrg ?? "",
      gitUrl: r.gitUrl ?? "",
    })), null, 2) + "\n",
    "utf8"
  );
}

function discoverAndSaveRepos(): RepoEntry[] {
  console.log("  Scanning ~/Documents for Salesforce repos...");
  const repos = discoverRepos();
  if (repos.length > 0) {
    saveRepos(repos);
    console.log(`  Found ${repos.length} repo(s). Saved to repos.json.`);
    console.log("  Edit repos.json to add testOrg aliases if you want auto-install testing.\n");
  }
  return repos;
}

// ─── sfdx-project.json ───────────────────────────────────────────────────────

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

// ─── Version Helpers ──────────────────────────────────────────────────────────

function parseVersion(v: string): VersionParts | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(NEXT|\d+)$/);
  if (!m) return null;
  return { major: parseInt(m[1]), minor: parseInt(m[2]), patch: parseInt(m[3]) };
}

function formatVersion(v: VersionParts): string {
  return `${v.major}.${v.minor}.${v.patch}.NEXT`;
}

function versionLabel(v: string): string {
  return v.replace(/\.NEXT$/, "").replace(/\.\d+$/, "");
}

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
  console.log(`    4. Keep   →  ${major}.${minor}.${patch}        (only valid if no promoted version exists at this number)`);

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

// ─── Namespace Injection ──────────────────────────────────────────────────────

function nsName(value: string): string {
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

function injectAll(sourceDir: string): Map<string, string> {
  const backups = new Map<string, string>();

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
        results.push({ file: path.relative(sourceDir, full), additions: after - before });
      }
    }
  }

  walk(sourceDir);
  return results;
}

// ─── Release Management ───────────────────────────────────────────────────────

/** Git tag name for a specific package version. */
function versionTagName(pkgDirPath: string, version: string): string {
  const dirSlug = pkgDirPath.replace(/\//g, "-").replace(/[^a-zA-Z0-9-]/g, "");
  return `pkg/${dirSlug}/${version}`;
}

/** Find the most recent git tag for this package directory (for release notes scoping). */
function getLastVersionTag(repoPath: string, pkgDirPath: string): string | null {
  try {
    const dirSlug = pkgDirPath.replace(/\//g, "-").replace(/[^a-zA-Z0-9-]/g, "");
    const tags = run(`git tag --list "pkg/${dirSlug}/*" --sort=-creatordate`, repoPath);
    if (!tags) return null;
    return tags.split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

/** Create a git tag in the product repo to mark this package version. */
function tagVersion(repoPath: string, pkgDirPath: string, version: string): void {
  const tag = versionTagName(pkgDirPath, version);
  try {
    run(`git tag ${tag}`, repoPath);
  } catch { /* tag may already exist */ }
}

/** Get commit log since a tag (or all commits if no tag), scoped to a package directory. */
interface CommitEntry {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

function getCommitsSince(repoPath: string, pkgDirPath: string, sinceTag: string | null): CommitEntry[] {
  try {
    const since = sinceTag ? `${sinceTag}..HEAD` : "HEAD";
    const raw = run(
      `git log ${since} --pretty=format:"%H|%s|%an|%ad" --date=short -- ${pkgDirPath}`,
      repoPath
    );
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map(line => {
      const [hash, subject, author, date] = line.split("|");
      return { hash: hash?.slice(0, 7) ?? "", subject: subject ?? "", author: author ?? "", date: date ?? "" };
    });
  } catch {
    return [];
  }
}

/**
 * Parse FEATURES.md in the product repo and extract entries relevant to a package directory.
 * FEATURES.md entries look like:
 *   ## Feature Name — YYYY-MM-DD
 *   **Sub-packages:** package-recruiter
 */
interface FeatureEntry {
  title: string;
  date: string;
  subpackages: string[];
  description: string;
  components: string;
  setup: string;
}

function parseFeaturesForPackage(repoPath: string, pkgDirName: string, sinceDate?: string): FeatureEntry[] {
  const file = path.join(repoPath, "docs", "FEATURES.md");
  if (!fs.existsSync(file)) return [];

  const content = fs.readFileSync(file, "utf8");

  // Split on ## headings (feature entries)
  const sections = content.split(/^(?=## )/m).filter(s => s.startsWith("## "));
  const entries: FeatureEntry[] = [];

  for (const section of sections) {
    const titleLine = section.match(/^## (.+?) — (\d{4}-\d{2}-\d{2})/m);
    if (!titleLine) continue;

    const title = titleLine[1].trim();
    const date  = titleLine[2].trim();

    // Skip entries older than sinceDate
    if (sinceDate && date < sinceDate) continue;

    const subpackagesMatch = section.match(/\*\*Sub-packages:\*\*\s*(.+)/);
    const subpackages = subpackagesMatch
      ? subpackagesMatch[1].split(",").map(s => s.trim())
      : [];

    // Only include if this package dir is mentioned
    if (!subpackages.some(sp => pkgDirName.includes(sp) || sp.includes(pkgDirName))) continue;

    // Extract "What it does" section
    const whatMatch = section.match(/###\s+What it does\n([\s\S]*?)(?=###|$)/);
    const description = whatMatch ? whatMatch[1].trim() : "";

    // Extract "New components" table
    const compMatch = section.match(/###\s+New components\n([\s\S]*?)(?=###|$)/);
    const components = compMatch ? compMatch[1].trim() : "";

    // Extract "Setup required"
    const setupMatch = section.match(/###\s+Setup required\n([\s\S]*?)(?=###|$)/);
    const setup = setupMatch ? setupMatch[1].trim() : "";

    entries.push({ title, date, subpackages, description, components, setup });
  }

  return entries;
}

/** Install URL for a specific version ID. */
function getInstallUrls(versionId: string): { sandbox: string; production: string } {
  return {
    sandbox:    `https://test.salesforce.com/packaging/installPackage.apexp?p0=${versionId}`,
    production: `https://login.salesforce.com/packaging/installPackage.apexp?p0=${versionId}`,
  };
}

// ─── Version Registry ─────────────────────────────────────────────────────────

interface VersionRecord {
  repo: string;
  package: string;
  version: string;
  versionId: string;
  installKey: string;
  installUrl: string;
  date: string;
  promoted: boolean;
}

const REGISTRY_FILE = path.join(__dirname, "versions.json");

function loadRegistry(): VersionRecord[] {
  if (!fs.existsSync(REGISTRY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")); } catch { return []; }
}

function saveRegistry(records: VersionRecord[]): void {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(records, null, 2) + "\n", "utf8");
}

function recordVersion(
  repoName: string,
  pkgName: string,
  version: string,
  versionId: string,
  installKey: string
): void {
  const records = loadRegistry();
  const urls    = getInstallUrls(versionId);
  records.unshift({
    repo: repoName,
    package: pkgName,
    version,
    versionId,
    installKey,
    installUrl: urls.sandbox,
    date: new Date().toISOString().split("T")[0],
    promoted: false,
  });
  saveRegistry(records);
}

function markPromoted(versionId: string): void {
  const records = loadRegistry();
  const rec     = records.find(r => r.versionId === versionId);
  if (rec) { rec.promoted = true; saveRegistry(records); }
}

async function actionShowRegistry(): Promise<void> {
  const records = loadRegistry();
  if (records.length === 0) {
    console.log("\n  No versions recorded yet.");
    return;
  }

  console.log("\n  Version registry (newest first):\n");
  console.log("  " + hr());

  // Group by package
  const byPkg = new Map<string, VersionRecord[]>();
  for (const r of records) {
    const key = `${r.repo} / ${r.package}`;
    if (!byPkg.has(key)) byPkg.set(key, []);
    byPkg.get(key)!.push(r);
  }

  for (const [pkg, vers] of byPkg) {
    console.log(`\n  ${pkg}`);
    for (const v of vers) {
      const status = v.promoted ? "Released" : "Beta";
      console.log(`    ${v.date}  v${v.version}  [${status}]`);
      console.log(`    ID:  ${v.versionId}`);
      console.log(`    Key: ${v.installKey}`);
      console.log(`    URL: ${v.installUrl}`);
      console.log();
    }
  }
}

/** Find the new version alias/ID added to sfdx-project.json after version create. */
function findNewVersionId(
  repoPath: string,
  prevAliases: Record<string, string>
): { alias: string; id: string } | null {
  try {
    const proj = readProject(repoPath);
    for (const [alias, id] of Object.entries(proj.packageAliases ?? {})) {
      if (id.startsWith("04t") && !prevAliases[alias]) {
        return { alias, id };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Build a full markdown release notes document for this version. */
function buildReleaseNotes(
  repo: RepoEntry,
  pkgDir: PackageDir,
  version: string,
  versionId: string,
  sinceTag: string | null,
  installKey: string
): string {
  const today = new Date().toISOString().split("T")[0];
  const urls  = getInstallUrls(versionId);

  // Get commits scoped to this package directory since last tag
  const commits = getCommitsSince(repo.path, pkgDir.path, sinceTag);

  // Get sinceDate from git tag for FEATURES.md filtering
  let sinceDate: string | undefined;
  if (sinceTag) {
    try {
      sinceDate = run(`git log -1 --format=%ad --date=short ${sinceTag}`, repo.path);
    } catch { /* ignore */ }
  }

  // Parse feature entries from FEATURES.md
  const features = parseFeaturesForPackage(repo.path, pkgDir.path, sinceDate);

  const lines: string[] = [];
  lines.push(`# ${pkgDir.package} — v${version}`);
  lines.push(`Released: ${today}  |  Package: \`${versionId}\``);
  lines.push("");

  // Install info
  lines.push("## Install");
  lines.push("");
  lines.push("**Sandbox / Developer org:**");
  lines.push(`\`\`\``);
  lines.push(`sf package install --package ${versionId} --installation-key ${installKey} --wait 10 --target-org <alias>`);
  lines.push(`\`\`\``);
  lines.push(`Or use the install URL: ${urls.sandbox}`);
  lines.push("");
  lines.push("**Production (promoted versions only):**");
  lines.push(`Or use the install URL: ${urls.production}`);
  lines.push("");

  // Features
  if (features.length > 0) {
    lines.push("## What's New");
    lines.push("");
    for (const f of features) {
      lines.push(`### ${f.title}`);
      if (f.description) lines.push(f.description);
      if (f.components) {
        lines.push("");
        lines.push("**New components:**");
        lines.push(f.components);
      }
      if (f.setup && f.setup.toLowerCase() !== "none — automatically active after install.") {
        lines.push("");
        lines.push("**Setup required:**");
        lines.push(f.setup);
      }
      lines.push("");
    }
  }

  // Commits
  if (commits.length > 0) {
    lines.push("## Commits");
    lines.push("");
    for (const c of commits) {
      lines.push(`- \`${c.hash}\` ${c.subject}  _(${c.date})_`);
    }
    lines.push("");
  }

  // Post-install steps
  const setupSteps = features
    .filter(f => f.setup && f.setup.toLowerCase() !== "none — automatically active after install.")
    .map(f => ({ title: f.title, setup: f.setup }));

  if (setupSteps.length > 0) {
    lines.push("## Post-Install Steps");
    lines.push("");
    lines.push("The following features require manual configuration after installation:");
    lines.push("");
    for (const s of setupSteps) {
      lines.push(`### ${s.title}`);
      lines.push(s.setup);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** Append or create docs/RELEASES.md in the product repo. */
function writeReleasesFile(repoPath: string, pkgName: string, version: string, notes: string): string {
  const docsDir = path.join(repoPath, "docs");
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const file = path.join(docsDir, "RELEASES.md");
  const divider = "\n\n---\n\n";

  // Also write a standalone per-version file
  const versionFile = path.join(docsDir, `${pkgName.replace(/[^a-zA-Z0-9-]/g, "-")}-v${version}.md`);
  fs.writeFileSync(versionFile, notes, "utf8");

  // Prepend to RELEASES.md (newest first)
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const header = existing.startsWith("# Release History") ? "" : "# Release History\n\n";
  const newContent = header + notes + divider + existing.replace(/^# Release History\n\n/, "");
  fs.writeFileSync(file, newContent, "utf8");

  return versionFile;
}

/** Update or create a ## Latest Package Versions section in the product repo's README.md.
 *  Preserves existing rows for other packages — only updates the row for pkgName. */
function updateProductReadme(
  repoPath: string,
  pkgName: string,
  version: string,
  versionId: string,
  installKey: string
): void {
  const readmeFile = path.join(repoPath, "README.md");
  if (!fs.existsSync(readmeFile)) return;

  const content = fs.readFileSync(readmeFile, "utf8");
  const today   = new Date().toISOString().split("T")[0];
  const urls    = getInstallUrls(versionId);
  const newRow  = `| ${pkgName} | ${version} | \`${versionId}\` | ${today} |`;

  // Find existing section boundaries (works whether section is mid-file or at end)
  const sectionStart = content.indexOf("\n## Latest Package Versions");
  const altStart     = content.startsWith("## Latest Package Versions") ? 0 : -1;
  const start        = sectionStart !== -1 ? sectionStart + 1 : altStart !== -1 ? 0 : -1;

  if (start !== -1) {
    // Section exists — extract it, update or add the row for this package
    const afterStart  = content.slice(start);
    const nextSection = afterStart.slice("## Latest Package Versions".length).search(/\n## /);
    const sectionEnd  = nextSection !== -1
      ? start + "## Latest Package Versions".length + nextSection + 1
      : content.length;

    const sectionText = content.slice(start, sectionEnd);

    // Check if this package already has a row
    const rowRegex = new RegExp(`^\\| ${escapeRegex(pkgName)} \\|.*$`, "m");
    let newSection: string;
    if (rowRegex.test(sectionText)) {
      newSection = sectionText.replace(rowRegex, newRow);
    } else {
      // Add a new row after the table header
      newSection = sectionText.replace(
        /(\|[-| ]+\|\n)/,
        `$1${newRow}\n`
      );
    }

    // Rebuild install command block — show the most recently updated package
    const installBlock = [
      `**Latest install (sandbox):** \`sf package install --package ${versionId} --installation-key ${installKey} --target-org <alias>\``,
      `**Install URL (sandbox):** ${urls.sandbox}`,
    ].join("\n");

    // Replace everything after the table with updated install block
    const tableEnd = newSection.search(/\n\n\*\*Latest install/);
    const tableOnly = tableEnd !== -1 ? newSection.slice(0, tableEnd) : newSection.trimEnd();
    newSection = tableOnly + "\n\n" + installBlock + "\n";

    fs.writeFileSync(readmeFile, content.slice(0, start) + newSection + content.slice(sectionEnd), "utf8");

  } else {
    // Section doesn't exist — append it
    const newSection = [
      "## Latest Package Versions",
      "",
      "| Package | Version | ID | Released |",
      "|---------|---------|-----|----------|",
      newRow,
      "",
      `**Latest install (sandbox):** \`sf package install --package ${versionId} --installation-key ${installKey} --target-org <alias>\``,
      `**Install URL (sandbox):** ${urls.sandbox}`,
      "",
    ].join("\n");
    fs.writeFileSync(readmeFile, content.trimEnd() + "\n\n" + newSection, "utf8");
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Destructive Changes (2GP Managed component deletion) ────────────────────

interface MetadataMember {
  type: string;
  member: string;
}

/** Map an sfdx source file path to its Salesforce metadata type + member name. */
function filePathToMetadata(filePath: string): MetadataMember | null {
  let m: RegExpMatchArray | null;

  m = filePath.match(/classes\/([^/]+)\.cls$/);
  if (m) return { type: "ApexClass", member: m[1] };

  m = filePath.match(/triggers\/([^/]+)\.trigger$/);
  if (m) return { type: "ApexTrigger", member: m[1] };

  m = filePath.match(/objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/);
  if (m) return { type: "CustomField", member: `${m[1]}.${m[2]}` };

  m = filePath.match(/objects\/([^/]+)\/validationRules\/([^/]+)\.validationRule-meta\.xml$/);
  if (m) return { type: "ValidationRule", member: `${m[1]}.${m[2]}` };

  m = filePath.match(/objects\/([^/]+)\/recordTypes\/([^/]+)\.recordType-meta\.xml$/);
  if (m) return { type: "RecordType", member: `${m[1]}.${m[2]}` };

  m = filePath.match(/objects\/([^/]+)\/\1\.object-meta\.xml$/);
  if (m) return { type: "CustomObject", member: m[1] };

  m = filePath.match(/flows\/([^/]+)\.flow-meta\.xml$/);
  if (m) return { type: "Flow", member: m[1] };

  m = filePath.match(/lwc\/([^/]+)\/\1\.(js|html|css)-meta\.xml$/);
  if (m) return { type: "LightningComponentBundle", member: m[1] };
  m = filePath.match(/lwc\/([^/]+)\//);
  if (m) return { type: "LightningComponentBundle", member: m[1] };

  m = filePath.match(/aura\/([^/]+)\//);
  if (m) return { type: "AuraDefinitionBundle", member: m[1] };

  m = filePath.match(/permissionsets\/([^/]+)\.permissionset-meta\.xml$/);
  if (m) return { type: "PermissionSet", member: m[1] };

  m = filePath.match(/layouts\/([^/]+)\.layout-meta\.xml$/);
  if (m) return { type: "Layout", member: m[1] };

  m = filePath.match(/staticresources\/([^/]+)\.resource-meta\.xml$/);
  if (m) return { type: "StaticResource", member: m[1] };

  m = filePath.match(/tabs\/([^/]+)\.tab-meta\.xml$/);
  if (m) return { type: "CustomTab", member: m[1] };

  m = filePath.match(/genAiPromptTemplates\/([^/]+)\.genAiPromptTemplate-meta\.xml$/);
  if (m) return { type: "GenAiPromptTemplate", member: m[1] };

  m = filePath.match(/promptTemplates\/([^/]+)\.promptTemplate-meta\.xml$/);
  if (m) return { type: "PromptTemplate", member: m[1] };

  m = filePath.match(/customMetadata\/([^/]+)\.md-meta\.xml$/);
  if (m) return { type: "CustomMetadata", member: m[1] };

  return null;
}

/** Get files deleted from a package directory since the last version tag. */
function getDeletedComponents(repoPath: string, pkgDirPath: string, sinceTag: string | null): MetadataMember[] {
  try {
    const since = sinceTag ? `${sinceTag}..HEAD` : "";
    const raw   = since
      ? run(`git diff ${since} --diff-filter=D --name-only -- ${pkgDirPath}`, repoPath)
      : run(`git log --diff-filter=D --name-only --pretty=format: -- ${pkgDirPath}`, repoPath);
    if (!raw) return [];

    const seen    = new Set<string>();
    const results: MetadataMember[] = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      const meta = filePathToMetadata(line.trim());
      if (!meta) continue;
      const key = `${meta.type}::${meta.member}`;
      if (!seen.has(key)) { seen.add(key); results.push(meta); }
    }
    return results;
  } catch {
    return [];
  }
}

/** Generate destructiveChanges.xml content from a list of metadata members. */
function buildDestructiveChangesXml(deletions: MetadataMember[], apiVersion: string): string {
  // Group members by type
  const byType = new Map<string, string[]>();
  for (const d of deletions) {
    if (!byType.has(d.type)) byType.set(d.type, []);
    byType.get(d.type)!.push(d.member);
  }

  const typeBlocks = [...byType.entries()].map(([type, members]) => {
    const memberLines = members.map(m => `        <members>${m}</members>`).join("\n");
    return `    <types>\n${memberLines}\n        <name>${type}</name>\n    </types>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
${typeBlocks}
    <version>${apiVersion}</version>
</Package>
`;
}

// ─── 1GP Packaging ─────────────────────────────────────────────────────────

interface ComponentChange {
  filePath: string;
  status: "A" | "M" | "D" | "R";
  componentType: string;
  componentName: string;
  mustManuallyAdd: boolean;
  setupPath: string;
}

function oneGPTagName(pkgDirPath: string, date: string): string {
  const dirSlug = pkgDirPath.replace(/\//g, "-").replace(/[^a-zA-Z0-9-]/g, "");
  return `1gp/${dirSlug}/${date}`;
}

function getLastOneGPTag(repoPath: string, pkgDirPath: string): string | null {
  try {
    const dirSlug = pkgDirPath.replace(/\//g, "-").replace(/[^a-zA-Z0-9-]/g, "");
    const tags = run(`git tag --list "1gp/${dirSlug}/*" --sort=-creatordate`, repoPath);
    if (!tags) return null;
    return tags.split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

function tagOneGP(repoPath: string, pkgDirPath: string, date: string): void {
  const tag = oneGPTagName(pkgDirPath, date);
  try { run(`git tag ${tag}`, repoPath); } catch { /* tag may already exist */ }
}

function categorizeComponent(filePath: string, status: "A" | "M" | "D" | "R"): ComponentChange {
  const mustAdd = status === "A" || status === "R";

  let m: RegExpMatchArray | null;

  // Record types (check before generic object)
  m = filePath.match(/objects\/([^/]+)\/recordTypes\/([^/]+)\.recordType-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Record Type", componentName: `${m[1]}.${m[2]}`, mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Record Types" };

  // Validation rules
  m = filePath.match(/objects\/([^/]+)\/validationRules\/([^/]+)\.validationRule-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Validation Rule", componentName: `${m[1]}.${m[2]}`, mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Validation Rules" };

  // Fields
  m = filePath.match(/objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Custom Field", componentName: `${m[1]}.${m[2]}`, mustManuallyAdd: mustAdd, setupPath: `Setup → Package Manager → [pkg] → Add → Custom Fields → ${m[1]}` };

  // Object root definition
  m = filePath.match(/objects\/([^/]+)\/\1\.object-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Custom Object", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Custom Objects" };

  // Apex classes
  m = filePath.match(/classes\/([^/]+)\.cls$/);
  if (m) return { filePath, status, componentType: "Apex Class", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Apex Classes" };

  // Apex triggers
  m = filePath.match(/triggers\/([^/]+)\.trigger$/);
  if (m) return { filePath, status, componentType: "Apex Trigger", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Apex Triggers" };

  // LWC (multiple files per component — deduplicated by caller)
  m = filePath.match(/lwc\/([^/]+)\//);
  if (m) return { filePath, status, componentType: "Lightning Web Component", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Lightning Components" };

  // Aura
  m = filePath.match(/aura\/([^/]+)\//);
  if (m) return { filePath, status, componentType: "Aura Component", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Lightning Components" };

  // Flows — always treated as mustManuallyAdd (flows don't auto-include even if modified)
  m = filePath.match(/flows\/([^/]+)\.flow-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Flow", componentName: m[1], mustManuallyAdd: true, setupPath: "Setup → Package Manager → [pkg] → Add → Flows" };

  // Prompt Templates — always mustManuallyAdd
  m = filePath.match(/genAiPromptTemplates\/([^/]+)\.genAiPromptTemplate-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Prompt Template", componentName: m[1], mustManuallyAdd: true, setupPath: "Setup → Package Manager → [pkg] → Add → Prompt Templates" };
  m = filePath.match(/promptTemplates\/([^/]+)\.promptTemplate-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Prompt Template", componentName: m[1], mustManuallyAdd: true, setupPath: "Setup → Package Manager → [pkg] → Add → Prompt Templates" };

  // Permission Sets
  m = filePath.match(/permissionsets\/([^/]+)\.permissionset-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Permission Set", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Permission Sets" };

  // Page Layouts
  m = filePath.match(/layouts\/([^/]+)\.layout-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Page Layout", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Page Layouts" };

  // Custom Metadata records
  m = filePath.match(/customMetadata\/([^/]+)\.md-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Custom Metadata Record", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Custom Metadata" };

  // Static Resources
  m = filePath.match(/staticresources\/([^/]+)\./);
  if (m) return { filePath, status, componentType: "Static Resource", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Static Resources" };

  // Custom Tabs
  m = filePath.match(/tabs\/([^/]+)\.tab-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Custom Tab", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Custom Tabs" };

  // Report Types
  m = filePath.match(/reportTypes\/([^/]+)\.reportType-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Report Type", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Report Types" };

  // Email Templates
  m = filePath.match(/email\/(.+)\.email-meta\.xml$/);
  if (m) return { filePath, status, componentType: "Email Template", componentName: m[1], mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → Email Templates" };

  // Fallback
  const parts = filePath.split("/");
  const name = parts[parts.length - 1].replace(/\.[^.]+$/, "").replace(/\.[^.]+$/, "");
  return { filePath, status, componentType: "Metadata", componentName: name, mustManuallyAdd: mustAdd, setupPath: "Setup → Package Manager → [pkg] → Add → [appropriate type]" };
}

/**
 * Get all changed/new metadata files in a package dir since the last 1GP tag.
 * If no prior tag, returns all tracked files (first-time packaging).
 */
function getChangedComponents(repoPath: string, pkgDirPath: string, sinceTag: string | null): ComponentChange[] {
  const seen = new Set<string>();
  const components: ComponentChange[] = [];

  const addComp = (filePath: string, status: "A" | "M" | "D" | "R") => {
    const comp = categorizeComponent(filePath, status);
    const key = `${comp.componentType}::${comp.componentName}`;
    if (!seen.has(key)) { seen.add(key); components.push(comp); }
  };

  try {
    if (sinceTag) {
      const raw = run(`git diff "${sinceTag}"..HEAD --name-status -- ${pkgDirPath}`, repoPath);
      if (!raw) return [];
      for (const line of raw.split("\n").filter(Boolean)) {
        const parts = line.split("\t");
        const rawStatus = (parts[0]?.charAt(0) ?? "M") as "A" | "M" | "D" | "R";
        const filePath  = parts[parts.length - 1]?.trim() ?? "";
        if (filePath) addComp(filePath, rawStatus);
      }
    } else {
      // No prior 1GP tag — list all tracked files as "new"
      const raw = run(`git ls-files -- ${pkgDirPath}`, repoPath);
      if (!raw) return [];
      for (const filePath of raw.split("\n").filter(Boolean)) {
        addComp(filePath.trim(), "A");
      }
    }
  } catch { /* non-fatal */ }

  return components;
}

/**
 * Derive specific, named manual configuration tasks from the component changes.
 * Returns actionable checklist items rather than generic reminders.
 */
function deriveConfigItems(components: ComponentChange[]): string[] {
  const items: string[] = [];

  const ofType = (type: string, mustAdd?: boolean) =>
    components.filter(c =>
      c.componentType === type &&
      c.status !== "D" &&
      (mustAdd === undefined || c.mustManuallyAdd === mustAdd)
    );

  const newFields       = ofType("Custom Field",            true);
  const newObjects      = ofType("Custom Object",           true);
  const allFlows        = ofType("Flow");
  const newLayouts      = ofType("Page Layout",             true);
  const newRecordTypes  = ofType("Record Type",             true);
  const newTabs         = ofType("Custom Tab",              true);
  const newPermSets     = ofType("Permission Set",          true);
  const newLWC          = [...ofType("Lightning Web Component", true), ...ofType("Aura Component", true)];
  const newPromptTpls   = ofType("Prompt Template");
  const modPermSets     = ofType("Permission Set",          false);

  if (newObjects.length > 0) {
    items.push("**Object Permissions** — New objects must have CRUD access added to Permission Sets:");
    for (const c of newObjects) {
      items.push(`  - [ ] \`${c.componentName}\` — add Read / Create / Edit / Delete as appropriate to relevant Permission Sets`);
    }
  }

  if (newFields.length > 0) {
    items.push("**Field-Level Security** — New fields need explicit Read/Edit access in Permission Sets:");
    const byObj = new Map<string, string[]>();
    for (const c of newFields) {
      const [obj, field] = c.componentName.split(".");
      if (!byObj.has(obj)) byObj.set(obj, []);
      byObj.get(obj)!.push(field ?? c.componentName);
    }
    for (const [obj, fields] of byObj) {
      items.push(`  - [ ] \`${obj}\` — fields: ${fields.map(f => `\`${f}\``).join(", ")}`);
      items.push(`        → Object Manager → ${obj} → Fields & Relationships → each field → Set FLS`);
      items.push(`        → Or retrieve updated permission set: \`sf project retrieve start -m PermissionSet -o <yourOrg>\``);
    }
  }

  if (newLayouts.length > 0) {
    items.push("**Page Layout Assignments** — New layouts need to be assigned to Profiles / Record Types:");
    for (const c of newLayouts) {
      const obj = c.componentName.split("-")[0];
      items.push(`  - [ ] \`${c.componentName}\` → Object Manager → ${obj} → Page Layout Assignment`);
    }
  }

  if (newRecordTypes.length > 0) {
    items.push("**Record Type Visibility** — New record types need Profile/Permission Set access:");
    for (const c of newRecordTypes) {
      items.push(`  - [ ] \`${c.componentName}\` — add to relevant Profiles and/or Permission Sets`);
    }
  }

  if (allFlows.length > 0) {
    items.push("**Flow Activation** — Flows deploy as inactive. Decide activation for each:");
    for (const c of allFlows) {
      items.push(`  - [ ] \`${c.componentName}\``);
      items.push(`        → Setup → Flows → find flow → Activate`);
      items.push(`        → OR document as a customer post-install step if they should control activation`);
    }
  }

  if (newPromptTpls.length > 0) {
    items.push("**Prompt Template Access** — New prompt templates may need Permission Set access:");
    for (const c of newPromptTpls) {
      items.push(`  - [ ] \`${c.componentName}\` — add to relevant Permission Sets if user-facing`);
    }
  }

  if (newTabs.length > 0) {
    items.push("**Tab Visibility / App Navigation** — New custom tabs need to be added to Apps:");
    for (const c of newTabs) {
      items.push(`  - [ ] \`${c.componentName}\` → App Manager → edit relevant App → add to navigation items`);
      items.push(`        → Also set Tab Settings to Default On in relevant Profiles`);
    }
  }

  if (newLWC.length > 0) {
    items.push("**Lightning Components** — If any are page/section components, place them in App Builder:");
    for (const c of newLWC) {
      items.push(`  - [ ] \`${c.componentName}\` → Setup → Lightning App Builder → add to relevant page(s)`);
    }
  }

  if (newPermSets.length > 0) {
    items.push("**New Permission Sets** — Document these for customers to assign post-install:");
    for (const c of newPermSets) {
      items.push(`  - [ ] \`${c.componentName}\` — add post-install note: assign to [role/user type]`);
    }
  }

  if (modPermSets.length > 0) {
    items.push("**Modified Permission Sets** — Already in package; updated FLS/OLS included automatically.");
    items.push("  Verify the retrieved XML has all expected field/object access before uploading:");
    for (const c of modPermSets) {
      items.push(`  - [ ] Verify \`${c.componentName}\` has correct access for all new fields/objects`);
    }
  }

  return items;
}

/** Scan commit messages for config-related keywords and return relevant commits. */
function filterConfigCommits(commits: CommitEntry[]): CommitEntry[] {
  const keywords = [
    "permission", "layout", "profile", "record type", "flow", "activat",
    "custom setting", "tab", "navigation", "app builder", "app page",
    "dashboard", "report", "sharing", "role", "access", "fls", "crud",
    "connected app", "auth provider", "list view",
  ];
  return commits.filter(c =>
    keywords.some(kw => c.subject.toLowerCase().includes(kw))
  );
}

function buildOneGPChecklist(
  components: ComponentChange[],
  pkgName: string,
  deployedOrg: string,
  sinceTag: string | null,
  date: string,
  commits: CommitEntry[],
  features: FeatureEntry[]
): string {
  const mustAdd      = components.filter(c => c.mustManuallyAdd && c.status !== "D");
  const autoIncluded = components.filter(c => !c.mustManuallyAdd && c.status === "M");
  const deleted      = components.filter(c => c.status === "D");

  const lines: string[] = [];
  lines.push(`# 1GP Packaging Checklist — ${pkgName}`);
  lines.push(`Generated: ${date}  |  Deployed to: \`${deployedOrg}\``);
  lines.push(sinceTag ? `Changes since: \`${sinceTag}\`` : "Changes: all tracked files (no prior 1GP deploy tag — first packaging run)");
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Section 1: New components to add to Package Manager ───────────────────
  if (mustAdd.length > 0) {
    lines.push("## Step 1 — Add New Components to Package Manager");
    lines.push("");
    lines.push("Navigate to each Setup path below and add the listed components.");
    lines.push("");

    const byPath = new Map<string, ComponentChange[]>();
    for (const c of mustAdd) {
      if (!byPath.has(c.setupPath)) byPath.set(c.setupPath, []);
      byPath.get(c.setupPath)!.push(c);
    }
    for (const [setupPath, comps] of byPath) {
      lines.push(`### ${setupPath}`);
      lines.push("");
      for (const c of comps) {
        lines.push(`- [ ] **${c.componentType}:** \`${c.componentName}\``);
      }
      lines.push("");
    }
  } else {
    lines.push("## Step 1 — No New Components");
    lines.push("All changed components are already in the package.");
    lines.push("");
  }

  // ── Section 2: Predicted manual configurations ────────────────────────────
  const derivedItems  = deriveConfigItems(components);
  const featureSetups = features.filter(f =>
    f.setup && f.setup.toLowerCase() !== "none — automatically active after install."
  );
  const configCommits = filterConfigCommits(commits);

  const hasConfig = derivedItems.length > 0 || featureSetups.length > 0 || configCommits.length > 0;

  lines.push("## Step 2 — Manual Configurations (Predicted)");
  lines.push("");
  if (!hasConfig) {
    lines.push("No manual configurations predicted from this change set.");
    lines.push("Still recommended: check Setup Audit Trail in jfcdev for any manual changes made since last install.");
    lines.push("");
  } else {
    lines.push("Based on the components changed, features documented, and commit history:");
    lines.push("");

    if (derivedItems.length > 0) {
      lines.push("### Derived from component changes");
      lines.push("");
      for (const item of derivedItems) {
        lines.push(item);
      }
      lines.push("");
    }

    if (featureSetups.length > 0) {
      lines.push("### From feature documentation (FEATURES.md — Setup required)");
      lines.push("");
      for (const f of featureSetups) {
        lines.push(`#### ${f.title}  _(${f.date})_`);
        lines.push("");
        for (const step of f.setup.split("\n").filter(Boolean)) {
          const normalized = step.trim().replace(/^[-*]\s*/, "");
          lines.push(`- [ ] ${normalized}`);
        }
        lines.push("");
      }
    }

    if (configCommits.length > 0) {
      lines.push("### Commits mentioning configuration — review these");
      lines.push("");
      lines.push("These commits contain keywords suggesting manual setup may be needed:");
      lines.push("");
      for (const c of configCommits) {
        lines.push(`- \`${c.hash}\` ${c.subject}  _(${c.date})_`);
      }
      lines.push("");
    }
  }

  // ── Section 3: Setup Audit Trail reminder ─────────────────────────────────
  lines.push("## Step 3 — Setup Audit Trail Check");
  lines.push("");
  lines.push("The above is predicted from source. To catch any manual Setup changes made in jfcdev");
  lines.push("during feature validation that did NOT make it into source:");
  lines.push("");
  lines.push(`- [ ] In \`${deployedOrg}\` → **Setup → Security → View Setup Audit Trail**`);
  lines.push("      Filter by date since last install. Look for: layout assignments, flow activations,");
  lines.push("      permission changes, app config, record type assignments.");
  lines.push("      For anything that should be in source: retrieve it and commit before next deploy.");
  lines.push("");

  // ── Section 4: Auto-included modified components ───────────────────────────
  if (autoIncluded.length > 0) {
    lines.push("## Auto-Included on Upload (no action needed)");
    lines.push("");
    lines.push("Already in the package — changes picked up automatically on next upload:");
    lines.push("");
    for (const c of autoIncluded) {
      lines.push(`- ${c.componentType}: \`${c.componentName}\``);
    }
    lines.push("");
  }

  // ── Section 5: Deleted components ─────────────────────────────────────────
  if (deleted.length > 0) {
    lines.push("## Deleted Components — Review");
    lines.push("");
    lines.push("Removed from source. 1GP cannot remove components once in a Released version.");
    lines.push("");
    for (const c of deleted) {
      lines.push(`- [ ] ${c.componentType}: \`${c.componentName}\``);
    }
    lines.push("");
  }

  // ── Section 6: Next steps ──────────────────────────────────────────────────
  lines.push("## Step 4 — Upload Package Version");
  lines.push("");
  lines.push(`1. In org **\`${deployedOrg}\`** → **Setup → Package Manager**`);
  lines.push("2. Confirm all new components from Step 1 are in the package");
  lines.push("3. Complete all configuration items from Step 2");
  lines.push("4. Click **Upload** — set version number and release notes");
  lines.push("5. Copy the install link and share with customers");
  lines.push("");

  return lines.join("\n");
}

function writeOneGPChecklist(repoPath: string, pkgDirPath: string, date: string, checklist: string): string {
  const docsDir = path.join(repoPath, "docs");
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  const dirSlug = pkgDirPath.replace(/\//g, "-").replace(/[^a-zA-Z0-9-]/g, "");
  const file = path.join(docsDir, `1gp-checklist-${dirSlug}-${date}.md`);
  fs.writeFileSync(file, checklist, "utf8");
  return file;
}

async function actionDeployOneGP(repo: RepoEntry, allOrgs: OrgInfo[]): Promise<void> {
  const proj    = readProject(repo.path);
  const pkgDirs = proj.packageDirectories;

  if (pkgDirs.length === 0) {
    console.log("\n  No package directories found.");
    return;
  }

  // Select sub-package(s)
  console.log("\n  Select sub-package to deploy to 1GP org:");
  pkgDirs.forEach((d, i) => {
    const label = d.package ? `${d.path}  (${d.package})` : d.path;
    console.log(`    ${i + 1}. ${label}`);
  });
  console.log(`    ${pkgDirs.length + 1}. Deploy ALL`);

  const idx = parseInt(await ask("\n  Which? ")) - 1;
  if (idx < 0 || idx > pkgDirs.length) { console.log("  Cancelled."); return; }
  const selectedDirs = idx === pkgDirs.length ? pkgDirs : [pkgDirs[idx]];

  // Resolve target org
  let targetOrg = repo.oneGPOrg ?? "";

  if (!targetOrg) {
    const targetOrgs = allOrgs.filter(o => !o.isDevHub);
    if (targetOrgs.length === 0) { console.log("  No target orgs found."); return; }

    console.log("\n  1GP packaging org (e.g. jfcdev):");
    targetOrgs.forEach((o, i) => {
      const type = o.isSandbox ? "Sandbox" : "Dev/Scratch";
      console.log(`    ${i + 1}. ${o.alias}  (${type})`);
    });

    const oIdx = parseInt(await ask("\n  Deploy to which org? ")) - 1;
    if (oIdx < 0 || oIdx >= targetOrgs.length) { console.log("  Cancelled."); return; }
    targetOrg = targetOrgs[oIdx].alias;

    const saveOrg = await ask(`\n  Save "${targetOrg}" as default 1GP org for ${repo.name}? (Y/n) `);
    if (saveOrg.toLowerCase() !== "n") {
      const allRepos = loadRepos();
      const entry    = allRepos.find(r => r.path === repo.path || r.path === expandHome(repo.path));
      if (entry) {
        entry.oneGPOrg = targetOrg;
        saveRepos(allRepos);
        repo.oneGPOrg = targetOrg;
        console.log("  ✓ Saved to repos.json");
      }
    }
  } else {
    console.log(`\n  Using configured 1GP org: ${targetOrg}`);
  }

  // Warn uncommitted changes
  for (const dir of selectedDirs) {
    warnUncommittedChanges(repo.path, dir.path);
  }

  // Show namespace injection preview
  let anyInjection = false;
  for (const dir of selectedDirs) {
    const preview = previewInjection(path.join(repo.path, dir.path));
    if (preview.length > 0) {
      if (!anyInjection) console.log();
      anyInjection = true;
      console.log(`  Namespace injection for ${dir.path}:`);
      preview.forEach(({ file, additions }) => console.log(`    ${file}  (+${additions})`));
    }
  }
  if (!anyInjection) console.log("\n  No namespace injection needed.");

  console.log();
  console.log("  " + hr());
  console.log(`  Repo:   ${repo.name}`);
  console.log(`  Dirs:   ${selectedDirs.map(d => d.path).join(", ")}`);
  console.log(`  Target: ${targetOrg}`);
  console.log("  " + hr());

  const go = await ask("\n  Proceed? (Y/n) ");
  if (go.toLowerCase() === "n") { console.log("  Cancelled."); return; }

  const today = new Date().toISOString().split("T")[0];
  let deploySuccess = true;

  // Deploy each selected directory
  for (const dir of selectedDirs) {
    const sourceDir = path.join(repo.path, dir.path);
    const backups   = injectAll(sourceDir);
    if (backups.size > 0) console.log(`\n  ✓ Namespace injected into ${backups.size} file(s) in ${dir.path}`);

    console.log(`\n  Deploying ${dir.path} → ${targetOrg}...`);
    console.log();

    try {
      runLive(
        `sf project deploy start --source-dir "${sourceDir}" --target-org ${targetOrg} --wait 30`,
        repo.path
      );
      console.log(`\n  ✓ Deployed ${dir.path}`);
    } catch (err: any) {
      console.error(`\n  ✗ Deploy failed for ${dir.path}:\n  ${err.message ?? ""}`);
      deploySuccess = false;
    }

    // Always revert namespace injection
    if (backups.size > 0) {
      revertAll(backups);
      console.log(`  ✓ Namespace injection reverted`);
    }
  }

  if (!deploySuccess) {
    console.log("\n  Deploy failed — fix the errors above before generating the Package Manager checklist.");
    return;
  }

  // Generate and write checklist for each deployed directory
  console.log();
  for (const dir of selectedDirs) {
    const sinceTag  = getLastOneGPTag(repo.path, dir.path);
    const components = getChangedComponents(repo.path, dir.path, sinceTag);
    const pkgName   = dir.package ?? dir.path;

    const commits       = getCommitsSince(repo.path, dir.path, sinceTag);
    const sinceDate     = sinceTag ? (() => { try { return run(`git log -1 --format=%ad --date=short ${sinceTag}`, repo.path); } catch { return undefined; } })() : undefined;
    const features      = parseFeaturesForPackage(repo.path, dir.path, sinceDate);
    const checklist     = buildOneGPChecklist(components, pkgName, targetOrg, sinceTag, today, commits, features);
    const checklistPath = writeOneGPChecklist(repo.path, dir.path, today, checklist);

    console.log(`  ✓ Checklist written → ${path.relative(repo.path, checklistPath)}`);

    const mustAdd = components.filter(c => c.mustManuallyAdd && c.status !== "D");
    if (mustAdd.length > 0) {
      console.log(`\n  ⚠️  ${mustAdd.length} component(s) must be manually added to Package Manager:`);
      mustAdd.slice(0, 12).forEach(c => console.log(`    • ${c.componentType}: ${c.componentName}`));
      if (mustAdd.length > 12) console.log(`    ... and ${mustAdd.length - 12} more (see checklist)`);
    } else {
      console.log("  ✓ No new components — all changes auto-included on next package upload");
    }

    // Tag the product repo to mark this 1GP deploy
    try {
      tagOneGP(repo.path, dir.path, today);
      console.log(`\n  ✓ Tagged: ${oneGPTagName(dir.path, today)}`);
    } catch { /* non-fatal */ }
  }

  console.log();
  console.log("  " + hr());
  console.log(`  Next: open Setup → Package Manager in ${targetOrg}`);
  console.log("  Add all new components from the checklist, then click Upload.");
  console.log("  " + hr());
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function promptDependencies(
  repo: RepoEntry,
  allRepos: RepoEntry[],
  existingDeps: PackageDependency[]
): Promise<PackageDependency[]> {
  const knownPackages: { label: string; alias: string }[] = [];

  for (const r of allRepos) {
    try {
      const proj = readProject(r.path);
      for (const [alias, id] of Object.entries(proj.packageAliases ?? {})) {
        if (id.startsWith("0Ho")) {
          knownPackages.push({ label: `${r.name} → ${alias}`, alias });
        }
      }
      for (const d of proj.packageDirectories) {
        if (d.package && !knownPackages.find(k => k.alias === d.package)) {
          knownPackages.push({ label: `${r.name} → ${d.package} (no ID yet)`, alias: d.package! });
        }
      }
    } catch { /* skip */ }
  }

  const seen = new Set<string>();
  const unique = knownPackages.filter(k => { if (seen.has(k.alias)) return false; seen.add(k.alias); return true; });

  if (unique.length === 0) { console.log("  No other packages found."); return existingDeps; }

  const deps = [...existingDeps];
  console.log();
  console.log("  Current dependencies: " + (deps.length ? deps.map(d => d.package).join(", ") : "none"));
  console.log();

  while (true) {
    console.log("  Available packages:");
    unique.forEach((k, i) => {
      const already = deps.find(d => d.package === k.alias) ? "  ✓" : "";
      console.log(`    ${i + 1}. ${k.label}${already}`);
    });
    console.log(`    ${unique.length + 1}. Done`);

    const choice = parseInt(await ask("\n  Add dependency #: "));
    if (choice === unique.length + 1 || isNaN(choice)) break;
    if (choice < 1 || choice > unique.length) { console.log("  Invalid."); continue; }

    const selected = unique[choice - 1];
    if (deps.find(d => d.package === selected.alias)) { console.log(`  Already added.`); continue; }

    const versionInput = await ask(`  Version constraint (default: LATEST, or e.g. 1.0): `);
    const versionNumber = versionInput ? `${versionInput}.0.LATEST` : "LATEST";
    deps.push({ package: selected.alias, versionNumber });
    console.log(`  ✓ Added: ${selected.alias} @ ${versionNumber}`);
  }

  return deps;
}

async function actionManageDependencies(repo: RepoEntry, allRepos: RepoEntry[]): Promise<void> {
  const proj    = readProject(repo.path);
  const packaged = proj.packageDirectories.filter(d => d.package);
  if (packaged.length === 0) { console.log("\n  No registered packages."); return; }

  console.log("\n  Configure dependencies for:");
  packaged.forEach((d, i) => {
    const depStr = d.dependencies?.length ? d.dependencies.map(x => x.package).join(", ") : "none";
    console.log(`    ${i + 1}. ${d.package}  (${d.path})  deps: ${depStr}`);
  });

  const idx = parseInt(await ask("\n  Sub-package #: ")) - 1;
  if (idx < 0 || idx >= packaged.length) { console.log("  Cancelled."); return; }
  const entry = packaged[idx];

  const updated = await promptDependencies(repo, allRepos, entry.dependencies ?? []);
  const fresh   = readProject(repo.path);
  const freshEntry = fresh.packageDirectories.find(d => d.path === entry.path)!;
  freshEntry.dependencies = updated.length > 0 ? updated : undefined;
  writeProject(repo.path, fresh);

  console.log(`\n  ✓ Dependencies saved for ${entry.package}.`);
  if (updated.length) updated.forEach(d => console.log(`  • ${d.package} @ ${d.versionNumber ?? "LATEST"}`));
  else console.log("  (none)");
}

/**
 * Look up the package type (Managed/Unlocked) for a package name from the DevHub.
 * Falls back to checking packageDir.packageType stored in sfdx-project.json.
 */
function getPackageType(pkgName: string, devHub: string, repoPath: string): "Managed" | "Unlocked" {
  // Check sfdx-project.json first (stored during registration)
  try {
    const proj = readProject(repoPath);
    const dir  = proj.packageDirectories.find(d => d.package === pkgName);
    if (dir?.packageType) return dir.packageType;
  } catch { /* fall through */ }

  // Query DevHub
  try {
    const raw  = run(`sf package list --target-dev-hub ${devHub} --json`, repoPath);
    const data = JSON.parse(raw);
    const pkg  = (data.result ?? []).find((p: any) =>
      p.Name === pkgName || p.Package2?.Name === pkgName
    );
    if (pkg?.ContainerOptions === "Managed" || pkg?.Package2?.ContainerOptions === "Managed") return "Managed";
    if (pkg) return "Unlocked";
  } catch { /* fall through */ }

  return "Managed"; // safe default
}

async function actionCreatePackage(repo: RepoEntry, devHub: string, allRepos: RepoEntry[]): Promise<void> {
  const proj        = readProject(repo.path);
  const unregistered = proj.packageDirectories.filter(d => !d.package);
  const registered   = proj.packageDirectories.filter(d =>  d.package);

  console.log();
  if (registered.length > 0) {
    console.log("  Already registered:");
    registered.forEach(d => {
      const typeLabel = d.packageType ? `  [${d.packageType}]` : "";
      console.log(`    • ${d.path}  →  ${d.package}${typeLabel}`);
    });
    console.log();
  }
  if (unregistered.length === 0) { console.log("  All directories already registered."); return; }

  console.log("  Unregistered directories:");
  unregistered.forEach((d, i) => console.log(`    ${i + 1}. ${d.path}`));

  const idx = parseInt(await ask("\n  Which to register? ")) - 1;
  if (idx < 0 || idx >= unregistered.length) { console.log("  Cancelled."); return; }
  const dir = unregistered[idx];

  const defaultName = repo.name + (unregistered.length > 1 ? `-${dir.path}` : "");
  const pkgName     = await ask(`  Package name (default: ${defaultName}): `) || defaultName;

  console.log();
  console.log("  Package type:");
  console.log("    1. Managed   — namespace-prefixed, upgradeable, code is protected (default for Revecast)");
  console.log("    2. Unlocked  — no namespace, components editable by installer, upgradeable");
  const typeChoice  = await ask("\n  Type (default: 1): ");
  const pkgType: "Managed" | "Unlocked" = typeChoice.trim() === "2" ? "Unlocked" : "Managed";

  console.log();
  try {
    runLive(
      `sf package create --name "${pkgName}" --package-type ${pkgType} --path ${dir.path} --target-dev-hub ${devHub}`,
      repo.path
    );

    const updated = readProject(repo.path);
    const entry   = updated.packageDirectories.find(d => d.path === dir.path);
    if (entry && !entry.package) {
      entry.package       = pkgName;
      entry.packageType   = pkgType;
      entry.versionName   = "ver 1.0";
      entry.versionNumber = "1.0.0.NEXT";
      writeProject(repo.path, updated);
    }

    console.log(`\n  ✓ "${pkgName}" registered as ${pkgType}. sfdx-project.json updated.`);

    if (pkgType === "Unlocked") {
      console.log("  Note: Unlocked packages do not require a namespace or installation key.");
    }

    const addDeps = await ask("\n  Configure dependencies now? (Y/n) ");
    if (addDeps.toLowerCase() !== "n") {
      await actionManageDependencies(repo, allRepos);
    }
    console.log("\n  Next: run 'Create package version' to build a beta.");

  } catch (err: any) {
    console.error(`\n  ✗ Failed: ${err.message}`);
  }
}

async function actionCreateVersion(repo: RepoEntry, devHub: string): Promise<void> {
  const proj    = readProject(repo.path);
  const packaged = proj.packageDirectories.filter(d => d.package);

  if (packaged.length === 0) {
    console.log("\n  No packages registered. Run 'Register new package' first.");
    return;
  }

  console.log();
  if (packaged.length === 1) {
    console.log(`  Package: ${packaged[0].package}  (${packaged[0].path})`);
  } else {
    console.log("  Packages:");
    packaged.forEach((d, i) => console.log(`    ${i + 1}. ${d.package}  (${d.path})  v${d.versionNumber ?? "?"}`));
  }

  let pkgDir: PackageDir;
  if (packaged.length === 1) {
    pkgDir = packaged[0];
  } else {
    const idx = parseInt(await ask("\n  Which to version? ")) - 1;
    if (idx < 0 || idx >= packaged.length) { console.log("  Cancelled."); return; }
    pkgDir = packaged[idx];
  }

  const currentVersion = pkgDir.versionNumber ?? "1.0.0.NEXT";
  const newVersion     = await promptVersionBump(currentVersion);
  const versionShort   = versionLabel(newVersion);

  // Determine package type — Unlocked packages skip namespace injection and don't need an install key
  const pkgType = getPackageType(pkgDir.package!, devHub, repo.path);
  const isUnlocked = pkgType === "Unlocked";

  let installKey = "";
  if (isUnlocked) {
    const keyInput = await ask(`\n  Installation key (leave blank for none — Unlocked packages don't require one): `);
    installKey = keyInput.trim();
  } else {
    const keyInput = await ask(`\n  Installation key (default: ${DEFAULT_INSTALL_KEY}): `);
    installKey = keyInput || DEFAULT_INSTALL_KEY;
  }

  const description = await ask("  Version description (optional): ");

  const sourceDir = path.join(repo.path, pkgDir.path);

  // Warn about uncommitted changes — they won't be in the package
  warnUncommittedChanges(repo.path, pkgDir.path);

  // Namespace injection only applies to Managed packages
  const preview = isUnlocked ? [] : previewInjection(sourceDir);

  console.log();
  if (isUnlocked) {
    console.log("  Unlocked package — namespace injection skipped.");
  } else if (preview.length > 0) {
    console.log(`  Namespace injection (${NAMESPACE}__ added before create, reverted after):`);
    preview.forEach(({ file, additions }) => console.log(`    ${file}  (+${additions})`));
  } else {
    console.log("  No namespace injection needed.");
  }

  // Find previous tag for release notes scoping
  const prevTag      = getLastVersionTag(repo.path, pkgDir.path);
  const hadNamespace = !!proj.namespace;

  // Destructive changes — Managed packages only, and only if Salesforce has enabled the feature
  const destructiveChangesFile = path.join(sourceDir, "destructiveChanges.xml");
  const existingDestructive    = fs.existsSync(destructiveChangesFile);
  let   deletedComponents: MetadataMember[] = [];

  if (!isUnlocked) {
    deletedComponents = getDeletedComponents(repo.path, pkgDir.path, prevTag);

    if (deletedComponents.length > 0) {
      console.log(`\n  ⚠️  ${deletedComponents.length} component(s) deleted from source since last version:`);
      deletedComponents.forEach(d => console.log(`    • ${d.type}: ${d.member}`));
      console.log();
      console.log("  If Salesforce has enabled 2GP component deletion on your DevHub, these can be");
      console.log("  removed from subscriber orgs by adding them to destructiveChanges.xml.");
      const addDestructive = await ask("  Add to destructiveChanges.xml? (Y/n) ");
      if (addDestructive.toLowerCase() !== "n") {
        // Merge with any existing destructiveChanges.xml entries
        const existingMembers: MetadataMember[] = [];
        if (existingDestructive) {
          const existing = fs.readFileSync(destructiveChangesFile, "utf8");
          const typeMatches = [...existing.matchAll(/<types>([\s\S]*?)<\/types>/g)];
          for (const tm of typeMatches) {
            const typeName   = tm[1].match(/<name>([^<]+)<\/name>/)?.[1] ?? "";
            const memberList = [...tm[1].matchAll(/<members>([^<]+)<\/members>/g)].map(mm => mm[1]);
            for (const member of memberList) {
              existingMembers.push({ type: typeName, member });
            }
          }
        }
        const seen = new Set(existingMembers.map(m => `${m.type}::${m.member}`));
        const merged = [
          ...existingMembers,
          ...deletedComponents.filter(d => !seen.has(`${d.type}::${d.member}`)),
        ];
        const apiVersion = proj.sourceApiVersion ?? "65.0";
        fs.writeFileSync(destructiveChangesFile, buildDestructiveChangesXml(merged, apiVersion), "utf8");
        console.log(`  ✓ destructiveChanges.xml ${existingDestructive ? "updated" : "created"} in ${pkgDir.path}`);
        console.log("  This file will be committed with the release. Remove it manually once the");
        console.log("  deletion version is promoted and all subscribers have upgraded.");
      }
    } else if (existingDestructive) {
      console.log(`\n  ℹ️  destructiveChanges.xml exists in ${pkgDir.path} — components listed there will be removed in this version.`);
      const xmlContent = fs.readFileSync(destructiveChangesFile, "utf8");
      const members    = [...xmlContent.matchAll(/<members>([^<]+)<\/members>/g)].map(m => m[1]);
      members.forEach(m => console.log(`    • ${m}`));
    }
  }

  console.log();
  console.log("  " + hr());
  console.log(`  Package:        ${pkgDir.package}  [${pkgType}]`);
  console.log(`  Version:        ${versionShort}`);
  console.log(`  Install key:    ${installKey || "(none)"}`);
  console.log(`  DevHub:         ${devHub}`);
  if (!isUnlocked) {
    console.log(`  Namespace:      ${hadNamespace ? "already set" : "temporarily added"}`);
  }
  console.log(`  Prev tag:       ${prevTag ?? "none (first version — all commits included)"}`);
  if (repo.testOrg) {
    console.log(`  Auto-install:   ${repo.testOrg} (from repos.json)`);
  }
  console.log("  " + hr());

  const go = await ask("\n  Proceed? (Y/n) ");
  if (go.toLowerCase() === "n") { console.log("  Cancelled."); return; }

  // Update sfdx-project.json with new version; only add temp namespace for Managed
  const workProj = readProject(repo.path);
  const workDir  = workProj.packageDirectories.find(d => d.path === pkgDir.path)!;
  workDir.versionNumber = newVersion;
  if (description) workDir.versionDescription = description;
  if (!isUnlocked && !workProj.namespace) workProj.namespace = NAMESPACE;
  writeProject(repo.path, workProj);

  // Snapshot aliases before version create so we can find the new one
  const prevAliases = { ...(readProject(repo.path).packageAliases ?? {}) };

  // Temporarily remove packageDirectories whose paths don't exist on disk —
  // sf CLI validates all dirs even when only building one package.
  // Write a backup first so a hard kill (Ctrl+C) can be recovered from.
  const sfdxProjectFile   = path.join(repo.path, "sfdx-project.json");
  const sfdxBackupFile    = path.join(repo.path, ".sfdx-project.json.packaging-backup");
  const currentProj       = readProject(repo.path);
  const missingDirs       = currentProj.packageDirectories.filter(
    d => d.path !== pkgDir.path && !fs.existsSync(path.join(repo.path, d.path))
  );
  let removedDirs = false;
  if (missingDirs.length > 0) {
    // Write backup before touching the file
    fs.copyFileSync(sfdxProjectFile, sfdxBackupFile);

    console.log(`\n  Temporarily removing ${missingDirs.length} packageDirectory entry(ies) whose source is not on this branch:`);
    missingDirs.forEach(d => console.log(`    • ${d.path} (${d.package ?? "unregistered"})`));
    currentProj.packageDirectories = currentProj.packageDirectories.filter(
      d => !missingDirs.includes(d)
    );
    writeProject(repo.path, currentProj);
    removedDirs = true;
  } else if (fs.existsSync(sfdxBackupFile)) {
    // Clean up any leftover backup from a previous interrupted run
    fs.copyFileSync(sfdxBackupFile, sfdxProjectFile);
    fs.unlinkSync(sfdxBackupFile);
    console.log(`  ✓ Restored sfdx-project.json from backup left by previous interrupted run`);
  }

  // Namespace injection — Managed only
  const backups = isUnlocked ? new Map<string, string>() : injectAll(sourceDir);
  if (backups.size > 0) console.log(`\n  ✓ Namespace injected into ${backups.size} file(s)`);

  const args = [
    `sf package version create`,
    `--package "${pkgDir.package}"`,
    installKey ? `--installation-key ${installKey}` : `--installation-key-bypass`,
    `--wait 60`,
    `--target-dev-hub ${devHub}`,
  ];
  if (description) args.push(`--version-description "${description}"`);

  console.log();
  console.log("  Creating package version — this takes 10–30 minutes...");
  console.log();

  let success   = false;
  let versionId = "";

  try {
    runLive(args.join(" "), repo.path);
    success = true;

    // Find the new version ID from updated sfdx-project.json
    const newVersion_ = findNewVersionId(repo.path, prevAliases);
    versionId         = newVersion_?.id ?? "";

    console.log();
    console.log("  " + hr());
    console.log(`  ✓ Package version created: ${pkgDir.package} v${versionShort}`);
    if (versionId) {
      console.log(`  Version ID: ${versionId}`);
      const urls = getInstallUrls(versionId);
      console.log();
      console.log("  Install URLs:");
      console.log(`    Sandbox:    ${urls.sandbox}`);
      console.log(`    Production: ${urls.production}`);
      console.log();
      console.log("  CLI install command:");
      console.log(`    sf package install --package ${versionId} --installation-key ${installKey} --wait 10 --target-org <alias>`);
    }
    console.log("  " + hr());

  } catch (err: any) {
    console.error("\n  ✗ Version creation failed:\n");
    console.error("  " + (err.message ?? "").split("\n").join("\n  "));
    console.log();
    console.log("  Common causes:");
    console.log("  • No namespace registry on DevHub — Setup → Company Profile → Packages → Namespace Registries");
    console.log("  • Apex test failures — managed packages require 75% coverage");
    console.log("  • Metadata type not packageable in managed packages");
    console.log("  • Already promoted a version at this major.minor — bump version and retry");
    console.log("  • Component exists in multiple package directories");
  }

  // Always revert namespace (Managed only — Unlocked has no backups/namespace)
  if (backups.size > 0) {
    revertAll(backups);
    console.log(`\n  ✓ Namespace injection reverted`);
  }
  if (!isUnlocked && !hadNamespace) {
    const clean = readProject(repo.path);
    delete clean.namespace;
    writeProject(repo.path, clean);
    console.log("  ✓ Temporary namespace removed from sfdx-project.json");
  }

  // Restore any packageDirectories that were temporarily removed
  if (removedDirs) {
    fs.copyFileSync(sfdxBackupFile, sfdxProjectFile);
    fs.unlinkSync(sfdxBackupFile);
    console.log(`  ✓ Restored sfdx-project.json (${missingDirs.length} packageDirectory entry(ies) added back)`);
  }

  if (!success) return;

  // ── Post-success: release notes, README, tag, registry, auto-install ───────

  // Record in local versions.json registry
  if (versionId) {
    recordVersion(repo.name, pkgDir.package!, versionShort, versionId, installKey);
    console.log(`  ✓ Recorded in versions.json`);
  }

  // Tag the product repo at this version (for future release notes scoping)
  try {
    tagVersion(repo.path, pkgDir.path, versionShort);
    console.log(`  ✓ Tagged repo: ${versionTagName(pkgDir.path, versionShort)}`);
  } catch { /* non-fatal */ }

  // Generate release notes
  let releaseNotesPath = "";
  if (versionId) {
    try {
      const notes  = buildReleaseNotes(repo, pkgDir, versionShort, versionId, prevTag, installKey);
      releaseNotesPath = writeReleasesFile(repo.path, pkgDir.package!, versionShort, notes);
      console.log(`  ✓ Release notes written → ${path.relative(repo.path, releaseNotesPath)}`);
      console.log(`     Also appended to docs/RELEASES.md`);
    } catch (e: any) {
      console.log(`  ! Release notes skipped: ${e.message}`);
    }

    // Update README
    try {
      updateProductReadme(repo.path, pkgDir.package!, versionShort, versionId, installKey);
      console.log(`  ✓ README.md updated with latest version info`);
    } catch (e: any) {
      console.log(`  ! README update skipped: ${e.message}`);
    }
  }

  // Auto-install to test org if configured
  if (repo.testOrg && versionId) {
    console.log();
    const autoInstallAns = await ask(`  Auto-install to test org "${repo.testOrg}"? (Y/n) `);
    if (autoInstallAns.toLowerCase() !== "n") {
      console.log();
      try {
        runLive(
          `sf package install --package ${versionId} --target-org ${repo.testOrg} --installation-key ${installKey} --wait 10`,
          repo.path
        );
        console.log(`\n  ✓ Installed in ${repo.testOrg}`);
      } catch (err: any) {
        console.error(`\n  ✗ Auto-install failed: ${err.message}`);
        console.log("  The package was created successfully — you can install manually using the URL above.");
      }
    }
  } else if (versionId) {
    console.log();
    console.log("  Tip: add a \"testOrg\" to repos.json to enable auto-install after each version create.");
  }

  // Commit all changes to the product repo
  console.log();
  const commitAns = await ask("  Commit release files to product repo? (sfdx-project.json, RELEASES.md, README.md) (Y/n) ");
  if (commitAns.toLowerCase() !== "n") {
    try {
      // Stage specific files — avoid accidentally committing other in-progress work
      const filesToStage = [
        "sfdx-project.json",
        "README.md",
        "docs/RELEASES.md",
        releaseNotesPath ? path.relative(repo.path, releaseNotesPath) : "",
      ].filter(Boolean);
      run(`git add ${filesToStage.join(" ")}`, repo.path);
      run(`git commit -m "chore(release): ${pkgDir.package} v${versionShort}"`, repo.path);
      console.log("  ✓ Committed");
    } catch (e: any) {
      console.log(`  ! Commit skipped: ${e.message}`);
    }
  }
}

async function actionPromote(repo: RepoEntry, devHub: string): Promise<void> {
  const proj    = readProject(repo.path);
  const aliases = Object.entries(proj.packageAliases ?? {}).filter(([, id]) => id.startsWith("04t"));

  if (aliases.length === 0) {
    console.log("\n  No package versions found. Create a version first.");
    return;
  }

  console.log("\n  Package versions:");
  aliases.forEach(([alias, id], i) => console.log(`    ${i + 1}. ${alias}  (${id})`));
  console.log("\n  Not seeing all versions? Run 'List all versions'.");

  const idx = parseInt(await ask("\n  Which version to promote? ")) - 1;
  if (idx < 0 || idx >= aliases.length) { console.log("  Cancelled."); return; }
  const [alias, versionId] = aliases[idx];

  console.log();
  console.log("  ⚠️  WARNING: Promotion cannot be undone.");
  console.log(`  ${alias} will become Released — installable in production.`);
  console.log("  You must bump the version number before creating new betas at this major.minor.");
  console.log();

  const confirm = await ask("  Type PROMOTE to confirm: ");
  if (confirm.toUpperCase() !== "PROMOTE") { console.log("  Cancelled."); return; }

  try {
    runLive(`sf package version promote --package ${versionId} --target-dev-hub ${devHub}`, repo.path);
    const urls = getInstallUrls(versionId);

    // Mark as promoted in local registry
    markPromoted(versionId);

    console.log(`\n  ✓ ${alias} promoted to Released.`);
    console.log(`  Production install URL: ${urls.production}`);

    // Offer to create a GitHub Release
    try {
      run("gh --version");  // check gh is available
      const ghRelease = await ask("\n  Create a GitHub Release with release notes? (Y/n) ");
      if (ghRelease.toLowerCase() !== "n") {
        // Find release notes file for this version
        // alias format is e.g. "revecast-recruiter@1.0.4-1" — extract package name and version
        const aliasParts          = alias.split("@");
        const pkgNameFromAlias    = aliasParts[0]?.trim() ?? alias;
        const versionShortFromAlias = aliasParts[1]?.split("-")[0]?.trim() ?? alias;
        const releaseFile = path.join(
          repo.path, "docs",
          `${pkgNameFromAlias.replace(/[^a-zA-Z0-9-]/g, "-")}-v${versionShortFromAlias}.md`
        );
        const notesArg = fs.existsSync(releaseFile) ? `--notes-file "${releaseFile}"` : `--notes "Released ${alias}"`;
        const tagName  = `${alias.replace(/[^a-zA-Z0-9.-]/g, "-")}`;
        try {
          run(`git tag -f ${tagName}`, repo.path);
          run(`git push origin ${tagName}`, repo.path);
        } catch { /* tag/push may fail if remote not configured */ }
        runLive(`gh release create "${tagName}" ${notesArg} --title "${alias}" --repo $(gh repo view --json nameWithOwner -q .nameWithOwner)`, repo.path);
        console.log(`  ✓ GitHub Release created: ${tagName}`);
      }
    } catch { /* gh not available or not a github repo — skip silently */ }

  } catch (err: any) {
    console.error(`\n  ✗ Promote failed: ${err.message}`);
  }
}

async function actionInstall(repo: RepoEntry, allOrgs: OrgInfo[]): Promise<void> {
  const proj    = readProject(repo.path);
  const aliases = Object.entries(proj.packageAliases ?? {}).filter(([, id]) => id.startsWith("04t"));

  if (aliases.length === 0) { console.log("\n  No package versions found."); return; }

  console.log("\n  Package versions:");
  aliases.forEach(([alias, id], i) => console.log(`    ${i + 1}. ${alias}  (${id})`));

  const vIdx = parseInt(await ask("\n  Which version to install? ")) - 1;
  if (vIdx < 0 || vIdx >= aliases.length) { console.log("  Cancelled."); return; }
  const [, versionId] = aliases[vIdx];

  const targetOrgs = allOrgs.filter(o => !o.isDevHub);
  if (targetOrgs.length === 0) { console.log("  No target orgs found."); return; }

  console.log("\n  Target org:");
  targetOrgs.forEach((o, i) => {
    const type = o.isSandbox ? "Sandbox" : "Scratch/Dev";
    console.log(`    ${i + 1}. ${o.alias}  (${type})`);
  });

  const oIdx = parseInt(await ask("\n  Install in which org? ")) - 1;
  if (oIdx < 0 || oIdx >= targetOrgs.length) { console.log("  Cancelled."); return; }
  const targetOrg = targetOrgs[oIdx].alias;

  const keyInput   = await ask(`\n  Installation key (default: ${DEFAULT_INSTALL_KEY}): `);
  const installKey = keyInput || DEFAULT_INSTALL_KEY;

  console.log();
  try {
    runLive(
      `sf package install --package ${versionId} --target-org ${targetOrg} --installation-key ${installKey} --wait 10`,
      repo.path
    );
    const urls = getInstallUrls(versionId);
    console.log(`\n  ✓ Installed in ${targetOrg}.`);
    console.log(`  Install URL: ${urls.sandbox}`);
  } catch (err: any) {
    console.error(`\n  ✗ Install failed: ${err.message}`);
    console.log("  If dependency error, ensure revecast-base is installed first.");
  }
}

async function actionListVersions(repo: RepoEntry, devHub: string): Promise<void> {
  const proj    = readProject(repo.path);
  const packaged = proj.packageDirectories.filter(d => d.package);
  if (packaged.length === 0) { console.log("\n  No packages registered."); return; }

  let pkgName: string;
  if (packaged.length === 1) {
    pkgName = packaged[0].package!;
  } else {
    console.log("\n  Packages:");
    packaged.forEach((d, i) => console.log(`    ${i + 1}. ${d.package}`));
    const idx = parseInt(await ask("\n  Which? ")) - 1;
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner();

  if (!preflight()) {
    rl.close();
    return;
  }

  let allRepoEntries = loadRepos();
  const localRepos   = allRepoEntries.filter(r => fs.existsSync(r.path));

  if (localRepos.length === 0 && allRepoEntries.length === 0) {
    console.log("  No repos found — rescanning ~/Documents...");
    allRepoEntries = discoverAndSaveRepos();
    if (allRepoEntries.length === 0) {
      console.log("  No Salesforce repos found in ~/Documents.");
      console.log("  Clone a repo there first, or run again after cloning.");
      rl.close();
      return;
    }
  }

  console.log("  Repos:");
  allRepoEntries.forEach((r, i) => {
    const cloned = fs.existsSync(r.path);
    if (!cloned) {
      console.log(`    ${i + 1}. ${r.name.padEnd(24)} (not cloned locally)`);
      return;
    }
    const proj     = (() => { try { return readProject(r.path); } catch { return null; } })();
    const pkgCount = proj?.packageDirectories.filter(d => d.package).length ?? 0;
    const total    = proj?.packageDirectories.length ?? 0;
    const status   = pkgCount > 0
      ? `${pkgCount}/${total} sub-packages registered`
      : total > 0 ? `${total} sub-package(s), none registered yet` : "no packageDirectories";
    const testTag  = r.testOrg ? `  [test: ${r.testOrg}]` : "";
    console.log(`    ${i + 1}. ${r.name.padEnd(24)} ${status}${testTag}`);
  });
  const addIdx = allRepoEntries.length + 1;
  console.log(`    ${addIdx}. Clone a new repo...`);

  const rIdx = parseInt(await ask("\n  Select repo: ")) - 1;
  if (rIdx < 0 || rIdx > allRepoEntries.length) { console.log("  Invalid."); rl.close(); return; }

  // ── Clone a new repo ──────────────────────────────────────────────────────
  if (rIdx === allRepoEntries.length) {
    const urlInput  = await ask("\n  Git URL (e.g. https://github.com/Revecast/my-repo.git): ");
    const cloneUrl  = urlInput.trim();
    if (!cloneUrl) { console.log("  Cancelled."); rl.close(); return; }

    // Derive name from URL (last path segment, strip .git)
    const inferredName = cloneUrl.split("/").pop()?.replace(/\.git$/, "") ?? "new-repo";
    const nameInput    = await ask(`  Local folder name (default: ${inferredName}): `);
    const repoName     = nameInput.trim() || inferredName;
    const cloneDest    = expandHome(`~/Documents/${repoName}`);

    console.log(`\n  Cloning into ${cloneDest}...`);
    console.log();
    try {
      runLive(`git clone "${cloneUrl}" "${cloneDest}"`);
      console.log(`\n  ✓ Cloned`);
    } catch (err: any) {
      console.error(`\n  ✗ Clone failed: ${err.message}`);
      rl.close();
      return;
    }

    const newEntry: RepoEntry = { name: repoName, path: cloneDest, testOrg: "", oneGPOrg: "", gitUrl: cloneUrl };
    allRepoEntries.push(newEntry);
    saveRepos(allRepoEntries);
    console.log(`  ✓ Added to repos.json`);
  }

  let repo = allRepoEntries[rIdx];

  // If a known repo isn't cloned locally, offer to clone it now
  if (!fs.existsSync(repo.path)) {
    console.log(`\n  "${repo.name}" is not cloned locally.`);
    const defaultUrl   = `https://github.com/Revecast/${repo.name}.git`;
    const suggestedUrl = repo.gitUrl || defaultUrl;
    const urlInput     = await ask(`  Git URL (default: ${suggestedUrl}): `);
    const cloneUrl     = urlInput.trim() || suggestedUrl;

    console.log(`\n  Cloning into ${repo.path}...`);
    console.log();
    try {
      runLive(`git clone "${cloneUrl}" "${repo.path}"`);
      console.log(`\n  ✓ Cloned`);
      const saved  = loadRepos();
      const entry  = saved.find(r => r.name === repo.name);
      if (entry) { entry.gitUrl = cloneUrl; saveRepos(saved); }
      repo = { ...repo, gitUrl: cloneUrl };
    } catch (err: any) {
      console.error(`\n  ✗ Clone failed: ${err.message}`);
      rl.close();
      return;
    }
  }

  // Branch check — packaging should happen from a dev/feature branch, not main/master
  console.log();
  const MAIN_BRANCHES = ["main", "master"];
  const PACKAGING_BRANCH = "develop";
  try {
    // Fetch so remote branch list is current
    try { run("git fetch --prune", repo.path); } catch { /* non-fatal */ }

    const currentBranch = run("git rev-parse --abbrev-ref HEAD", repo.path).trim();
    if (!MAIN_BRANCHES.includes(currentBranch)) {
      console.log(`  ✓ Branch: ${currentBranch}`);
    } else {
      // List available non-main branches to help the user pick
      let remoteBranches: string[] = [];
      try {
        remoteBranches = run("git branch -r", repo.path)
          .split("\n")
          .map(b => b.trim().replace(/^origin\//, ""))
          .filter(b => b && b !== "HEAD" && !MAIN_BRANCHES.includes(b) && !b.includes("->"));
      } catch { /* ignore */ }

      console.log(`  ⚠️  Current branch: ${currentBranch}`);
      console.log(`     Packages should not be built from '${currentBranch}'.`);
      if (remoteBranches.length > 0) {
        console.log(`     Available branches: ${remoteBranches.join(", ")}`);
      }

      const defaultBranch = remoteBranches.includes(PACKAGING_BRANCH)
        ? PACKAGING_BRANCH
        : remoteBranches.find(b => b.startsWith("develop")) ?? remoteBranches[0] ?? PACKAGING_BRANCH;

      const switchAns = await ask(`\n  Switch to '${defaultBranch}'? (Y/n) `);
      if (switchAns.toLowerCase() !== "n") {
        try {
          run(`git checkout ${defaultBranch}`, repo.path);
          console.log(`  ✓ Switched to ${defaultBranch}`);
        } catch {
          // Not local yet — try tracking from remote
          let switched = false;
          try {
            run(`git checkout -b ${defaultBranch} origin/${defaultBranch}`, repo.path);
            console.log(`  ✓ Created ${defaultBranch} tracking origin/${defaultBranch}`);
            switched = true;
          } catch {
            const createAns = await ask(`  '${defaultBranch}' not found locally. Create it from current branch? (Y/n) `);
            if (createAns.toLowerCase() !== "n") {
              try {
                run(`git checkout -b ${defaultBranch}`, repo.path);
                console.log(`  ✓ Created and switched to ${defaultBranch}`);
                switched = true;
              } catch (e2: any) {
                console.log(`  ✗ Could not create branch: ${(e2.message ?? "").split("\n")[0]}`);
              }
            }
          }
          if (!switched) {
            const cont = await ask("  Continue on current branch anyway? (y/N) ");
            if (cont.toLowerCase() !== "y") { rl.close(); return; }
          }
        }
      }
    }
  } catch { /* non-fatal — no git repo or other issue */ }

  // Auto-pull latest changes
  try {
    const pullOut = run("git pull --ff-only", repo.path);
    if (pullOut.includes("Already up to date") || pullOut.includes("up to date")) {
      console.log(`  ✓ ${repo.name} is up to date`);
    } else {
      console.log(`  ✓ Pulled latest changes:`);
      pullOut.split("\n").filter(Boolean).forEach(l => console.log(`    ${l}`));
    }
  } catch (err: any) {
    console.log(`  ⚠️  git pull failed — continuing with local state`);
    console.log(`     ${(err.message ?? "").split("\n")[0]}`);
  }

  const allOrgs = listOrgs();
  if (allOrgs.length === 0) {
    console.log("\n  No authenticated orgs. Run: sf org login web --alias <alias>");
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
  console.log("  (Must have the Revecast namespace registry — Setup → Packages → Namespaces)");

  const hubIdx = parseInt(await ask("\n  DevHub org #: ")) - 1;
  if (hubIdx < 0 || hubIdx >= allOrgs.length) { console.log("  Invalid."); rl.close(); return; }
  const devHub = allOrgs[hubIdx].alias;

  while (true) {
    console.log();
    console.log("  " + hr());
    console.log(`  Repo: ${repo.name}   DevHub: ${devHub}`);
    console.log("  " + hr());
    console.log();
    console.log("    1. Register new package          first-time setup per sub-package");
    console.log("    2. Create package version        builds a beta; injects namespace; generates release notes");
    console.log("    3. Promote version to Released   irreversible — enables prod installs");
    console.log("    4. Install version in org        test in scratch or sandbox");
    console.log("    5. List all versions             betas and released in DevHub");
    console.log("    6. Manage dependencies           set install prerequisites");
    console.log("    7. Version registry              all versions created, with install URLs and keys");
    console.log("    8. Deploy to 1GP packaging org   deploy + namespace-inject + generate Package Manager checklist");
    console.log("    9. Exit");
    console.log();

    const action = await ask("  Action: ");

    try {
      if      (action === "1") await actionCreatePackage(repo, devHub, allRepoEntries);
      else if (action === "2") await actionCreateVersion(repo, devHub);
      else if (action === "3") await actionPromote(repo, devHub);
      else if (action === "4") await actionInstall(repo, allOrgs);
      else if (action === "5") await actionListVersions(repo, devHub);
      else if (action === "6") await actionManageDependencies(repo, allRepoEntries);
      else if (action === "7") await actionShowRegistry();
      else if (action === "8") await actionDeployOneGP(repo, allOrgs);
      else if (action === "9") { console.log("\n  Goodbye.\n"); break; }
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
