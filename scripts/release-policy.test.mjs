import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { releaseIdentity, integrity, assertPublicText, validatePackage, existingMatches, newerTag, waitForPublished, readbackReceipt } from './release-policy.mjs';

const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'gordonzhy/pm-server', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_NUMBER: '123' };
const identity = releaseIdentity(env, '0.1.0-rc.16');
const meta = { name: 'pm-server', version: identity.version, releaseSource: identity.source, repository: { url: 'git+https://github.com/gordonzhy/pm-server.git' }, publishConfig: { tag: 'next', access: 'public' } };
test('release gate rejects PR, fork, branch, malformed identities', () => {
  for (const delta of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/topic' }, { GITHUB_REPOSITORY: 'example/fork' }, { GITHUB_SHA: 'invalid' }, { GITHUB_RUN_NUMBER: '0123' }]) assert.throws(() => releaseIdentity({ ...env, ...delta }, '0.1.0'));
});
test('versions are unique per run/source, stable across reruns without source commits', () => {
  assert.equal(identity.version, '0.1.0-ci.123.aaaaaaaaaaaa');
  assert.deepEqual(releaseIdentity({ ...env, GITHUB_RUN_ATTEMPT: '2' }, '0.1.0'), identity);
  assert.notEqual(releaseIdentity({ ...env, GITHUB_RUN_NUMBER: '124' }, '0.1.0').version, identity.version);
  assert.notEqual(releaseIdentity({ ...env, GITHUB_SHA: 'b'.repeat(40) }, '0.1.0').version, identity.version);
  assert.equal(newerTag('0.1.0-ci.124.bbbbbbbbbbbb', identity), true);
  assert.equal(newerTag('0.1.0-ci.122.bbbbbbbbbbbb', identity), false);
});
test('retry requires exact source and archive integrity', () => {
  const existing = { ...meta, dist: { integrity: integrity(Buffer.from('public package')) } };
  assert(existingMatches(existing, identity, existing.dist.integrity));
  assert(existingMatches({ ...existing, releaseSource: { run: identity.source.run, commit: identity.source.commit, repository: identity.source.repository } }, identity, existing.dist.integrity));
  assert.throws(() => existingMatches(existing, identity, 'sha512-different'));
  assert.throws(() => existingMatches({ ...existing, releaseSource: { ...identity.source, commit: 'b'.repeat(40) } }, identity, existing.dist.integrity));
  for (const source of [{ ...identity.source, extra: 'unexpected' }, { repository: identity.source.repository, commit: identity.source.commit }, { ...identity.source, run: 123 }]) assert.throws(() => existingMatches({ ...existing, releaseSource: source }, identity, existing.dist.integrity));
});
test('post-publication visibility polls only reads and has a finite missing-version budget', async () => {
  let reads = 0;
  const pauses = [];
  const visible = { version: identity.version };
  const result = await waitForPublished(async timeout => { assert(timeout > 0 && timeout <= 10000); return ++reads === 3 ? visible : null; }, async ms => pauses.push(ms));
  assert.equal(result, visible);
  assert.equal(reads, 3);
  assert.deepEqual(pauses, [10000, 10000]);
  reads = 0; pauses.length = 0;
  assert.equal(await waitForPublished(async () => { reads++; return null; }, async ms => pauses.push(ms)), null);
  assert.equal(reads, 36);
  assert.equal(pauses.length, 35);
  await assert.rejects(waitForPublished(async () => { throw new Error('lookup denied'); }, async () => assert.fail('Do not hide lookup errors')));
});
test('visibility budget obeys the absolute deadline with slow reads and a virtual clock', async () => {
  let time = 0, reads = 0;
  assert.equal(await waitForPublished(async timeout => { reads++; time += timeout; return null; }, async ms => { time += ms; }, () => time), null);
  assert.equal(time, 360000);
  assert.equal(reads, 18);
  time = 359999; reads = 0;
  const start = time;
  await waitForPublished(async timeout => { reads++; time += timeout; return null; }, async ms => { time += ms + 400000; }, () => time);
  assert.equal(reads, 1);
  assert(time - start > 360000); // An oversleep must never cause another request.
});
test('registry receipts expose only typed state and closed cache fields', () => {
  const body = { versions: { [identity.version]: meta }, 'dist-tags': { next: identity.version, latest: '0.1.0-rc.2' } };
  const expected = { version: identity.version, latest: '0.1.0-rc.2' };
  const receipt = readbackReceipt(200, new Headers({ 'cache-control': 'public, max-age=300', age: '283', 'cf-cache-status': 'HIT' }), body, expected, 25);
  assert.deepEqual(receipt, { status: 200, elapsedMs: 25, targetPresent: true, nextMatches: true, latestUnchanged: true, cacheMaxAgeSeconds: 300, cacheAgeSeconds: 283, cacheState: 'HIT' });
  const canary = 'PM_RELEASE_PRIVATE_CANARY';
  const hostile = readbackReceipt(canary, new Headers({ 'cache-control': canary, age: canary, 'cf-cache-status': canary, 'set-cookie': canary, authorization: canary }), { error: canary, 'dist-tags': { next: canary, latest: canary } }, expected, NaN);
  assert(!JSON.stringify(hostile).includes(canary));
  assert.equal(hostile.status, null);
  assert.equal(hostile.cacheMaxAgeSeconds, null);
  assert.equal(hostile.cacheState, null);
  assert.equal(hostile.targetPresent, false);
  assert.equal(hostile.nextMatches, false);
  assert.equal(hostile.latestUnchanged, false);
});
test('actual read boundary reports failed responses without echoing body or errors', async () => {
  const { registryGet } = await import('./release-next.mjs');
  const originalFetch = globalThis.fetch, originalLog = console.log;
  const logs = [], canary = 'PM_RELEASE_PRIVATE_CANARY';
  console.log = value => logs.push(value);
  try {
    for (const response of [new Response(JSON.stringify({ error: canary }), { status: 503 }), new Response(canary)]) {
      globalThis.fetch = async () => response;
      await assert.rejects(registryGet('https://registry.npmjs.org/pm-server?write=true', false, 1000, { version: identity.version }));
    }
    for (const error of [new Error(canary), Object.assign(new Error(canary), { name: 'TimeoutError' })]) {
      globalThis.fetch = async () => { throw error; };
      await assert.rejects(registryGet('https://registry.npmjs.org/pm-server?write=true', false, 1000, { version: identity.version }));
    }
    assert.equal(logs.length, 4);
    assert(!logs.join('').includes(canary));
    assert.equal(JSON.parse(logs[0]).registryRead.status, 503);
    assert.deepEqual(logs.slice(1).map(value => JSON.parse(value).registryRead.failure), ['invalid-json', 'network', 'timeout']);
  } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
});
test('metadata rejects lifecycle hooks, local origin, dependency changes and latest', () => {
  validatePackage(meta, identity);
  for (const extra of [{ scripts: { prepack: 'echo unsafe' } }, { _where: '/placeholder' }, { publishConfig: { tag: 'latest', access: 'public' } }, { dependencies: {} }, { releaseSource: {} }]) assert.throws(() => validatePackage({ ...meta, ...extra }, identity));
  assert.throws(() => assertPublicText('PM_RELEASE_PRIVATE_CANARY'));
});
test('workflow gates the single publishing job on the entire matrix and restricts OIDC', async () => {
  const workflow = await readFile(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');
  const [testing, publishing] = workflow.split('  publish-next:');
  assert.match(testing, /node: \[22, 24\]/);
  assert.doesNotMatch(testing, /id-token/);
  assert.match(publishing, /needs: test/);
  assert.match(publishing, /github.event_name == 'push'.*github.ref == 'refs\/heads\/main'/);
  assert.match(publishing, /id-token: write/);
  assert.match(publishing, /environment: npm-next/);
  assert.match(publishing, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|pull_request_target|workflow_run/);
  assert.doesNotMatch(publishing, /run: npm publish/);
});
test('real npm pack validates final bytes, deterministic rerun, and rejects an injected private canary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-fixture-'));
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'contracts'));
  await mkdir(path.join(root, 'bin'));
  for (const name of ['release-next.mjs', 'release-policy.mjs']) await cp(new URL(name, import.meta.url), path.join(root, 'scripts', name));
  const fixture = { ...meta, version: '0.1.0', files: ['LICENSE', 'contracts/', 'bin/'], scripts: {}, type: 'module', bin: { 'pm-server': 'bin/pm-server.mjs' } };
  delete fixture.releaseSource;
  await writeFile(path.join(root, 'package.json'), JSON.stringify(fixture));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'pm-server', version: '0.1.0', packages: { '': { name: 'pm-server', version: '0.1.0' } } }));
  await writeFile(path.join(root, 'LICENSE'), 'MIT synthetic release fixture');
  await writeFile(path.join(root, 'contracts/protocol.json'), '{}');
  await writeFile(path.join(root, 'bin/pm-server.mjs'), 'console.log("Synthetic CLI help");');
  await writeFile(path.join(root, 'scripts/release-package-files.json'), JSON.stringify(['LICENSE', 'bin/pm-server.mjs', 'contracts/protocol.json', 'package.json']));
  const run = () => JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/release-next.mjs'), 'prepare'], { env: { ...process.env, ...env, npm_config_cache: path.join(root, 'cache') }, encoding: 'utf8' }));
  const first = run();
  assert.equal(first.version, identity.version);
  assert.equal(run().integrity, first.integrity);
  const { publish } = await import(pathToFileURL(path.join(root, 'scripts/release-next.mjs')));
  const oidcEnv = { ...process.env, ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-test-value' };
  delete oidcEnv.NODE_AUTH_TOKEN; delete oidcEnv.NPM_TOKEN;
  let published = null, writes = 0, dryRuns = 0, visibilityMisses = 2, latest = '0.1.0-rc.2', next = '0.1.0-rc.16';
  const visibilityPauses = [];
  const registryReads = [];
  const io = {
    headIsCurrent: async () => true,
    get: async url => {
      registryReads.push(url);
      const uri = new URL(url);
      assert.equal(uri.pathname, '/pm-server');
      assert.equal(uri.searchParams.get('write'), 'true');
      const visible = published && visibilityMisses-- <= 0;
      return { name: 'pm-server', versions: visible ? { [identity.version]: published } : {}, 'dist-tags': { latest, next } };
    },
    pause: async ms => visibilityPauses.push(ms),
    npm: (args, options) => {
      if (args[0] === 'pack') return JSON.stringify([first]);
      if (args[0] === 'publish') {
        if (args.includes('--dry-run')) { dryRuns++; return ''; }
        writes++;
        published = { ...meta, releaseSource: { run: identity.source.run, commit: identity.source.commit, repository: identity.source.repository }, dist: { integrity: first.integrity, tarball: 'https://example.invalid/public.tgz' } };
        next = identity.version;
        return '';
      }
      return execFileSync('npm', args, { ...options, encoding: 'utf8', stdio: 'pipe' });
    },
    fetch: async () => new Response(await readFile(path.join(root, '.release', first.filename))),
  };
  assert.equal((await publish(oidcEnv, { ...io, headIsCurrent: async () => false })).status, 'superseded');
  assert.equal(writes, 0);
  next = '0.1.0-ci.124.bbbbbbbbbbbb';
  assert.equal((await publish(oidcEnv, io)).status, 'superseded');
  assert.equal(writes, 0);
  next = '0.1.0-rc.16';
  for (const invalid of [{ name: 'other', versions: {}, 'dist-tags': {} }, { name: 'pm-server', 'dist-tags': {} }, { name: 'pm-server', versions: {}, 'dist-tags': [] }, { name: 'pm-server', versions: { [identity.version]: null }, 'dist-tags': {} }]) await assert.rejects(publish(oidcEnv, { ...io, get: async () => invalid }));
  assert.equal(writes, 0);
  await assert.rejects(publish({ ...oidcEnv, NPM_TOKEN: 'synthetic' }, io));
  await assert.rejects(publish(oidcEnv, { ...io, npm: () => { throw new Error('simulated transport failure'); } }));
  assert.equal(writes, 0);
  const result = await publish(oidcEnv, io);
  assert.equal(result.status, 'published');
  assert.equal(result.latest, latest);
  assert.equal(result.installedFiles, 4);
  assert.equal(writes, 1);
  assert.equal(dryRuns, 1);
  assert.deepEqual(visibilityPauses, [10000, 10000]);
  assert.equal((await publish(oidcEnv, io)).status, 'already-published');
  assert.equal(writes, 1);
  assert.equal(dryRuns, 1);
  published.dist.integrity = 'sha512-mismatch';
  await assert.rejects(publish(oidcEnv, io));
  assert.equal(writes, 1);
  // A successful registry write with a lost CLI response must be confirmed by
  // reads, without another upload, even when visibility initially lags.
  published = null; next = '0.1.0-rc.16'; visibilityMisses = 1;
  const beforeAmbiguousWrite = writes;
  const ambiguous = await publish(oidcEnv, { ...io, npm: (args, options) => {
    const result = io.npm(args, options);
    if (args[0] === 'publish' && !args.includes('--dry-run')) throw new Error('simulated lost upload response');
    return result;
  } });
  assert.equal(ambiguous.status, 'published-confirmed-after-cli-error');
  assert.equal(writes, beforeAmbiguousWrite + 1);
  assert(registryReads.length > 0);
  await writeFile(path.join(root, 'contracts/protocol.json'), 'PM_RELEASE_PRIVATE_CANARY');
  assert.throws(run);
  await writeFile(path.join(root, 'contracts/protocol.json'), '{}');
  await writeFile(path.join(root, 'contracts/unreviewed.json'), '{}');
  assert.throws(run);
});
