import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  externalRuntimeUnpackPatterns,
  readExternalRuntimeManifest,
} from "./scripts/openclaw-runtime-manifest.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const runtimeManifest = readExternalRuntimeManifest(packageRoot);
const stagedApp = process.env.LONGHUB_RELEASE_APP_DIR
  ? resolve(process.env.LONGHUB_RELEASE_APP_DIR)
  : packageRoot;

export default {
  ...packageJson.build,
  directories: {
    ...packageJson.build.directories,
    app: stagedApp,
    output: join(packageRoot, packageJson.build.directories.output),
  },
  asar: true,
  asarUnpack: externalRuntimeUnpackPatterns(runtimeManifest),
};
