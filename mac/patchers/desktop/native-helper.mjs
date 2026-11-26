import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Grok Bot universal helper: Swift Array<String> backing the stdio
// peer policy, one entry in each architecture. The UID/signature checks stay intact.
export const HELPER_PROFILES = Object.freeze([
  Object.freeze({
    version: '1.3.0',
    digest: '62d2486a2ac6fd75a563ddc6cee9b1593a57ced8b05e83c4ca77d646c43c6fcb',
    offsets: Object.freeze([0x257f68, 0x6c1b18]),
  }),
  Object.freeze({
    version: '1.2.3',
    digest: '2fc251e6eed8979a34c3ac3a189cce4c9dac6f02bf89a268906148ff3673da03',
    offsets: Object.freeze([0x256f68, 0x6bdb18]),
  }),
]);
export const HELPER_DIGEST = HELPER_PROFILES[0].digest;
export const TEAM_OFFSETS = HELPER_PROFILES[0].offsets;

export async function patchNativeHelperTeam(
  filename,
  teamId,
  { expectedDigest, offsets } = {},
) {
  if (typeof teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('Computer helper requires a certificate Team ID');
  const bytes = await readFile(filename);
  const digest = createHash('sha256').update(bytes).digest('hex');
  let targetOffsets = offsets;
  if (expectedDigest !== undefined) {
    if (digest !== expectedDigest) throw new Error('Unsupported computer helper binary');
    targetOffsets = offsets ?? TEAM_OFFSETS;
  } else {
    const profile = HELPER_PROFILES.find(item => item.digest === digest);
    if (!profile) throw new Error('Unsupported computer helper binary');
    targetOffsets = offsets ?? profile.offsets;
  }
  for (const offset of targetOffsets) {
    if (bytes.subarray(offset, offset + 10).toString() !== 'DCNK4UB866' || bytes[offset + 15] !== 0xea)
      throw new Error('Computer helper peer policy fingerprint mismatch');
    bytes.write(teamId, offset, 'ascii');
  }
  await writeFile(filename, bytes);
  return { trustedTeam: teamId, architectures: ['x86_64', 'arm64'], sameUserRequired: true, signatureRequired: true };
}
