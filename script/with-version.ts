#!/usr/bin/env bun
/**
 * Run a command with PKG_VERSION (and the matching Kilo CLI build env vars)
 * derived from packages/opencode/package.json.
 *
 * Mirrors anaconda-cli's scripts/with_version.py, adapted for this repo's
 * version source (the CLI's own package.json instead of a git tag).
 *
 * Usage:
 *   bun run script/with-version.ts                                     # print version only
 *   bun run script/with-version.ts bun run --cwd packages/opencode script/build.ts --single --skip-install
 *   bun run script/with-version.ts rattler-build build --recipe conda.recipe
 */
import path from "path"
import { fileURLToPath } from "url"

const dir = path.dirname(fileURLToPath(import.meta.url))
const manifest = path.resolve(dir, "../packages/opencode/package.json")
const version: string = (await Bun.file(manifest).json()).version

const command = process.argv.slice(2)
if (command.length === 0) {
  console.log(version)
  process.exit(0)
}

// GitHub Actions sets this natively (monotonically increasing per workflow,
// no full-history checkout needed) so every push to main gets a distinct,
// uploadable conda build number without touching the CLI's own semver.
const build = process.env.GITHUB_RUN_NUMBER ?? "0"

console.log(`PKG_VERSION=${version}`)
console.log(`PKG_BUILD_NUMBER=${build}`)
const env = {
  ...process.env,
  PKG_VERSION: version,
  PKG_BUILD_NUMBER: build,
  // Pin the build to this checkout's version instead of Script.version's
  // network-dependent "next release" bump, matching nix/kilo.nix.
  KILO_VERSION: version,
  KILO_CHANNEL: "local",
  KILO_DISABLE_MODELS_FETCH: "1",
  KILO_SKIP_BUNDLED_BWRAP: "1",
}

const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit", stdin: "inherit", env, windowsHide: true })
process.exit(await proc.exited)
