import { test, expect } from "bun:test";
import { belongsToService, configureService } from "../src/service-setup.ts";

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const operations = {
    installed: true,
    install: async () => { calls.push('install'); },
    write: async () => { calls.push('write'); return { serverChanged: false, restartPending: false }; },
    active: async () => true,
    idle: async () => true,
    markPending: () => { calls.push('pending'); },
    restart: async () => { calls.push('restart'); },
    start: async () => { calls.push('start'); },
    ...overrides,
  };
  return { operations, calls };
}

test("running systemd service ownership includes v1/v2 cgroups and child scopes", () => {
  expect(belongsToService('0::/user.slice/user-0.slice/user@0.service/app.slice/t3code.service', 't3code.service')).toBe(true);
  expect(belongsToService('1:name=systemd:/user.slice/t3code.service/child.scope', 't3code.service')).toBe(true);
  expect(belongsToService('0::/user.slice/other-t3code.service', 't3code.service')).toBe(false);
  expect(belongsToService('0::/t3code.service-other', 't3code.service')).toBe(false);
});

test("running instance and updater-only reconfiguration skip install, start and restart", async () => {
  const { operations, calls } = fixture();
  expect(await configureService(operations)).toBe('unchanged');
  expect(calls).toEqual(['write']);
});

test("missing service is installed, stopped existing service only starts", async () => {
  const fresh = fixture({ installed: false, active: async () => false });
  expect(await configureService(fresh.operations)).toBe('started');
  expect(fresh.calls).toEqual(['write', 'install', 'start']);
  const stopped = fixture({ active: async () => false });
  expect(await configureService(stopped.operations)).toBe('started');
  expect(stopped.calls).toEqual(['write', 'start']);
});

test("server changes and repair restart only when idle", async () => {
  const changed = { write: async () => ({ serverChanged: true, restartPending: false }) };
  const busy = fixture({ ...changed, idle: async () => false });
  expect(await configureService(busy.operations)).toBe('deferred');
  expect(busy.calls).toEqual(['pending']);
  const idle = fixture(changed);
  expect(await configureService(idle.operations)).toBe('restarted');
  expect(idle.calls).toEqual(['pending', 'restart']);
  const repair = fixture({ forceRestart: true, idle: async () => false });
  expect(await configureService(repair.operations)).toBe('deferred');
  expect(repair.calls).toEqual(['write', 'pending']);
});

test("pending changes survive repeated setup and failed idle checks/restarts", async () => {
  const pending = fixture({ write: async () => ({ serverChanged: false, restartPending: true }), idle: async () => false });
  expect(await configureService(pending.operations)).toBe('deferred');
  expect(pending.calls).toEqual(['pending']);
  const failedCheck = fixture({ forceRestart: true, idle: async () => { throw Error('unreadable'); } });
  await expect(configureService(failedCheck.operations)).rejects.toThrow('unreadable');
  expect(failedCheck.calls).toEqual(['write', 'pending']);
  const failedRestart = fixture({ forceRestart: true, restart: async () => { throw Error('restart failed'); } });
  await expect(configureService(failedRestart.operations)).rejects.toThrow('restart failed');
  expect(failedRestart.calls).toEqual(['write', 'pending']);
});

import { withConfigurationLock } from "../src/service-setup.ts";
import { resolveConnectionUrl } from "../src/config.ts";
import { pendingConnection, readPending, writePending, needsNativeRepair } from "../src/pending-config.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const old = { configPath: '/config', host: 'old-host', port: 3773, baseUrl: 'http://old-host:3773' };
const applied = { ...old, host: 'new-host', port: 3774, baseUrl: 'http://new-host:3774' };

test("pending state preserves actual endpoint across failed health and another proposed change", async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-pending-test-'));
  const path = join(dir, 'pending.json');
  try {
    writePending(path, old);
    expect(pendingConnection(readPending(path, applied))).toEqual(old);
    writePending(path, old, { restartCompleted: true, applied });
    const proposed = { ...applied, host: 'third-host', port: 3775 };
    expect(pendingConnection(readPending(path, proposed))).toEqual(applied);
    const repeat = fixture({ write: async () => ({ serverChanged: false, restartPending: !readPending(path, applied)!.restartCompleted }) });
    expect(await configureService(repeat.operations)).toBe('unchanged');
    expect(repeat.calls).toEqual([]);
    expect(readPending(path, applied)!.restartCompleted).toBe(true);
    writePending(path, pendingConnection(readPending(path, proposed))!);
    expect(pendingConnection(readPending(path, proposed))).toEqual(applied);
    writePending(path, old, { restartCompleted: true });
    expect(() => readPending(path, applied)).toThrow('invalid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit native repair is deferred while busy and runs for idle or stopped units", async () => {
  for (const active of [true, false]) {
    const c = fixture({ active: async () => active });
    (c.operations as any).repairExisting = async () => { c.calls.push('native-repair'); };
    expect(await configureService(c.operations)).toBe('repaired');
    expect(c.calls).toEqual(['write', 'pending', 'native-repair']);
  }
  const busy = fixture({ idle: async () => false });
  (busy.operations as any).repairExisting = async () => { busy.calls.push('native-repair'); };
  expect(await configureService(busy.operations)).toBe('deferred');
  expect(busy.calls).toEqual(['write', 'pending']);
});

test("configuration lock excludes an update and releases on failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-lock-test-'));
  const path = join(dir, 'update.lock');
  try {
    await withConfigurationLock(path, async () => {
      await expect(withConfigurationLock(path, async () => { throw Error('must not run'); })).rejects.toThrow('another setup');
    });
    await expect(withConfigurationLock(path, async () => { throw Error('action failed'); })).rejects.toThrow('action failed');
    expect(await withConfigurationLock(path, async () => 'released')).toBe('released');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("generated URLs follow changed listen settings and explicit custom URLs are preserved", () => {
  expect(resolveConnectionUrl('http://old:3773', 'old', '3773', 'new', 3774, '')).toBe('http://new:3774');
  expect(resolveConnectionUrl('http://old:3773/.well-known/t3/environment', 'old', '3773', 'new', 3774, '/.well-known/t3/environment')).toBe('http://new:3774/.well-known/t3/environment');
  expect(resolveConnectionUrl('https://proxy.example', 'old', '3773', 'new', 3774, '')).toBe('https://proxy.example');
});

test("deferred native repair survives an ordinary setup and completes once idle", async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-repair-intent-'));
  const path = join(dir, 'pending.json');
  try {
    writePending(path, old, { nativeRepair: true });
    for (const idle of [false, true]) {
      const nativeRepair = needsNativeRepair(readPending(path, old), false);
      expect(nativeRepair).toBe(true);
      const c = fixture({
        write: async () => { writePending(path, old, { nativeRepair }); return { serverChanged: false, restartPending: true }; },
        idle: async () => idle,
        markPending: () => writePending(path, old, { nativeRepair }),
        repairExisting: async () => { writePending(path, old, { restartCompleted: true, applied: old }); },
      });
      expect(await configureService(c.operations)).toBe(idle ? 'repaired' : 'deferred');
    }
    expect(needsNativeRepair(readPending(path, old), false)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
