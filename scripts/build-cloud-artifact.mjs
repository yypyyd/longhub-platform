import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SURFACES = {
  "cloud-plugin": {
    packageName: "@longhub/openclaw-cloud-plugin",
    productSurface: "longhub-cloud-plugin",
    schemaVersion: "longhub/cloud-plugin-release/v1",
    filename(version) {
      return `longhub-openclaw-cloud-plugin-${version}.tgz`;
    },
    adminPath: "/v1/admin/cloud-plugin-releases",
  },
  "cloud-cli": {
    packageName: "@longhub/cloud-cli",
    productSurface: "longhub-cloud-cli",
    schemaVersion: "longhub/cloud-cli-release/v1",
    filename(version) {
      return `longhub-cloud-cli-${version}.tgz`;
    },
    adminPath: "/v1/admin/cloud-cli-releases",
  },
};

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const options = parseArgs(process.argv.slice(2));
const config = SURFACES[options.surface];
if (!config) throw new Error("--surface must be cloud-plugin or cloud-cli");

const packageRoot = process.cwd();
const workspaceRoot = resolve(packageRoot, "../..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
if (packageJson.name !== config.packageName || !SEMVER_PATTERN.test(packageJson.version)) {
  throw new Error("package identity/version does not match the selected release surface");
}

const channel = options.channel ?? "stable";
if (channel !== "stable" && channel !== "beta") throw new Error("--channel must be stable or beta");
const filename = config.filename(packageJson.version);
const outputDir = resolve(
  options.outputDir ?? join(workspaceRoot, "release", options.surface, packageJson.version),
);
const temporaryRoot = await mkdtemp(join(tmpdir(), `longhub-${options.surface}-pack-`));

try {
  const firstDir = join(temporaryRoot, "first");
  const secondDir = join(temporaryRoot, "second");
  await Promise.all([mkdir(firstDir), mkdir(secondDir)]);
  const firstPath = runPack(packageRoot, firstDir, filename);
  const secondPath = runPack(packageRoot, secondDir, filename);
  verifyStandaloneArtifact(firstPath);
  verifyStandaloneArtifact(secondPath);
  const [firstBytes, secondBytes] = await Promise.all([readFile(firstPath), readFile(secondPath)]);
  const digest = sha256(firstBytes);
  if (firstBytes.length !== secondBytes.length || digest !== sha256(secondBytes) ||
      !firstBytes.equals(secondBytes)) {
    throw new Error("npm tgz is not byte-for-byte reproducible");
  }

  await mkdir(outputDir, { recursive: true });
  const artifactPath = join(outputDir, filename);
  await preserveImmutableArtifact(firstPath, artifactPath, firstBytes);

  const uploadQuery = new URLSearchParams({
    version: packageJson.version,
    filename,
    channel,
  });
  const candidate = {
    schema_version: config.schemaVersion,
    product_surface: config.productSurface,
    version: packageJson.version,
    filename,
    size: firstBytes.length,
    sha256: digest,
    compatibility: {
      openclaw_version: "2026.7.1-2",
      node: ">=20",
    },
    admin_upload_path: `${config.adminPath}?${uploadQuery.toString()}`,
    initial_rollout: { status: "paused", basis_points: 0 },
    signature: null,
  };
  await Promise.all([
    writeFile(join(outputDir, "SHA256SUMS"), `${digest}  ${filename}\n`, "utf8"),
    writeFile(join(outputDir, "release-candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`, "utf8"),
  ]);

  process.stdout.write(`${JSON.stringify({
    artifact: artifactPath,
    sha256: digest,
    size: firstBytes.length,
    candidate: join(outputDir, "release-candidate.json"),
    signed: false,
  })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function runPack(packageRoot, destination, expectedFilename) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = npmExecPath
    ? [npmExecPath, "pack", "--pack-destination", destination]
    : ["pack", "--pack-destination", destination];
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: { ...process.env, TZ: "UTC" },
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "pnpm pack failed").trim().slice(0, 500);
    throw new Error(`pnpm pack failed: ${detail}`);
  }
  return join(destination, expectedFilename);
}

function verifyStandaloneArtifact(artifact) {
  const metadataResult = spawnSync("tar", ["-xOzf", artifact, "package/package.json"], {
    encoding: "utf8",
    shell: false,
  });
  if (metadataResult.status !== 0) {
    throw new Error("unable to inspect packed artifact metadata");
  }
  const metadata = JSON.parse(String(metadataResult.stdout));
  if (metadata.dependencies && Object.keys(metadata.dependencies).length > 0) {
    throw new Error("signed artifact must not require npm registry dependencies");
  }
  const listingResult = spawnSync("tar", ["-tzf", artifact], { encoding: "utf8", shell: false });
  if (listingResult.status !== 0 || String(listingResult.stdout).split(/\r?\n/u)
    .some((entry) => entry.startsWith("package/node_modules/"))) {
    throw new Error("signed artifact must be a standalone bundle without node_modules");
  }
}

async function preserveImmutableArtifact(source, target, expectedBytes) {
  try {
    const existing = await readFile(target);
    if (!existing.equals(expectedBytes)) {
      throw new Error("local release version already exists with different bytes");
    }
    return;
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  await copyFile(source, target, fsConstants.COPYFILE_EXCL);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--") continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${option}`);
    if (option === "--surface") parsed.surface = value;
    else if (option === "--out-dir") parsed.outputDir = value;
    else if (option === "--channel") parsed.channel = value;
    else throw new Error(`unknown option: ${option}`);
    index += 1;
  }
  return parsed;
}
