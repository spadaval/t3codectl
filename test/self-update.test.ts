import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfUpdate } from "../src/self-update.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(reportedVersion = "v0.2.4") {
  const directory = mkdtempSync(join(tmpdir(), "t3codectl-test-"));
  directories.push(directory);
  const installPath = join(directory, "t3codectl");
  const candidate = join(directory, "candidate");
  writeFileSync(installPath, "old executable\n", { mode: 0o755 });
  writeFileSync(candidate, `#!/bin/sh\nprintf 't3codectl ${reportedVersion}\\n'\n`, { mode: 0o755 });
  chmodSync(candidate, 0o755);
  const binary = readFileSync(candidate);
  const digest = `sha256:${createHash("sha256").update(binary).digest("hex")}`;
  return { directory, installPath, candidate, digest, size: binary.length };
}

function runner(f: ReturnType<typeof fixture>, digest = f.digest) {
  const calls: string[][] = [];
  const runGh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "release" && args[1] === "view") {
      return { code: 0, stdout: JSON.stringify({ tagName: "v0.2.4", assets: [{ name: "t3codectl-linux-x64", digest, size: f.size }] }), stderr: "" };
    }
    const destination = args[args.indexOf("--dir") + 1];
    copyFileSync(f.candidate, join(destination, "t3codectl-linux-x64"));
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runGh, calls };
}

test("current version leaves the executable alone without downloading", async () => {
  const f = fixture();
  const gh = runner(f);
  expect(await selfUpdate({ installPath: f.installPath, currentVersion: "v0.2.4", runGh: gh.runGh })).toBe("current");
  expect(gh.calls).toHaveLength(1);
  expect(readFileSync(f.installPath, "utf8")).toBe("old executable\n");
});

test("verified release replaces the executable atomically", async () => {
  const f = fixture();
  const gh = runner(f);
  expect(await selfUpdate({ installPath: f.installPath, currentVersion: "v0.2.3", runGh: gh.runGh })).toBe("updated");
  expect(readFileSync(f.installPath, "utf8")).toBe(readFileSync(f.candidate, "utf8"));
  expect(readdirSync(f.directory).sort()).toEqual(["candidate", "t3codectl"]);
});

test("checksum mismatch preserves the installed executable", async () => {
  const f = fixture();
  const gh = runner(f, `sha256:${"0".repeat(64)}`);
  await expect(selfUpdate({ installPath: f.installPath, currentVersion: "v0.2.3", runGh: gh.runGh })).rejects.toThrow("SHA-256");
  expect(readFileSync(f.installPath, "utf8")).toBe("old executable\n");
  expect(readdirSync(f.directory).sort()).toEqual(["candidate", "t3codectl"]);
});

test("wrong executable version preserves the installed executable", async () => {
  const f = fixture("v0.2.5");
  const gh = runner(f);
  await expect(selfUpdate({ installPath: f.installPath, currentVersion: "v0.2.3", runGh: gh.runGh })).rejects.toThrow("version check");
  expect(readFileSync(f.installPath, "utf8")).toBe("old executable\n");
});
