// Android Release Signing Pin & Guard for RokBot.
// Prevents release builds from silently generating or using the wrong signing certificate.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSigningIdentity, verifyApk } from '../patchers/signing.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SIGNING_PIN_PATH = path.join(__dirname, 'signing-pin.json');
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const TRUTHY_ENV_RE = /^(?:1|true|yes|on)$/i;

export function normalizeCertificateSha256(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/:/g, '')
    .toLowerCase();
  if (!SHA256_HEX_RE.test(normalized)) {
    throw new Error(`Invalid certificate SHA-256 fingerprint: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function formatCertificateSha256Colons(hex) {
  const normalized = normalizeCertificateSha256(hex);
  return normalized.match(/../g).join(':').toUpperCase();
}

export function computeCertificateSha256(certDerBuffer) {
  if (!Buffer.isBuffer(certDerBuffer) && !(certDerBuffer instanceof Uint8Array)) {
    throw new Error('Certificate DER must be a Buffer or Uint8Array');
  }
  return crypto.createHash('sha256').update(certDerBuffer).digest('hex').toLowerCase();
}

export function loadSigningPin(pinPath = SIGNING_PIN_PATH) {
  if (!fs.existsSync(pinPath)) {
    throw new Error(`Android signing pin file not found at ${pinPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  const releaseCertificateSha256 = normalizeCertificateSha256(raw.releaseCertificateSha256);
  return {
    schema: raw.schema || 'rokbot-android-signing-pin/v1',
    releaseCertificateSha256,
    defaultKeystorePath: raw.defaultKeystorePath || '~/.rokbot-local/android-signing.json',
    recoveryHint: raw.recoveryHint ||
      'Copy ~/.rokbot-local/android-signing.json from mini to this machine (or pass --keystore <path> pointing to the official release keystore).',
  };
}

export const SIGNING_PIN = loadSigningPin();
export const RELEASE_CERTIFICATE_SHA256 = SIGNING_PIN.releaseCertificateSha256;

export function getDefaultKeystorePath(env = process.env) {
  const home = env?.HOME || env?.USERPROFILE || os.homedir();
  return path.join(home, '.rokbot-local', 'android-signing.json');
}

export function isDevSigningEnabled(options = {}, env = process.env) {
  if (options?.devSigning === true) return true;
  if (options?.devSigning === false) return false;
  const rawEnv = env?.ROKBOT_ANDROID_DEV_SIGNING;
  return typeof rawEnv === 'string' && TRUTHY_ENV_RE.test(rawEnv.trim());
}

export function formatSigningGuardError({
  reason,
  expectedSha256,
  actualSha256,
  keystorePath,
  allowDevHint = true,
}) {
  const lines = [
    reason,
    `  Expected certificate SHA-256 : ${expectedSha256}`,
    `  Actual certificate SHA-256   : ${actualSha256}`,
    `  Keystore path                : ${keystorePath}`,
    `  How to fix                   : Copy ~/.rokbot-local/android-signing.json from mini to ${keystorePath} (or pass --keystore <path> pointing to the official release keystore).`,
  ];
  if (allowDevHint) {
    lines.push(
      `  Dev / test builds only       : Pass --dev-signing or set ROKBOT_ANDROID_DEV_SIGNING=1 to explicitly allow a temporary / non-release signing key.`
    );
  }
  return lines.join('\n');
}

export function formatDevSigningWarning({ certificateSha256, expectedSha256, keystorePath, ephemeral }) {
  const source = ephemeral
    ? 'ephemeral in-memory key (not persisted)'
    : `non-release keystore (${keystorePath})`;
  return [
    '========================================================================',
    'WARNING: ANDROID DEV SIGNING MODE ENABLED (--dev-signing / ROKBOT_ANDROID_DEV_SIGNING=1)',
    `  Signing key source           : ${source}`,
    `  Actual certificate SHA-256   : ${certificateSha256}`,
    `  Official release pin SHA-256 : ${expectedSha256}`,
    '  DO NOT ship or publish this APK as an official release; existing',
    '  installed clients will reject in-place upgrades due to signature mismatch.',
    '========================================================================',
  ].join('\n');
}

function parseKeystoreRecord(targetPath, { requireSchemas = null } = {}) {
  const raw = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  if (requireSchemas && !requireSchemas.includes(raw.schema)) {
    throw new Error(`Invalid Android signing key schema: ${targetPath}`);
  }
  const pem = raw.privateKey || raw.privateKeyPem;
  const certB64 = raw.certificate || raw.certificateDerBase64;
  if (!pem || !certB64) {
    throw new Error(`Unsupported keystore format at ${targetPath} (expected JSON signing identity)`);
  }
  const certificate = Buffer.from(certB64, 'base64');
  // Validate X.509 certificate structure early so corrupt certificates fail cleanly.
  const x509 = new crypto.X509Certificate(certificate);
  const certificateSha256 = computeCertificateSha256(x509.raw);
  return {
    identity: {
      privateKey: crypto.createPrivateKey(pem),
      certificate: Buffer.from(x509.raw),
      type: raw.type || 'rsa',
    },
    certificateSha256,
    schema: raw.schema || null,
  };
}

/**
 * Loads an Android signing identity with release certificate pin enforcement.
 *
 * - Release mode (default):
 *   - Fails closed if the keystore file does not exist (NEVER auto-generates).
 *   - Fails closed if the certificate SHA-256 does not match the pinned release fingerprint.
 * - Dev mode (explicit --dev-signing or ROKBOT_ANDROID_DEV_SIGNING=1):
 *   - If no explicit keystorePath is provided, generates an ephemeral in-memory key without
 *     reading or modifying ~/.rokbot-local/android-signing.json.
 *   - If an explicit keystorePath is provided:
 *     - Loads it (allowing non-release fingerprints), OR
 *     - If missing and allowAutoCreate=true (and NOT the default release keystore path),
 *       creates a dev signing identity at that explicit path.
 *   - Prints a prominent warning banner.
 */
export function resolveReleaseSigningIdentity({
  keystorePath = null,
  devSigning = undefined,
  expectedCertificateSha256 = RELEASE_CERTIFICATE_SHA256,
  allowAutoCreate = true,
  requireSchemas = null,
  repoAndroidDir = null,
  env = process.env,
  warn = msg => console.warn(msg),
} = {}) {
  const expectedSha256 = normalizeCertificateSha256(expectedCertificateSha256);
  const devMode = isDevSigningEnabled({ devSigning }, env);
  const defaultPath = path.resolve(getDefaultKeystorePath(env));
  const explicitPath = keystorePath ? path.resolve(keystorePath) : null;
  const targetPath = explicitPath || defaultPath;

  if (repoAndroidDir) {
    const resolvedRepoAndroid = path.resolve(repoAndroidDir);
    if (targetPath === resolvedRepoAndroid || targetPath.startsWith(resolvedRepoAndroid + path.sep)) {
      throw new Error(`Security violation: refusing to read or write keystore inside ${resolvedRepoAndroid}`);
    }
  }

  if (!devMode) {
    if (!fs.existsSync(targetPath)) {
      throw new Error(formatSigningGuardError({
        reason: 'Refusing to sign Android release APK: signing keystore file does not exist (auto-generation is disabled in release mode).',
        expectedSha256,
        actualSha256: '(missing - keystore file does not exist)',
        keystorePath: targetPath,
      }));
    }

    const parsed = parseKeystoreRecord(targetPath, { requireSchemas });
    if (parsed.certificateSha256 !== expectedSha256) {
      throw new Error(formatSigningGuardError({
        reason: 'Refusing to sign Android release APK: signing certificate SHA-256 does not match the pinned release certificate.',
        expectedSha256,
        actualSha256: parsed.certificateSha256,
        keystorePath: targetPath,
      }));
    }

    return {
      identity: parsed.identity,
      keystorePath: targetPath,
      certificateSha256: parsed.certificateSha256,
      expectedCertificateSha256: expectedSha256,
      devSigning: false,
      ephemeral: false,
      matchesReleasePin: true,
    };
  }

  // Dev signing mode (explicitly opted in)
  if (!explicitPath) {
    const identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 });
    const certificateSha256 = computeCertificateSha256(identity.certificate);
    warn(formatDevSigningWarning({
      certificateSha256,
      expectedSha256,
      keystorePath: null,
      ephemeral: true,
    }));
    return {
      identity,
      keystorePath: null,
      certificateSha256,
      expectedCertificateSha256: expectedSha256,
      devSigning: true,
      ephemeral: true,
      matchesReleasePin: certificateSha256 === expectedSha256,
    };
  }

  if (fs.existsSync(explicitPath)) {
    const parsed = parseKeystoreRecord(explicitPath, { requireSchemas });
    warn(formatDevSigningWarning({
      certificateSha256: parsed.certificateSha256,
      expectedSha256,
      keystorePath: explicitPath,
      ephemeral: false,
    }));
    return {
      identity: parsed.identity,
      keystorePath: explicitPath,
      certificateSha256: parsed.certificateSha256,
      expectedCertificateSha256: expectedSha256,
      devSigning: true,
      ephemeral: false,
      matchesReleasePin: parsed.certificateSha256 === expectedSha256,
    };
  }

  if (!allowAutoCreate) {
    throw new Error(formatSigningGuardError({
      reason: 'Android signing keystore file does not exist.',
      expectedSha256,
      actualSha256: '(missing - keystore file does not exist)',
      keystorePath: explicitPath,
      allowDevHint: false,
    }));
  }

  if (explicitPath === defaultPath) {
    throw new Error(
      `Refusing to auto-generate a dev signing key at the default release keystore path (${defaultPath}). ` +
      'Omit --keystore with --dev-signing for an ephemeral in-memory dev key, or pass a separate temporary --keystore path.'
    );
  }

  const identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 });
  const certificateSha256 = computeCertificateSha256(identity.certificate);
  const payload = {
    schema: 'rokbot-android-signing/v1',
    createdAt: new Date().toISOString(),
    privateKey: identity.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    certificate: identity.certificate.toString('base64'),
  };

  fs.mkdirSync(path.dirname(explicitPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${explicitPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, explicitPath);

  warn(formatDevSigningWarning({
    certificateSha256,
    expectedSha256,
    keystorePath: explicitPath,
    ephemeral: false,
  }));

  return {
    identity,
    keystorePath: explicitPath,
    certificateSha256,
    expectedCertificateSha256: expectedSha256,
    devSigning: true,
    ephemeral: false,
    matchesReleasePin: certificateSha256 === expectedSha256,
  };
}

function compareBuildToolsVersions(a, b) {
  const pa = a.split(/[.-]/).map(s => (/^\d+$/.test(s) ? Number(s) : s));
  const pb = b.split(/[.-]/).map(s => (/^\d+$/.test(s) ? Number(s) : s));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va === vb) continue;
    if (typeof va === 'number' && typeof vb === 'number') return vb - va;
    return String(vb).localeCompare(String(va));
  }
  return 0;
}

export function findApksigner(env = process.env) {
  const isWin = process.platform === 'win32';
  const toolNames = isWin ? ['apksigner.bat', 'apksigner.exe', 'apksigner'] : ['apksigner'];
  const home = env?.HOME || env?.USERPROFILE || os.homedir();
  const sdkRoots = [
    env?.ANDROID_HOME,
    env?.ANDROID_SDK_ROOT,
    path.join(home, 'Library/Android/sdk'),
    path.join(home, 'Android/Sdk'),
    '/Volumes/ORICO/android/sdk',
  ].filter(Boolean);

  for (const root of sdkRoots) {
    const btDir = path.join(root, 'build-tools');
    if (!fs.existsSync(btDir)) continue;
    let versions;
    try {
      versions = fs.readdirSync(btDir).sort(compareBuildToolsVersions);
    } catch {
      continue;
    }
    for (const version of versions) {
      for (const name of toolNames) {
        const candidate = path.join(btDir, version, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  const pathEntries = String(env?.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    for (const name of toolNames) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function parseApksignerCertSha256s(output) {
  const digests = [];
  const re = /certificate SHA-256 digest:\s*([0-9a-fA-F:]{64,95})/gi;
  let m;
  while ((m = re.exec(output)) !== null) {
    const normalized = m[1].replace(/:/g, '').toLowerCase();
    if (SHA256_HEX_RE.test(normalized)) {
      digests.push(normalized);
    }
  }
  return digests;
}

function isApksignerToolUnavailableError(err) {
  if (!err) return false;
  if (err.code === 'ENOENT' || err.code === 'EACCES') return true;
  const text = `${err.message || ''}\n${err.stderr || ''}\n${err.stdout || ''}`;
  return /Unable to locate a Java Runtime|JAVA_HOME is not set|java: not found|command not found/i.test(text);
}

/**
 * Post-signing verification of an output APK's signature and signing certificate SHA-256.
 * Always runs built-in verifyApk(), and additionally runs Android SDK apksigner if available.
 */
export function assertSignedApkCertificate({
  apkPath = null,
  apkBytes = null,
  expectedCertificateSha256 = null,
  enforceReleasePin = false,
  releaseCertificateSha256 = RELEASE_CERTIFICATE_SHA256,
  minSdk = 24,
  keystorePath = null,
  apksignerBin = undefined,
  env = process.env,
} = {}) {
  const bytes = apkBytes || (apkPath ? fs.readFileSync(apkPath) : null);
  if (!bytes) {
    throw new Error('assertSignedApkCertificate requires apkBytes or apkPath');
  }

  const pinSha256 = normalizeCertificateSha256(releaseCertificateSha256);
  const expectedSha256 = expectedCertificateSha256
    ? normalizeCertificateSha256(expectedCertificateSha256)
    : (enforceReleasePin ? pinSha256 : null);

  const verified = verifyApk(bytes);
  const builtinSha256 = computeCertificateSha256(verified.certificate.raw);

  if (enforceReleasePin && builtinSha256 !== pinSha256) {
    throw new Error(formatSigningGuardError({
      reason: 'Post-signing APK verification failed: output APK certificate SHA-256 does not match the pinned release certificate.',
      expectedSha256: pinSha256,
      actualSha256: builtinSha256,
      keystorePath: keystorePath || getDefaultKeystorePath(env),
    }));
  }

  if (expectedSha256 && builtinSha256 !== expectedSha256) {
    throw new Error(formatSigningGuardError({
      reason: 'Post-signing APK verification failed: output APK certificate SHA-256 does not match the expected signing certificate.',
      expectedSha256,
      actualSha256: builtinSha256,
      keystorePath: keystorePath || getDefaultKeystorePath(env),
    }));
  }

  let verifier = 'builtin';
  let resolvedApksigner = null;
  const apksigner = apksignerBin !== undefined ? apksignerBin : findApksigner(env);

  if (apksigner && apkPath) {
    const effectiveMinSdk = Math.max(24, Number(minSdk) || 24);
    try {
      const stdout = execFileSync(
        apksigner,
        ['verify', '--print-certs', '--min-sdk-version', String(effectiveMinSdk), apkPath],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const digests = parseApksignerCertSha256s(stdout);
      if (digests.length === 0) {
        throw new Error(`apksigner verify --print-certs succeeded but did not report a certificate SHA-256 digest for ${apkPath}`);
      }
      for (const digest of digests) {
        if (digest !== builtinSha256) {
          throw new Error(
            `Post-signing verification mismatch between apksigner (${digest}) and built-in verifyApk (${builtinSha256}) for ${apkPath}`
          );
        }
        if (enforceReleasePin && digest !== pinSha256) {
          throw new Error(formatSigningGuardError({
            reason: 'Post-signing apksigner verification failed: output APK certificate SHA-256 does not match the pinned release certificate.',
            expectedSha256: pinSha256,
            actualSha256: digest,
            keystorePath: keystorePath || getDefaultKeystorePath(env),
          }));
        }
        if (expectedSha256 && digest !== expectedSha256) {
          throw new Error(formatSigningGuardError({
            reason: 'Post-signing apksigner verification failed: output APK certificate SHA-256 does not match the expected signing certificate.',
            expectedSha256,
            actualSha256: digest,
            keystorePath: keystorePath || getDefaultKeystorePath(env),
          }));
        }
      }
      verifier = 'apksigner+builtin';
      resolvedApksigner = apksigner;
    } catch (err) {
      if (!isApksignerToolUnavailableError(err)) {
        const stderr = err.stderr ? String(err.stderr).trim() : '';
        const detail = stderr ? `${err.message}\n${stderr}` : err.message;
        throw new Error(`Post-signing apksigner verification failed: ${detail}`);
      }
    }
  }

  return {
    verified: true,
    verifier,
    apksignerPath: resolvedApksigner,
    certificateSha256: builtinSha256,
    matchesReleasePin: builtinSha256 === pinSha256,
    hasV2: verified.hasV2,
    hasV3: verified.hasV3,
    subject: verified.certificate.subject,
    certificate: verified.certificate,
  };
}
