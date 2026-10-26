import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assert, assertPublicText, registry, repository, releaseIdentity, integrity, validatePackage, existingMatches, newerTag, sameSource, waitForPublished } from './release-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = (args, options = {}) => execFileSync('npm', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function get(url, allowMissing = false, timeoutMs = 30000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'pm-server-release', 'Cache-Control': 'no-cache' } });
  if (allowMissing && response.status === 404) return null;
  assert(response.ok, `Release lookup failed (${response.status})`);
  return response.json();
}
async function headIsCurrent(identity) {
  const head = await get(`https://api.github.com/repos/${repository}/git/ref/heads/main`);
  return head.object?.sha === identity.source.commit;
}
async function filesUnder(rootDir, relative = '') {
  const files = [];
  for (const item of await readdir(path.join(rootDir, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, item.name);
    assert(!item.isSymbolicLink(), 'Package links are forbidden');
    if (item.isDirectory()) files.push(...await filesUnder(rootDir, name));
    else { assert(item.isFile(), 'Unexpected package entry'); files.push(name); }
  }
  return files.sort();
}
export async function prepare(env = process.env) {
  const meta = await json(path.join(root, 'package.json'));
  const identity = releaseIdentity(env, meta.version);
  const lock = await json(path.join(root, 'package-lock.json'));
  meta.version = lock.version = lock.packages[''].version = identity.version;
  meta.releaseSource = identity.source;
  validatePackage(meta, identity);
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(meta, null, 2)}\n`);
  await writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  const out = path.join(root, '.release');
  await mkdir(out, { recursive: true });
  const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', out]));
  const allowed = await json(path.join(root, 'scripts/release-package-files.json'));
  assert(JSON.stringify(packed.files.map(f => f.path).sort()) === JSON.stringify(allowed), 'Package file list differs from reviewed allowlist');
  assert(allowed.includes('LICENSE') && allowed.includes('contracts/protocol.json'), 'Required package files missing');
  const archive = path.join(out, packed.filename);
  const bytes = await readFile(archive);
  assert(integrity(bytes) === packed.integrity, 'Pack integrity mismatch');
  const extracted = await mkdtemp(path.join(os.tmpdir(), 'pm-release-audit-'));
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  const actual = await filesUnder(path.join(extracted, 'package'));
  assert(JSON.stringify(actual) === JSON.stringify(allowed), 'Actual archive list mismatch');
  for (const name of actual) {
    const content = await readFile(path.join(extracted, 'package', name));
    assertPublicText(content.toString('utf8'));
    // Packed bytes must equal the reviewed checkout, including image metadata.
    assert(content.equals(await readFile(path.join(root, name))), 'Archive/source mismatch');
  }
  validatePackage(await json(path.join(extracted, 'package/package.json')), identity);
  const result = { ...identity, filename: packed.filename, integrity: packed.integrity, files: actual };
  await writeFile(path.join(out, 'candidate.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
const defaultIO = { get, npm, headIsCurrent, fetch: globalThis.fetch };
export async function publish(env = process.env, io = defaultIO) {
  const { get, npm, headIsCurrent, fetch } = io;
  const candidate = await json(path.join(root, '.release/candidate.json'));
  const identity = releaseIdentity(env, (await json(path.join(root, 'package.json'))).version);
  assert(candidate.version === identity.version && sameSource(candidate.source, identity.source), 'Candidate/environment mismatch');
  const archive = path.join(root, '.release', candidate.filename);
  assert(integrity(await readFile(archive)) === candidate.integrity, 'Candidate archive changed');
  if (!await headIsCurrent(identity)) return { status: 'superseded', version: identity.version };
  const tags = await get(`${registry}/-/package/pm-server/dist-tags`);
  if (newerTag(tags.next, identity)) return { status: 'superseded', version: identity.version };
  const existing = await get(`${registry}/pm-server/${identity.version}`, true);
  let failed = false;
  if (existing) existingMatches(existing, identity, candidate.integrity);
  else {
    // This must be a GitHub-hosted OIDC job; never substitute a stored npm token.
    assert(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'OIDC job required');
    assert(!env.NODE_AUTH_TOKEN && !env.NPM_TOKEN, 'Stored npm tokens are not allowed');
    // Directory publishing avoids pacote's absolute _from/_resolved tarball fields.
    // Repack immediately before publish and require the reviewed archive bytes.
    const [repacked] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', path.dirname(archive)]));
    assert(repacked.integrity === candidate.integrity && integrity(await readFile(archive)) === candidate.integrity, 'Prepublish repack differs from candidate');
    // npm dry-run also rejects an existing version, so run it only on a new release.
    npm(['publish', '.', '--dry-run', '--ignore-scripts', '--tag', 'next', '--access', 'public', '--registry', registry]);
    assert(await headIsCurrent(identity), 'Source superseded before publish');
    try {
      // Do not echo npm output: it can contain authentication diagnostics.
      npm(['publish', '.', '--ignore-scripts', '--provenance', '--access', 'public', '--tag', 'next', '--registry', registry]);
    } catch { failed = true; }
  }
  const published = existing || await waitForPublished(timeout => get(`${registry}/pm-server/${identity.version}`, true, timeout), io.pause);
  assert(published, failed ? 'Publish failed or outcome unknown; inspect registry before rerun' : 'Published version not yet visible; inspect registry before rerun');
  existingMatches(published, identity, candidate.integrity);
  const after = await get(`${registry}/-/package/pm-server/dist-tags`);
  assert(after.latest === tags.latest, 'Latest changed during publication; investigate');
  assert(existing || after.next === identity.version || newerTag(after.next, identity), 'Unexpected next tag');
  const download = await fetch(published.dist.tarball, { signal: AbortSignal.timeout(30000) });
  assert(download.ok, 'Anonymous registry download failed');
  const publicBytes = Buffer.from(await download.arrayBuffer());
  assert(integrity(publicBytes) === candidate.integrity, 'Anonymous registry archive differs');
  const isolated = await mkdtemp(path.join(os.tmpdir(), 'pm-release-install-'));
  const downloaded = path.join(isolated, 'public.tgz');
  await writeFile(downloaded, publicBytes);
  const installEnv = { ...env, HOME: isolated, npm_config_cache: path.join(isolated, 'cache'), npm_config_userconfig: path.join(isolated, 'empty-npmrc') };
  // Normal lifecycle install, without service setup or global installation.
  npm(['install', '--prefix', path.join(isolated, 'prefix'), '--no-audit', '--no-fund', downloaded], { env: installEnv });
  const installed = path.join(isolated, 'prefix/node_modules/pm-server');
  assert(JSON.stringify(await filesUnder(installed)) === JSON.stringify(candidate.files), 'Installed package file list differs');
  for (const name of candidate.files) assert((await readFile(path.join(installed, name))).equals(await readFile(path.join(root, name))), 'Registry installation bytes differ');
  execFileSync(process.execPath, [path.join(installed, 'bin/pm-server.mjs'), '--help'], { env: installEnv, stdio: 'pipe' });
  return { status: existing ? 'already-published' : failed ? 'published-confirmed-after-cli-error' : 'published', version: identity.version, integrity: candidate.integrity, next: after.next, latest: after.latest, installedFiles: candidate.files.length };
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    assert(['prepare', 'publish'].includes(mode), 'Expected prepare or publish');
    const result = mode === 'prepare' ? await prepare() : await publish();
    console.log(JSON.stringify(result, null, 2));
    if (mode === 'publish') await writeFile(path.join(root, '.release/result.json'), `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    // Errors below never include subprocess output or authentication values.
    console.error(error.message?.startsWith('Command failed:') ? 'Release subprocess failed; inspect the isolated environment' : error.message);
    process.exitCode = 1;
  }
}
