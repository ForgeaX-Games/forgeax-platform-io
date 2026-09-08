import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendJournalEntry,
  replayJournal,
  type JournalEntry,
} from '../src/version-control/journal';
import { compareAndSwapLatest, readLatestRef } from '../src/version-control/latest-ref';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('version-control recovery facts', () => {
  test('replays fsynced terminal journal entries and keeps request identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-journal-'));
    roots.push(root);
    const entry: JournalEntry = {
      schemaVersion: 1,
      requestId: 'request-1',
      operation: 'publish',
      payloadHash: 'payload-1',
      stage: 'tag-failed',
      repositoryIdentity: 'repo-1',
      beforeHead: null,
      result: { commitIdentity: 'abc' },
    };
    await appendJournalEntry(root, entry);
    const replay = await replayJournal(root);
    expect(replay).toEqual([entry]);
  });

  test('uses old-OID CAS for latest and reports conflicts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-latest-'));
    roots.push(root);
    expect(await compareAndSwapLatest(root, null, 'abc')).toMatchObject({ ok: true });
    expect(await compareAndSwapLatest(root, null, 'def')).toMatchObject({ ok: false });
    expect(await readLatestRef(root)).toBe('abc');
    expect(await compareAndSwapLatest(root, 'abc', null)).toMatchObject({ ok: true });
    expect(await readLatestRef(root)).toBe(null);
  });

  test('reads and updates the fallback latest marker when Git ref storage is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-latest-fallback-'));
    roots.push(root);
    mkdirSync(join(root, '.git', 'forgeax'), { recursive: true });
    writeFileSync(join(root, '.git', 'forgeax', 'latest-fallback'), 'fallback-tip\n');
    expect(await readLatestRef(root)).toBe('fallback-tip');
    expect(await compareAndSwapLatest(root, 'fallback-tip', 'next-tip')).toMatchObject({ ok: true, value: 'next-tip' });
    expect(await readLatestRef(root)).toBe('next-tip');
  });

  test('fails closed when both Git ref storage and the fallback marker are unusable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-latest-broken-'));
    roots.push(root);
    writeFileSync(join(root, '.git'), 'not a repository\n');
    expect(await compareAndSwapLatest(root, null, 'next-tip')).toMatchObject({ ok: false, code: 'latest-conflict', actual: null });
  });

  test('deletes a valid Git latest ref through the CAS path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-latest-git-ref-'));
    roots.push(root);
    execFileSync('git', ['init', '--quiet', root]);
    const oid = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'latest\n' }).toString().trim();
    expect(await compareAndSwapLatest(root, null, oid)).toMatchObject({ ok: true, value: oid });
    expect(await compareAndSwapLatest(root, oid, null)).toMatchObject({ ok: true, value: null });
    expect(await readLatestRef(root)).toBeNull();
  });

  test('reports a conflict when fallback deletion cannot remove its marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-latest-delete-conflict-'));
    roots.push(root);
    execFileSync('git', ['init', '--quiet', root]);
    const oid = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'latest\n' }).toString().trim();
    mkdirSync(join(root, '.git', 'forgeax'), { recursive: true });
    mkdirSync(join(root, '.git', 'forgeax', 'latest-fallback'));
    writeFileSync(join(root, '.git', 'forgeax', 'latest-fallback', 'keep'), 'keep\n');
    const wrapper = join(root, 'git-wrapper.sh');
    writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "--version" ] || [ "$7" = "--version" ]; then echo "git version 2.0"; exit 0; fi
if [ "$7" = "rev-parse" ]; then echo "${oid}"; exit 0; fi
exit 1
`);
    chmodSync(wrapper, 0o755);
    const config = mkdtempSync(join(tmpdir(), 'forgeax-git-config-'));
    roots.push(config);
    mkdirSync(join(config, 'editor'), { recursive: true });
    writeFileSync(join(config, 'editor', 'git.json'), `${JSON.stringify({ gitExecutablePath: wrapper })}\n`);
    const previousConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = config;
    try {
      expect(await compareAndSwapLatest(root, oid, null)).toMatchObject({ ok: false, code: 'latest-conflict', actual: oid });
    } finally {
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfig;
    }
  });
});
