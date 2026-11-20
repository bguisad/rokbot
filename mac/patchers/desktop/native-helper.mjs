import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Grok Bot 1.2.3 universal helper: Swift Array<String> backing the stdio
// peer policy, one entry in each architecture. The UID/signature checks stay intact.
export const HELPER_DIGEST = '2fc251e6eed8979a34c3ac3a189cce4c9dac6f02bf89a268906148ff3673da03';
export const TEAM_OFFSETS = [0x256f68, 0x6bdb18];
export async function patchNativeHelperTeam(
  filename,
  teamId,
  { expectedDigest = HELPER_DIGEST, offsets = TEAM_OFFSETS } = {},
) {
  if (typeof teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('Computer helper requires a certificate Team ID');
  const bytes = await readFile(filename);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) throw new Error('Unsupported computer helper binary');
  for (const offset of offsets) {
    if (bytes.subarray(offset, offset + 10).toString() !== 'DCNK4UB866' || bytes[offset + 15] !== 0xea)
      throw new Error('Computer helper peer policy fingerprint mismatch');
    bytes.write(teamId, offset, 'ascii');
  }
  await writeFile(filename, bytes);
  return { trustedTeam: teamId, architectures: ['x86_64', 'arm64'], sameUserRequired: true, signatureRequired: true };
}
