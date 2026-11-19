// Dex merger & Companion Dex injector for native Android APK.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEntry, entryBytes } from './signing.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN_DIR = path.resolve(__dirname, '../bin');

const ROOT_DEX_REGEX = /^classes(\d*)\.dex$/;
const COMPANION_CLASS_MARKER = Buffer.from('Ldev/grokbot/nativeapp/');
const JNI_ARM64_DIR = path.join(BIN_DIR, 'jniLibs', 'arm64-v8a');
const TAILCAT_LIB_NAMES = ['libgroktailcat.so', 'libgroktailcatjni.so'];

/**
 * Checks whether a DEX buffer contains a given JNI/type descriptor (e.g. "Lai/x/grok/bot/MainApplication;").
 */
export function dexContainsClass(dexBuffer, descriptor) {
  if (!Buffer.isBuffer(dexBuffer) || dexBuffer.length < 112 || !descriptor) {
    return false;
  }
  const magic = dexBuffer.subarray(0, 4).toString('ascii');
  if (magic !== 'dex\n') return false;
  return dexBuffer.includes(Buffer.from(descriptor, 'utf8'));
}

/**
 * Checks across all root classes*.dex APK entries whether a descriptor exists.
 */
export function dexEntriesContainClass(entries, descriptor) {
  if (!Array.isArray(entries) || !descriptor) return false;
  for (const entry of entries) {
    if (!ROOT_DEX_REGEX.test(entry.name)) continue;
    const buf = entryBytes(entry);
    if (dexContainsClass(buf, descriptor)) return true;
  }
  return false;
}

/**
 * Strictly parses a root-level DEX entry name and returns its 1-based index.
 * Only matches top-level entries strictly adhering to `classes.dex` (1) or `classes<N>.dex` (N >= 2).
 * Returns null if the entry is nested in a directory or does not match the naming standard.
 */
export function parseRootDexIndex(name) {
  if (!name || typeof name !== 'string') return null;
  // Ensure strict root APK entry: cannot contain directory separators ('/' or '\')
  if (name.includes('/') || name.includes('\\')) return null;

  const match = ROOT_DEX_REGEX.exec(name);
  if (!match) return null;

  const idxStr = match[1];
  if (idxStr === '') {
    return 1; // classes.dex is index 1
  }
  const idx = parseInt(idxStr, 10);
  // Canonical Android ART secondary dexes: classes2.dex, classes3.dex...
  // Reject leading zeros (e.g. classes02.dex) or invalid numbers (e.g. classes0.dex, classes1.dex)
  if (String(idx) === idxStr && idx >= 2) {
    return idx;
  }
  return null;
}

/**
 * Determines the next sequential DEX filename ensuring ART sequential continuity and gap filling.
 * - Enforces strict root-level scoping (ignores nested entries like assets/classes5.dex).
 * - Enforces primary classes.dex presence if any secondary dexes exist.
 * - Fills the lowest missing index in the sequence {1, 2, 3, ...} to avoid breaking ART DexPathList.
 */
export function getNextDexName(existingEntryNames) {
  const existingIndices = new Set();
  let hasSecondary = false;

  for (const item of existingEntryNames) {
    const name = typeof item === 'string' ? item : item?.name;
    const idx = parseRootDexIndex(name);
    if (idx !== null) {
      existingIndices.add(idx);
      if (idx >= 2) {
        hasSecondary = true;
      }
    }
  }

  // Check for primary dex absence when secondary dex files exist
  if (hasSecondary && !existingIndices.has(1)) {
    throw new Error('Primary dex (classes.dex) is missing while secondary dex files exist');
  }

  // If no root dex files exist at all (e.g. empty list), default to primary classes.dex
  if (existingIndices.size === 0) {
    return 'classes.dex';
  }

  // Find lowest missing sequential index starting from 1 (gap-filling)
  let nextIdx = 1;
  while (existingIndices.has(nextIdx)) {
    nextIdx++;
  }

  return nextIdx === 1 ? 'classes.dex' : `classes${nextIdx}.dex`;
}

/**
 * Safely extracts uncompressed buffer from a ZIP entry.
 */
function getEntryBuffer(entry) {
  if (!entry) return null;
  if (Buffer.isBuffer(entry.data) && entry.method === undefined) {
    return entry.data;
  }
  try {
    return entryBytes(entry);
  } catch {
    return null;
  }
}

/**
 * Detects whether a DEX buffer is an already-injected companion dex.
 * Matches by exact SHA-256 hash or presence of companion package class descriptors.
 */
export function isCompanionDex(buffer, expectedSha256 = null) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  if (expectedSha256) {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (hash === expectedSha256) return true;
  }
  return buffer.includes(COMPANION_CLASS_MARKER);
}

/**
 * Injects companion dex buffer into entry list.
 * - Validates DEX magic header.
 * - Validates primary classes.dex presence in the APK.
 * - Deduplicates: if a companion dex already exists, replaces it in-place and prunes duplicates.
 * - Sequential: if fresh, allocates the next sequential index filling any gaps.
 */
export function injectCompanionDex(entries, companionDexBuffer) {
  if (!companionDexBuffer || !Buffer.isBuffer(companionDexBuffer) || companionDexBuffer.length < 8) {
    throw new Error('Invalid companion dex buffer');
  }

  // Verify DEX magic ('dex\n035\0' or 'dex\n037\0' or 'dex\n038\0' or 'dex\n039\0')
  const magic = companionDexBuffer.subarray(0, 4).toString('latin1');
  if (magic !== 'dex\n') {
    throw new Error(`Invalid DEX magic header: ${JSON.stringify(magic)}`);
  }

  // Ensure primary classes.dex is present in APK entries
  const hasPrimary = entries.some(e => e.name === 'classes.dex');
  if (!hasPrimary) {
    throw new Error('Cannot inject companion dex: primary classes.dex is missing from APK entries');
  }

  const targetSha256 = crypto.createHash('sha256').update(companionDexBuffer).digest('hex');

  // Check if any existing secondary dex entry is already a companion dex
  const existingCompanionEntries = [];
  for (const entry of entries) {
    const idx = parseRootDexIndex(entry.name);
    if (idx !== null && idx >= 2) {
      const buf = getEntryBuffer(entry);
      if (buf && isCompanionDex(buf, targetSha256)) {
        existingCompanionEntries.push(entry);
      }
    }
  }

  let targetName;
  let filteredEntries;

  if (existingCompanionEntries.length > 0) {
    // Companion dex already present: reuse the first existing slot (in-place update)
    targetName = existingCompanionEntries[0].name;
    // Remove all previous companion dex entries to prune any accumulated duplicates
    const companionSet = new Set(existingCompanionEntries);
    filteredEntries = entries.filter(e => !companionSet.has(e));
  } else {
    // Fresh injection: determine next available sequential slot (with gap filling)
    const existingNames = entries.map(e => e.name);
    targetName = getNextDexName(existingNames);
    filteredEntries = entries.filter(e => e.name !== targetName);
  }

  const dexEntry = createEntry(targetName, companionDexBuffer, { store: false });
  filteredEntries.push(dexEntry);

  return {
    entries: filteredEntries,
    injectedName: targetName,
    size: companionDexBuffer.length
  };
}

/**
 * Loads default precompiled companion dex from bin/classes2.dex
 */
export function loadDefaultCompanionDex() {
  const defaultPath = path.join(BIN_DIR, 'classes2.dex');
  if (!fs.existsSync(defaultPath)) {
    throw new Error(`Default companion dex not found at ${defaultPath}. Run companion/build.sh first.`);
  }
  return fs.readFileSync(defaultPath);
}

/**
 * Loads precompiled arm64-v8a Tailcat native JNI libraries from bin/jniLibs/arm64-v8a/
 */
export function loadDefaultTailcatLibs() {
  return TAILCAT_LIB_NAMES.map(fileName => {
    const fullPath = path.join(JNI_ARM64_DIR, fileName);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Tailcat JNI library not found at ${fullPath}`);
    }
    return {
      zipPath: `lib/arm64-v8a/${fileName}`,
      buffer: fs.readFileSync(fullPath),
    };
  });
}

/**
 * Injects Tailcat native JNI libraries uncompressed ({ store: true }) into lib/arm64-v8a/
 * so writeZip() enforces 16KB (16384-byte) page alignment for Android 15/16 compatibility.
 */
export function injectTailcatLibs(entries, libs = loadDefaultTailcatLibs()) {
  const targetPaths = new Set(libs.map(l => l.zipPath));
  const filtered = entries.filter(e => !targetPaths.has(e.name));
  const injected = [];
  for (const lib of libs) {
    filtered.push(createEntry(lib.zipPath, lib.buffer, { store: true }));
    injected.push(lib.zipPath);
  }
  return { entries: filtered, injected };
}

export { neutralizePairipAndHookOkHttp } from './pairip-dex.mjs';

