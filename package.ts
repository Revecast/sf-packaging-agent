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
    const raw: { name: string; path: string; testOrg?: string }[] =
      JSON.parse(fs.readFileSync(REPOS_FILE, "utf8"));
    return raw.map(r => ({ name: r.name, path: expandHome(r.path), testOrg: r.testOrg }));
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
        found.push({ name: entry.name, path: repoPath, testOrg: "" });
      }
    } catch { /* skip malformed */ }
  }

  return found;
}

function saveRepos(repos: RepoEntry[]): void {
  fs.writeFileSync(
    REPOS_FILE,
    JSON.stringify(repos.map(r => ({ name: r.name, path: r.path, testOrg: r.testOrg ?? "" })), null, 2) + "\n",
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

async function actionCreatePackage(repo: RepoEntry, devHub: string, allRepos: RepoEntry[]): Promise<void> {
  const proj        = readProject(repo.path);
  const unregistered = proj.packageDirectories.filter(d => !d.package);
  const registered   = proj.packageDirectories.filter(d =>  d.package);

  console.log();
  if (registered.length > 0) {
    console.log("  Already registered:");
    registered.forEach(d => console.log(`    • ${d.path}  →  ${d.package}`));
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
  try {
    runLive(
      `sf package create --name "${pkgName}" --package-type Managed --path ${dir.path} --target-dev-hub ${devHub}`,
      repo.path
    );

    const updated = readProject(repo.path);
    const entry   = updated.packageDirectories.find(d => d.path === dir.path);
    if (entry && !entry.package) {
      entry.package       = pkgName;
      entry.versionName   = "ver 1.0";
      entry.versionNumber = "1.0.0.NEXT";
      writeProject(repo.path, updated);
    }

    console.log(`\n  ✓ "${pkgName}" registered. sfdx-project.json updated.`);

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

  const keyInput   = await ask(`\n  Installation key (default: ${DEFAULT_INSTALL_KEY}): `);
  const installKey = keyInput || DEFAULT_INSTALL_KEY;

  const description = await ask("  Version description (optional): ");

  const sourceDir = path.join(repo.path, pkgDir.path);

  // Warn about uncommitted changes — they won't be in the package
  warnUncommittedChanges(repo.path, pkgDir.path);

  const preview   = previewInjection(sourceDir);

  console.log();
  if (preview.length > 0) {
    console.log(`  Namespace injection (${NAMESPACE}__ added before create, reverted after):`);
    preview.forEach(({ file, additions }) => console.log(`    ${file}  (+${additions})`));
  } else {
    console.log("  No namespace injection needed.");
  }

  // Find previous tag for release notes scoping
  const prevTag     = getLastVersionTag(repo.path, pkgDir.path);
  const hadNamespace = !!proj.namespace;

  console.log();
  console.log("  " + hr());
  console.log(`  Package:        ${pkgDir.package}`);
  console.log(`  Version:        ${versionShort}`);
  console.log(`  Install key:    ${installKey}`);
  console.log(`  DevHub:         ${devHub}`);
  console.log(`  Namespace:      ${hadNamespace ? "already set" : "temporarily added"}`);
  console.log(`  Prev tag:       ${prevTag ?? "none (first version — all commits included)"}`);
  if (repo.testOrg) {
    console.log(`  Auto-install:   ${repo.testOrg} (from repos.json)`);
  }
  console.log("  " + hr());

  const go = await ask("\n  Proceed? (Y/n) ");
  if (go.toLowerCase() === "n") { console.log("  Cancelled."); return; }

  // Update sfdx-project.json with new version + temp namespace
  const workProj = readProject(repo.path);
  const workDir  = workProj.packageDirectories.find(d => d.path === pkgDir.path)!;
  workDir.versionNumber = newVersion;
  if (description) workDir.versionDescription = description;
  if (!workProj.namespace) workProj.namespace = NAMESPACE;
  writeProject(repo.path, workProj);

  // Snapshot aliases before version create so we can find the new one
  const prevAliases = { ...(readProject(repo.path).packageAliases ?? {}) };

  // Namespace injection
  const backups = injectAll(sourceDir);
  if (backups.size > 0) console.log(`\n  ✓ Namespace injected into ${backups.size} file(s)`);

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

  // Always revert namespace
  if (backups.size > 0) {
    revertAll(backups);
    console.log(`\n  ✓ Namespace injection reverted`);
  }
  if (!hadNamespace) {
    const clean = readProject(repo.path);
    delete clean.namespace;
    writeProject(repo.path, clean);
    console.log("  ✓ Temporary namespace removed from sfdx-project.json");
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

  let repos = loadRepos().filter(r => fs.existsSync(r.path));
  if (repos.length === 0) {
    console.log("  No repos found — rescanning ~/Documents...");
    repos = discoverAndSaveRepos().filter(r => fs.existsSync(r.path));
    if (repos.length === 0) {
      console.log("  No Salesforce repos found in ~/Documents.");
      console.log("  Make sure your repos are cloned there, then run again.");
      rl.close();
      return;
    }
  }

  console.log("  Repos:");
  repos.forEach((r, i) => {
    const proj     = (() => { try { return readProject(r.path); } catch { return null; } })();
    const pkgCount = proj?.packageDirectories.filter(d => d.package).length ?? 0;
    const total    = proj?.packageDirectories.length ?? 0;
    const status   = pkgCount > 0
      ? `${pkgCount}/${total} sub-packages registered`
      : total > 0 ? `${total} sub-package(s), none registered yet` : "no packageDirectories";
    const testTag  = r.testOrg ? `  [test: ${r.testOrg}]` : "";
    console.log(`    ${i + 1}. ${r.name.padEnd(24)} ${status}${testTag}`);
  });

  const rIdx = parseInt(await ask("\n  Select repo: ")) - 1;
  if (rIdx < 0 || rIdx >= repos.length) { console.log("  Invalid."); rl.close(); return; }
  const repo = repos[rIdx];

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
    console.log("    8. Exit");
    console.log();

    const action = await ask("  Action: ");

    try {
      if      (action === "1") await actionCreatePackage(repo, devHub, repos);
      else if (action === "2") await actionCreateVersion(repo, devHub);
      else if (action === "3") await actionPromote(repo, devHub);
      else if (action === "4") await actionInstall(repo, allOrgs);
      else if (action === "5") await actionListVersions(repo, devHub);
      else if (action === "6") await actionManageDependencies(repo, repos);
      else if (action === "7") await actionShowRegistry();
      else if (action === "8") { console.log("\n  Goodbye.\n"); break; }
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
