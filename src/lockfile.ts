/** Read the target repo's direct dependencies with resolved versions. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dependency } from "./types.ts";

function stripRange(range: string): string {
  return range.replace(/^[\^~>=<\s]*/, "").trim();
}

export function readDirectDependencies(targetRepo: string): Dependency[] {
  const pkg = JSON.parse(readFileSync(join(targetRepo, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  let lock: { packages?: Record<string, { version?: string }> } = {};
  try {
    lock = JSON.parse(readFileSync(join(targetRepo, "package-lock.json"), "utf8"));
  } catch {
    // no lockfile — fall back to the declared ranges
  }

  const names = Object.keys(pkg.dependencies ?? {});
  return names.map((name) => {
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    const version = locked ?? stripRange(pkg.dependencies![name]);
    return { name, version, direct: true };
  });
}
