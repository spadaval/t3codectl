import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, chmodSync, lstatSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const REPOSITORY = "spadaval/t3codectl";
const ASSET_NAME = "t3codectl-linux-x64";
const RELEASE_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type CommandResult = { code: number; stdout: string; stderr: string };
type Runner = (args: string[]) => Promise<CommandResult>;

function versionParts(version: string): bigint[] {
  const match = version.match(RELEASE_VERSION);
  if (!match) throw new Error(`invalid t3codectl release version: ${version}`);
  return match.slice(1).map(BigInt);
}

function isNewer(candidate: string, installed: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(installed);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function commandError(action: string, result: CommandResult): Error {
  return new Error(`${action} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
}

export async function selfUpdate(options: { installPath: string; currentVersion: string; runGh: Runner }): Promise<"current" | "updated"> {
  const { installPath, currentVersion, runGh } = options;
  versionParts(currentVersion);
  const installed = lstatSync(installPath);
  if (!installed.isFile()) throw new Error(`${installPath} must be a regular installed executable`);

  const releaseResult = await runGh(["release", "view", "--repo", REPOSITORY, "--json", "tagName,assets"]);
  if (releaseResult.code !== 0) throw commandError("release lookup", releaseResult);
  let release: unknown;
  try { release = JSON.parse(releaseResult.stdout); } catch { throw new Error("release lookup returned invalid JSON"); }
  if (!release || typeof release !== "object") throw new Error("release lookup returned invalid metadata");
  const metadata = release as { tagName?: unknown; assets?: unknown };
  if (typeof metadata.tagName !== "string") throw new Error("release has no version tag");
  const targetVersion = metadata.tagName;
  if (!isNewer(targetVersion, currentVersion)) return "current";
  if (!Array.isArray(metadata.assets)) throw new Error("release has no assets");
  const asset = metadata.assets.find((entry: unknown) => entry && typeof entry === "object" && (entry as { name?: unknown }).name === ASSET_NAME) as
    | { name: string; digest?: unknown; size?: unknown }
    | undefined;
  if (!asset || typeof asset.digest !== "string" || !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest) ||
      typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`release ${targetVersion} has no valid ${ASSET_NAME} asset and SHA-256 digest`);
  }

  const staging = mkdtempSync(join(dirname(installPath), ".t3codectl-update-"));
  try {
    const download = await runGh(["release", "download", targetVersion, "--repo", REPOSITORY, "--pattern", ASSET_NAME, "--dir", staging]);
    if (download.code !== 0) throw commandError("release download", download);
    const candidate = join(staging, ASSET_NAME);
    const file = lstatSync(candidate);
    if (!file.isFile() || file.size !== asset.size) throw new Error("downloaded binary size does not match release metadata");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(candidate)) hash.update(chunk);
    if (hash.digest("hex") !== asset.digest.slice(7).toLowerCase()) throw new Error("downloaded binary SHA-256 does not match release metadata");
    chmodSync(candidate, 0o755);
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (probe.error || probe.status !== 0 || probe.stdout.trim() !== `t3codectl ${targetVersion}`) {
      throw new Error(`downloaded binary failed version check for ${targetVersion}`);
    }
    renameSync(candidate, installPath);
    return "updated";
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
