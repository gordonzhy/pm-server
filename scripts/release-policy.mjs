import { createHash } from 'node:crypto';

export const registry = 'https://registry.npmjs.org';
export const repository = 'gordonzhy/pm-server';
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export function releaseIdentity(env, base) {
  assert(env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main', 'Only main push releases are allowed');
  assert(env.GITHUB_REPOSITORY === repository, 'Unexpected repository');
  assert(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || ''), 'Invalid source SHA');
  assert(/^[1-9][0-9]*$/.test(env.GITHUB_RUN_NUMBER || ''), 'Invalid run number');
  assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(base), 'Invalid base version');
  return {
    version: `${base.split('-')[0]}-ci.${env.GITHUB_RUN_NUMBER}.${env.GITHUB_SHA.slice(0, 12)}`,
    source: { repository, commit: env.GITHUB_SHA, run: env.GITHUB_RUN_NUMBER },
  };
}
export function integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}
export function assertPublicText(text) {
  // These are generic leak indicators, not an exhaustive privacy audit.
  assert(!/(?:\/Users\/|\/Volumes\/|C:\\Users\\|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|npm_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|PM_RELEASE_PRIVATE_CANARY)/i.test(text), 'Possible private data in release content');
}
export function validatePackage(meta, identity) {
  assert(meta.name === 'pm-server' && meta.version === identity.version, 'Package identity mismatch');
  assert(JSON.stringify(meta.releaseSource) === JSON.stringify(identity.source), 'Source identity mismatch');
  assert(meta.repository?.url === `git+https://github.com/${repository}.git`, 'Unexpected package repository');
  assert(meta.publishConfig?.tag === 'next' && meta.publishConfig?.access === 'public', 'Unsafe publish configuration');
  assert(!meta.dependencies && !meta.optionalDependencies, 'Release dependency policy requires review');
  assert(!['prepublishOnly', 'prepare', 'prepack', 'postpack', 'publish', 'postpublish', 'preinstall', 'install', 'postinstall'].some(k => meta.scripts?.[k]), 'Release lifecycle scripts require review');
  for (const key of Object.keys(meta)) assert(!key.startsWith('_') && !['gitHead', 'author', 'contributors', 'maintainers'].includes(key), 'Unexpected source metadata');
  assertPublicText(JSON.stringify(meta));
}
export function existingMatches(existing, identity, expectedIntegrity) {
  assert(existing.version === identity.version && existing.dist?.integrity === expectedIntegrity, 'Existing version differs from candidate');
  assert(JSON.stringify(existing.releaseSource) === JSON.stringify(identity.source), 'Existing version has a different source');
  return true;
}
export function newerTag(current, identity) {
  const match = /-ci\.([1-9][0-9]*)\./.exec(current || '');
  return Boolean(match && BigInt(match[1]) > BigInt(identity.source.run));
}
