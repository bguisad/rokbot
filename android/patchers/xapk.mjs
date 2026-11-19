// XAPK / APKS split-APK unpacker & universal APK merger (no external CLI tools required).
import { mergeResourcesArsc } from './arsc.mjs';
import { createEntry, entryBytes, readZip } from './signing.mjs';

const UNSUPPORTED_ABI_SPLIT_RE = /(?:^|[_./-])(armeabi_v7a|armeabi|x86_64|x86)(?:\.apk)?$/i;
const ARM64_LIB_ENTRY_RE = /^lib\/arm64-v8a\/[^/]+\.so$/;

/**
 * Normalizes an input `.apk`, `.xapk`, or `.apks` buffer into a single universal APK entry array.
 * - If root `AndroidManifest.xml` exists, treats it as an APK and strips `libpairipcore.so`.
 * - If `manifest.json` / nested `*.apk` exist, selects the base APK + `arm64_v8a` + density/locale splits,
 *   merges native libs (excluding `libpairipcore.so`), `res/` assets, and `resources.arsc`.
 */
export function normalizeApkOrXapk(inputBuffer, { abi = 'arm64-v8a' } = {}) {
  const outerZip = readZip(inputBuffer);
  const hasRootManifest = outerZip.entries.some(e => e.name === 'AndroidManifest.xml');

  if (hasRootManifest) {
    const filtered = outerZip.entries.filter(e => !/(^|\/)libpairipcore\.so$/i.test(e.name));
    return {
      isSplitArchive: false,
      entries: filtered,
      mergedSplits: [],
    };
  }

  const nestedApks = outerZip.entries.filter(e => /\.apk$/i.test(e.name) && !e.name.includes('..'));
  if (nestedApks.length === 0) {
    throw new Error('Input APK does not contain AndroidManifest.xml');
  }

  let manifestMeta = null;
  const xapkManifestEntry = outerZip.entries.find(e => e.name === 'manifest.json');
  if (xapkManifestEntry) {
    try {
      manifestMeta = JSON.parse(entryBytes(xapkManifestEntry).toString('utf8'));
    } catch {
      manifestMeta = null;
    }
  }

  const baseCandidates = nestedApks.filter(e => {
    const bn = e.name.split('/').pop().toLowerCase();
    return bn === 'base.apk' || (manifestMeta?.package_name && bn === `${manifestMeta.package_name.toLowerCase()}.apk`);
  });

  let baseEntry = baseCandidates[0] || null;
  if (!baseEntry) {
    // Fallback: pick first nested APK containing assets/index.android.bundle or non-config name
    for (const candidate of nestedApks) {
      const bn = candidate.name.split('/').pop().toLowerCase();
      if (bn.startsWith('config.') || bn.startsWith('split_config.')) continue;
      baseEntry = candidate;
      break;
    }
  }
  if (!baseEntry) {
    throw new Error('Split archive does not contain a base APK with AndroidManifest.xml');
  }

  const baseZip = readZip(entryBytes(baseEntry));
  if (!baseZip.entries.some(e => e.name === 'AndroidManifest.xml')) {
    throw new Error(`Base split ${baseEntry.name} does not contain AndroidManifest.xml`);
  }

  const entryMap = new Map();
  for (const e of baseZip.entries) {
    if (/(^|\/)libpairipcore\.so$/i.test(e.name)) continue;
    entryMap.set(e.name, e);
  }

  const splitArscBuffers = [];
  const mergedSplits = [];

  for (const splitEntry of nestedApks) {
    if (splitEntry === baseEntry) continue;
    const bn = splitEntry.name.split('/').pop();
    if (UNSUPPORTED_ABI_SPLIT_RE.test(bn) && !/arm64/i.test(bn)) {
      continue;
    }
    const splitBytes = entryBytes(splitEntry);
    const splitZip = readZip(splitBytes);
    mergedSplits.push(bn);

    for (const se of splitZip.entries) {
      if (/(^|\/)libpairipcore\.so$/i.test(se.name)) continue;
      if (se.name === 'AndroidManifest.xml' || se.name === 'stamp-cert-sha256' || se.name.startsWith('META-INF/')) {
        continue;
      }
      if (se.name === 'resources.arsc') {
        splitArscBuffers.push(entryBytes(se));
        continue;
      }
      if (se.name.startsWith('lib/')) {
        if (abi === 'arm64-v8a' && ARM64_LIB_ENTRY_RE.test(se.name)) {
          // Ensure native libs are stored uncompressed for 16KB ZIP page alignment
          entryMap.set(se.name, createEntry(se.name, entryBytes(se), { store: true }));
        }
        continue;
      }
      if (!entryMap.has(se.name)) {
        entryMap.set(se.name, se);
      }
    }
  }

  if (splitArscBuffers.length > 0 && entryMap.has('resources.arsc')) {
    const baseArsc = entryBytes(entryMap.get('resources.arsc'));
    const mergedArsc = mergeResourcesArsc(baseArsc, splitArscBuffers);
    entryMap.set('resources.arsc', createEntry('resources.arsc', mergedArsc, { store: true }));
  }

  return {
    isSplitArchive: true,
    entries: Array.from(entryMap.values()),
    mergedSplits,
  };
}
