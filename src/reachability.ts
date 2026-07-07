/**
 * Module-level reachability analysis.
 *
 * Builds a file-level import graph over the target's source, then BFS from the
 * application entrypoint to determine which files are on a live call path. A
 * vulnerable package is "reachable" only if a reachable file imports it.
 *
 * Honest limits (surfaced in the demo): this is a static import graph. It does
 * not resolve reflection, dynamic require of computed names, or build-time
 * injection — which is precisely why the ESCALATE branch exists.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import type { ReachabilityEvidence } from "./types.ts";

const ENTRY_CANDIDATES = ["src/index.ts", "src/main.ts", "src/server.ts", "index.ts"];

const IMPORT_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function specifiers(content: string): string[] {
  const found = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) found.add(m[1]);
  }
  return [...found];
}

function packageName(spec: string): string {
  if (spec.startsWith("@")) {
    const [scope, pkg] = spec.split("/");
    return pkg ? `${scope}/${pkg}` : scope;
  }
  return spec.split("/")[0];
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.endsWith(".js") ? base.slice(0, -3) + ".ts" : null,
    base.endsWith(".ts") ? base : null,
    base + ".ts",
    base + ".tsx",
    join(base, "index.ts"),
    base,
  ].filter((c): c is string => c !== null);
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

export interface Reachability {
  scannedFiles: number;
  entry: string | null;
  forPackage(name: string): ReachabilityEvidence;
}

export function buildReachability(targetRepo: string): Reachability {
  const srcRoot = existsSync(join(targetRepo, "src")) ? join(targetRepo, "src") : targetRepo;
  const files = walk(srcRoot);
  const rel = (f: string) => relative(targetRepo, f).replace(/\\/g, "/");

  // file -> relative imports (resolved file targets) and package imports
  const fileEdges = new Map<string, string[]>();
  const pkgImporters = new Map<string, Set<string>>();

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const edges: string[] = [];
    for (const spec of specifiers(content)) {
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const target = resolveRelative(file, spec);
        if (target) edges.push(target);
      } else {
        const pkg = packageName(spec);
        if (!pkgImporters.has(pkg)) pkgImporters.set(pkg, new Set());
        pkgImporters.get(pkg)!.add(rel(file));
      }
    }
    fileEdges.set(file, edges);
  }

  // find entrypoint
  let entry: string | null = null;
  for (const cand of ENTRY_CANDIDATES) {
    const p = join(targetRepo, cand);
    if (existsSync(p)) {
      entry = p;
      break;
    }
  }

  // BFS from entry
  const depth = new Map<string, number>();
  const parent = new Map<string, string | null>();
  if (entry) {
    const queue: string[] = [entry];
    depth.set(entry, 0);
    parent.set(entry, null);
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of fileEdges.get(cur) ?? []) {
        if (!depth.has(next)) {
          depth.set(next, depth.get(cur)! + 1);
          parent.set(next, cur);
          queue.push(next);
        }
      }
    }
  }

  function pathTo(fileAbs: string): string[] {
    const chain: string[] = [];
    let cur: string | null | undefined = fileAbs;
    while (cur) {
      chain.unshift(rel(cur));
      cur = parent.get(cur);
    }
    return chain;
  }

  return {
    scannedFiles: files.length,
    entry: entry ? rel(entry) : null,
    forPackage(name: string): ReachabilityEvidence {
      const importers = [...(pkgImporters.get(name) ?? [])].sort();
      // reachable importer files (their abs paths are in `depth`)
      const reachableImporters = files.filter(
        (f) => importers.includes(rel(f)) && depth.has(f),
      );
      reachableImporters.sort((a, b) => depth.get(a)! - depth.get(b)!);
      const nearest = reachableImporters[0];
      return {
        reachable: reachableImporters.length > 0,
        importSites: importers,
        reachablePath: nearest ? pathTo(nearest) : null,
        scannedFiles: files.length,
      };
    },
  };
}
