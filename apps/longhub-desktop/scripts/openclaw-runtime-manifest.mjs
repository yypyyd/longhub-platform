import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNTIME_MANIFEST_SCHEMA = "longhub/openclaw-external-runtime/v1";

function installedPackage(name, fromDirectory) {
  for (let current = fromDirectory; ; current = dirname(current)) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(current);
    if (parent === current) return undefined;
  }
}

function packageMetadata(packageDirectory) {
  return JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
}

export function computeExternalRuntimeManifest(packageRoot) {
  const roots = ["openclaw", "@longhub/openclaw-bridge"];
  const queue = roots.map((name) => ({ name, fromDirectory: packageRoot, required: true }));
  const visitedDirectories = new Set();
  const packageNames = new Set();
  const versions = new Map();

  while (queue.length > 0) {
    const item = queue.shift();
    const packageDirectory = installedPackage(item.name, item.fromDirectory);
    if (!packageDirectory) {
      if (item.required) throw new Error(`外置运行时缺少依赖 ${item.name}（来自 ${item.fromDirectory}）`);
      continue;
    }
    const key = packageDirectory.toLowerCase();
    if (visitedDirectories.has(key)) continue;
    visitedDirectories.add(key);
    const metadata = packageMetadata(packageDirectory);
    packageNames.add(metadata.name ?? item.name);
    if (typeof metadata.version === "string") {
      const known = versions.get(metadata.name ?? item.name) ?? new Set();
      known.add(metadata.version);
      versions.set(metadata.name ?? item.name, known);
    }

    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      queue.push({ name: dependency, fromDirectory: packageDirectory, required: true });
    }
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) {
      queue.push({ name: dependency, fromDirectory: packageDirectory, required: false });
    }
    for (const dependency of Object.keys(metadata.peerDependencies ?? {})) {
      if (installedPackage(dependency, packageDirectory)) {
        queue.push({ name: dependency, fromDirectory: packageDirectory, required: false });
      }
    }
  }

  const openclawDirectory = installedPackage("openclaw", packageRoot);
  const openclaw = packageMetadata(openclawDirectory);
  return {
    schema: RUNTIME_MANIFEST_SCHEMA,
    openclawVersion: openclaw.version,
    roots,
    packages: [...packageNames].sort(),
    resolvedVersions: Object.fromEntries(
      [...versions].sort(([left], [right]) => left.localeCompare(right))
        .map(([name, values]) => [name, [...values].sort()]),
    ),
  };
}

export function runtimeManifestPath(packageRoot) {
  return join(packageRoot, "openclaw-runtime-packages.json");
}

export function readExternalRuntimeManifest(packageRoot) {
  const path = runtimeManifestPath(packageRoot);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.schema !== RUNTIME_MANIFEST_SCHEMA || !Array.isArray(manifest.packages)) {
    throw new Error(`外置运行时白名单格式无效: ${path}`);
  }
  return manifest;
}

export function verifyExternalRuntimeManifest(packageRoot) {
  const recorded = readExternalRuntimeManifest(packageRoot);
  const computed = computeExternalRuntimeManifest(packageRoot);
  if (JSON.stringify(recorded) !== JSON.stringify(computed)) {
    throw new Error("OpenClaw 外置运行时白名单已漂移；请审查依赖变化后执行 pnpm runtime:manifest");
  }
  return recorded;
}

export function externalRuntimeUnpackPatterns(manifest) {
  return manifest.packages.flatMap((name) => [
    `node_modules/${name}/**/*`,
    `node_modules/**/node_modules/${name}/**/*`,
  ]);
}

function main(argv) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (argv.length !== 1 || argv[0] !== "--write") {
    throw new Error("用法: node scripts/openclaw-runtime-manifest.mjs --write");
  }
  const target = runtimeManifestPath(packageRoot);
  const rel = relative(packageRoot, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("运行时白名单路径越界");
  writeFileSync(target, `${JSON.stringify(computeExternalRuntimeManifest(packageRoot), null, 2)}\n`, "utf8");
  process.stdout.write(`${target}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
