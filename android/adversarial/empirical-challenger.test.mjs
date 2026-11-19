// Empirical Challenger Stress Test Suite for Milestone 1 Iteration 2
// Rigorous adversarial tests for APK v2/v3 dual verification, AXML fuzzing, and 16KB ELF alignment.
import assert from 'node:assert/strict';
import { execSync, fork } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createEntry,
  writeZip,
  readZip,
  createSigningIdentity,
  signApk,
  verifyApk,
  findEnd,
  u16,
  u32,
  u64,
  prefixed
} from '../patchers/signing.mjs';
import { parseAxml, serializeAxml, patchManifest } from '../patchers/manifest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_APK = path.join(REPO_ROOT, 'android/bin/rokbot-native-base.apk');
const APKSIGNER_BIN = '/Users/lianqishi/Library/Android/sdk/build-tools/36.0.0/apksigner';
const ZIPALIGN_BIN = '/Users/lianqishi/Library/Android/sdk/build-tools/36.0.0/zipalign';

const V2_BLOCK_ID = 0x7109871a;
const V3_BLOCK_ID = 0xf05368c0;
const BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'latin1');

function runApksigner(apkPath, { minSdk = 24, maxSdk = 35 } = {}) {
  try {
    const cmd = `${APKSIGNER_BIN} verify -v --min-sdk-version ${minSdk} --max-sdk-version ${maxSdk} "${apkPath}"`;
    const output = execSync(cmd, { stdio: 'pipe' }).toString();
    return { ok: true, output };
  } catch (err) {
    return {
      ok: false,
      output: err.stdout?.toString() || err.message,
      stderr: err.stderr?.toString() || ''
    };
  }
}

function createDualSignedApk({ minSdk = 24 } = {}) {
  const entries = [
    createEntry('AndroidManifest.xml', Buffer.from('<manifest package="dev.rokbot.test"/>'), { store: true }),
    createEntry('classes.dex', Buffer.from('dex\n038\0' + 'testdexpayload'.repeat(20)), { store: false }),
    createEntry('lib/arm64-v8a/libtest.so', Buffer.from('ELF mock binary content'), { store: true }),
  ];
  const unsigned = writeZip(entries);
  const identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 });
  return { apkBytes: signApk(unsigned, identity, { schemes: ['v2', 'v3'], minSdk }), identity };
}

// ============================================================================
// 1. APK SIGNATURE SCHEME V2 & V3 DUAL VERIFICATION ADVERSARIAL TESTS
// ============================================================================

test('CHALLENGE-APK-1: Tampered v3 signature block with untouched v2 block is rejected by verifyApk and apksigner', () => {
  const { apkBytes } = createDualSignedApk();
  const end = findEnd(apkBytes);
  const centralOffset = apkBytes.readUInt32LE(end + 16);
  const size = Number(apkBytes.readBigUInt64LE(centralOffset - 24));
  const blockStart = centralOffset - size - 8;

  // Locate the v3 block in the signing block
  let v3Offset = -1;
  let v3Length = 0;
  for (let at = blockStart + 8; at < centralOffset - 24;) {
    const length = Number(apkBytes.readBigUInt64LE(at));
    const id = apkBytes.readUInt32LE(at + 8);
    if (id === V3_BLOCK_ID) {
      v3Offset = at + 12; // Start of v3 block data
      v3Length = length - 4;
      break;
    }
    at += 8 + length;
  }
  assert.ok(v3Offset > 0, 'v3 block must be present');

  // Tamper: Corrupt signature in v3 block without modifying v2 block or zip contents
  const tampered = Buffer.from(apkBytes);
  tampered[v3Offset + 30] ^= 0xaa;

  // In-engine verifyApk must reject v3
  assert.throws(
    () => verifyApk(tampered),
    /APK signature does not verify|APK contents do not match the signature/
  );

  // Official apksigner with API level >= 28 (which enforces v3) must also reject
  const tmpApk = path.join(os.tmpdir(), `challenger-tamper-v3-${Date.now()}.apk`);
  fs.writeFileSync(tmpApk, tampered);
  try {
    const res = runApksigner(tmpApk, { minSdk: 28, maxSdk: 35 });
    assert.equal(res.ok, false, 'apksigner must reject APK with corrupted v3 signature');
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

test('CHALLENGE-APK-2: Tampered v2 signature block with untouched v3 block is rejected by verifyApk and apksigner', () => {
  const { apkBytes } = createDualSignedApk();
  const end = findEnd(apkBytes);
  const centralOffset = apkBytes.readUInt32LE(end + 16);
  const size = Number(apkBytes.readBigUInt64LE(centralOffset - 24));
  const blockStart = centralOffset - size - 8;

  // Locate the v2 block
  let v2Offset = -1;
  let v2Length = 0;
  for (let at = blockStart + 8; at < centralOffset - 24;) {
    const length = Number(apkBytes.readBigUInt64LE(at));
    const id = apkBytes.readUInt32LE(at + 8);
    if (id === V2_BLOCK_ID) {
      v2Offset = at + 12;
      v2Length = length - 4;
      break;
    }
    at += 8 + length;
  }
  assert.ok(v2Offset > 0, 'v2 block must be present');

  // Tamper: Corrupt signature in v2 block
  const tampered = Buffer.from(apkBytes);
  tampered[v2Offset + 30] ^= 0x55;

  // In-engine verifyApk must reject v2
  assert.throws(
    () => verifyApk(tampered),
    /APK signature does not verify \(v2\)|APK signature does not verify/
  );

  // Official apksigner with API level 24-27 (where v2 is primary) must reject
  const tmpApk = path.join(os.tmpdir(), `challenger-tamper-v2-${Date.now()}.apk`);
  fs.writeFileSync(tmpApk, tampered);
  try {
    const res = runApksigner(tmpApk, { minSdk: 24, maxSdk: 27 });
    assert.equal(res.ok, false, 'apksigner must reject APK with corrupted v2 signature on API 24-27');
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

test('CHALLENGE-APK-3: Missing both v2 and v3 blocks (only unknown block ID) throws No supported APK signature block found', () => {
  const { apkBytes } = createDualSignedApk();
  const end = findEnd(apkBytes);
  const centralOffset = apkBytes.readUInt32LE(end + 16);

  // Re-create signing block with only an unknown block ID (0xdeadbeef)
  const unknownPayload = Buffer.from('arbitrary-payload-data');
  const unknownPair = Buffer.concat([u64(4 + unknownPayload.length), u32(0xdeadbeef), unknownPayload]);
  const blockSize = unknownPair.length + 8 + BLOCK_MAGIC.length;
  const newBlock = Buffer.concat([u64(blockSize), unknownPair, u64(blockSize), BLOCK_MAGIC]);

  const contents = apkBytes.subarray(0, findEnd(apkBytes)); // zip before original block
  // Read original unsigned zip to get pristine contents
  const entries = [
    createEntry('AndroidManifest.xml', Buffer.from('<manifest/>'), { store: true }),
  ];
  const unsigned = writeZip(entries);
  const uEnd = findEnd(unsigned);
  const uCentral = unsigned.readUInt32LE(uEnd + 16);
  const uContents = unsigned.subarray(0, uCentral);
  const uDirectory = unsigned.subarray(uCentral, uEnd);
  const uTail = Buffer.from(unsigned.subarray(uEnd));
  uTail.writeUInt32LE(uCentral + newBlock.length, 16);

  const fakeApk = Buffer.concat([uContents, newBlock, uDirectory, uTail]);

  assert.throws(
    () => verifyApk(fakeApk),
    /No supported APK signature block found/
  );
});

test('CHALLENGE-APK-4: Corrupted digest algorithm ID in v2 block causes algorithm mismatch error', () => {
  const { apkBytes } = createDualSignedApk();
  const end = findEnd(apkBytes);
  const centralOffset = apkBytes.readUInt32LE(end + 16);
  const size = Number(apkBytes.readBigUInt64LE(centralOffset - 24));
  const blockStart = centralOffset - size - 8;

  // In v2 block, tamper the digest algorithm ID in signedData to an unsupported value (0x9999)
  // v2 block starts with: u32(signers_len), u32(signer_len), u32(signed_data_len)
  // inside signed_data: u32(digests_len), u32(digest_len), u32(algorithm_id)
  let v2DataOffset = -1;
  for (let at = blockStart + 8; at < centralOffset - 24;) {
    const length = Number(apkBytes.readBigUInt64LE(at));
    const id = apkBytes.readUInt32LE(at + 8);
    if (id === V2_BLOCK_ID) {
      v2DataOffset = at + 12;
      break;
    }
    at += 8 + length;
  }
  assert.ok(v2DataOffset > 0);

  // The algorithm ID in the digest record is at v2DataOffset + 20
  const tampered = Buffer.from(apkBytes);
  tampered.writeUInt32LE(0x9999, v2DataOffset + 20);

  assert.throws(
    () => verifyApk(tampered),
    /APK signature does not verify|Digest algorithm mismatch/
  );
});

test('CHALLENGE-APK-5: Signing block length tampering (mismatched header and footer size)', () => {
  const { apkBytes } = createDualSignedApk();
  const end = findEnd(apkBytes);
  const centralOffset = apkBytes.readUInt32LE(end + 16);

  // Tamper the header size (at blockStart) so it differs from footer size (at centralOffset - 24)
  const size = Number(apkBytes.readBigUInt64LE(centralOffset - 24));
  const blockStart = centralOffset - size - 8;

  const tampered = Buffer.from(apkBytes);
  tampered.writeBigUInt64LE(BigInt(size + 16), blockStart);

  assert.throws(
    () => verifyApk(tampered),
    /Corrupt APK Signing Block/
  );
});

test('CHALLENGE-APK-6: Invalid block entry length exceeding block bounds is rejected', () => {
  const { apkBytes } = createDualSignedApk();
  const end = findEnd(apkBytes);
  const centralOffset = apkBytes.readUInt32LE(end + 16);
  const size = Number(apkBytes.readBigUInt64LE(centralOffset - 24));
  const blockStart = centralOffset - size - 8;

  // The first entry header is at blockStart + 8. Set length to a value larger than size
  const tampered = Buffer.from(apkBytes);
  tampered.writeBigUInt64LE(BigInt(size + 1000), blockStart + 8);

  assert.throws(
    () => verifyApk(tampered),
    /Corrupt APK Signing Block entry length/
  );
});

// ============================================================================
// 2. AXML PARSER FUZZING & MALFORMED CHUNK STRESS TESTS
// ============================================================================

test('CHALLENGE-AXML-1: Malformed chunk sizes: negative and small (< 8)', () => {
  // AXML doc header: 8 bytes
  const makeDocWithChunkSize = (chunkSizeVal) => {
    const buf = Buffer.alloc(24);
    buf.writeUInt16LE(0x0003, 0); // RES_XML_TYPE
    buf.writeUInt16LE(8, 2);      // headerSize = 8
    buf.writeUInt32LE(24, 4);     // docSize = 24
    buf.writeUInt16LE(0x0001, 8); // chunkType (STRING_POOL)
    buf.writeUInt16LE(8, 10);     // chunkHeaderSize = 8
    buf.writeUInt32LE(chunkSizeVal >>> 0, 12); // chunkSize
    return buf;
  };

  // Test chunkSize from 1 to 7 (< 8)
  for (let s = 1; s < 8; s++) {
    const doc = makeDocWithChunkSize(s);
    assert.throws(
      () => parseAxml(doc),
      /Invalid AXML chunk size/
    );
  }

  // Test 32-bit negative / huge integer: 0xffffffff (-1 as unsigned)
  const docHuge = makeDocWithChunkSize(0xffffffff);
  assert.throws(
    () => parseAxml(docHuge),
    /Invalid AXML chunk size/
  );

  // Test chunkSize = 0x80000000
  const docHighBit = makeDocWithChunkSize(0x80000000);
  assert.throws(
    () => parseAxml(docHighBit),
    /Invalid AXML chunk size/
  );
});

test('CHALLENGE-AXML-2: ChunkSize larger than buffer throws Invalid AXML chunk size', () => {
  const buf = Buffer.alloc(32);
  buf.writeUInt16LE(0x0003, 0); // RES_XML_TYPE
  buf.writeUInt16LE(8, 2);      // headerSize = 8
  buf.writeUInt32LE(32, 4);     // docSize = 32
  buf.writeUInt16LE(0x0001, 8); // chunkType
  buf.writeUInt16LE(8, 10);     // chunkHeaderSize = 8
  buf.writeUInt32LE(33, 12);    // chunkSize = 33 > buffer.length

  assert.throws(
    () => parseAxml(buf),
    /Invalid AXML chunk size: 33 at offset 8/
  );
});

test('CHALLENGE-AXML-3: Truncated chunk headers at buffer end throw Truncated AXML chunk header', () => {
  // Test remaining trailing bytes 1 through 7
  for (let trailing = 1; trailing <= 7; trailing++) {
    const totalLen = 8 + trailing;
    const buf = Buffer.alloc(totalLen);
    buf.writeUInt16LE(0x0003, 0); // RES_XML_TYPE
    buf.writeUInt16LE(8, 2);      // headerSize = 8
    buf.writeUInt32LE(totalLen, 4); // docSize = totalLen

    assert.throws(
      () => parseAxml(buf),
      /Truncated AXML chunk header at offset 8/
    );
  }
});

test('CHALLENGE-AXML-4: Corrupt namespaces with out-of-bounds prefix/URI indices handled safely', () => {
  // Build a minimal AXML with string pool of 2 strings and a namespace chunk with indices 9999
  const stringPool = Buffer.alloc(32);
  stringPool.writeUInt16LE(0x0001, 0); // RES_STRING_POOL_TYPE
  stringPool.writeUInt16LE(28, 2);     // headerSize
  stringPool.writeUInt32LE(32, 4);     // chunkSize = 32
  stringPool.writeUInt32LE(1, 8);      // stringCount = 1
  stringPool.writeUInt32LE(0, 12);     // styleCount = 0
  stringPool.writeUInt32LE(0, 16);     // flags
  stringPool.writeUInt32LE(28, 20);    // stringsStart = 28
  stringPool.writeUInt32LE(0, 24);     // offset 0

  // Namespace chunk (24 bytes)
  const nsChunk = Buffer.alloc(24);
  nsChunk.writeUInt16LE(0x0100, 0);    // RES_XML_START_NAMESPACE_TYPE
  nsChunk.writeUInt16LE(16, 2);        // chunkHeaderSize
  nsChunk.writeUInt32LE(24, 4);        // chunkSize
  nsChunk.writeUInt32LE(1, 8);         // lineNumber = 1
  nsChunk.writeUInt32LE(0xffffffff, 12); // comment = -1
  nsChunk.writeUInt32LE(9999, 16);     // prefixIdx = 9999 (OUT OF BOUNDS)
  nsChunk.writeUInt32LE(9999, 20);     // uriIdx = 9999 (OUT OF BOUNDS)

  const docLen = 8 + stringPool.length + nsChunk.length;
  const doc = Buffer.concat([
    Buffer.alloc(8),
    stringPool,
    nsChunk
  ]);
  doc.writeUInt16LE(0x0003, 0);
  doc.writeUInt16LE(8, 2);
  doc.writeUInt32LE(docLen, 4);

  // Must parse without crash; out-of-bounds indices evaluate to empty strings ''
  const parsed = parseAxml(doc);
  assert.equal(parsed.namespaces.length, 1);
  assert.equal(parsed.namespaces[0].prefix, '');
  assert.equal(parsed.namespaces[0].uri, '');
});

test('CHALLENGE-AXML-5: Deeply nested elements (>500 levels) parse and serialize without stack overflow', () => {
  // Construct deeply nested AST structure
  const root = {
    type: 'element',
    name: 'manifest',
    namespace: null,
    lineNumber: 1,
    attributes: [{
      name: 'package',
      namespace: null,
      resourceId: null,
      type: 0x03,
      rawValue: 'dev.rokbot.deep',
      value: 'dev.rokbot.deep'
    }],
    children: []
  };

  let current = root;
  for (let i = 0; i < 500; i++) {
    const child = {
      type: 'element',
      name: `level_${i}`,
      namespace: null,
      lineNumber: i + 2,
      attributes: [],
      children: []
    };
    current.children.push(child);
    current = child;
  }

  const ast = { rootNodes: [root], namespaces: [], strings: [], resMap: [], isUtf8: false };
  const serialized = serializeAxml(ast);
  assert.ok(serialized.length > 0);

  const reParsed = parseAxml(serialized);
  assert.equal(reParsed.rootNodes[0].name, 'manifest');
});

// ============================================================================
// 3. 16KB NATIVE LIBRARY PAGE ALIGNMENT & ELF PT_LOAD SEGMENT VERIFICATION
// ============================================================================

test('CHALLENGE-16KB-1: Zipalign 16KB uncompressed .so alignment passes across extreme boundary payload sizes', () => {
  const tmpApk = path.join(os.tmpdir(), `challenger-align-16k-${Date.now()}.apk`);
  try {
    const boundarySizes = [0, 1, 4095, 4096, 4097, 16383, 16384, 16385, 32767, 32768, 65535, 65536];
    const entries = [];

    for (let i = 0; i < boundarySizes.length; i++) {
      const size = boundarySizes[i];
      entries.push(
        createEntry(`assets/pad_${i}.bin`, Buffer.alloc(size, 0x77), { store: true })
      );
      entries.push(
        createEntry(`lib/arm64-v8a/libboundary_${i}.so`, Buffer.alloc(128, 0x88), { store: true })
      );
    }

    const zipBuf = writeZip(entries);
    fs.writeFileSync(tmpApk, zipBuf);

    // 1. Programmatic verification: Every uncompressed .so dataStart must be a multiple of 16384
    const zip = readZip(zipBuf);
    for (const e of zip.entries) {
      if (e.name.endsWith('.so') && e.method === 0) {
        assert.equal(e.dataStart % 16384, 0, `Entry ${e.name} offset ${e.dataStart} must be 16KB aligned`);
      }
    }

    // 2. Official Android SDK zipalign tool verification
    const result = execSync(`${ZIPALIGN_BIN} -c -v -P 16 4 "${tmpApk}"`, { stdio: 'pipe' }).toString();
    assert.match(result, /Verification successful/);
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

// Helper: ELF64 PT_LOAD parser & Android 15/16 16KB alignment validator
function validateElf16KbAlignment(elfBuffer) {
  if (elfBuffer.length < 64) {
    throw new Error('Buffer too small for ELF header');
  }
  // Verify ELF Magic: 0x7f, 'E', 'L', 'F'
  if (elfBuffer[0] !== 0x7f || elfBuffer[1] !== 0x45 || elfBuffer[2] !== 0x4c || elfBuffer[3] !== 0x46) {
    throw new Error('Not an ELF binary');
  }
  // EI_CLASS: 2 = 64-bit
  const is64Bit = elfBuffer[4] === 2;
  if (!is64Bit) {
    throw new Error('Only 64-bit ELF supported for Android 15/16 16KB page check');
  }

  // e_phoff: offset to program header table (offset 32 in ELF64, 8 bytes)
  const e_phoff = Number(elfBuffer.readBigUInt64LE(32));
  // e_phentsize: size of program header entry (offset 54, 2 bytes)
  const e_phentsize = elfBuffer.readUInt16LE(54);
  // e_phnum: number of program headers (offset 56, 2 bytes)
  const e_phnum = elfBuffer.readUInt16LE(56);

  if (e_phoff + e_phnum * e_phentsize > elfBuffer.length) {
    throw new Error('Program header table out of bounds');
  }

  const PT_LOAD = 1;
  const loadSegments = [];

  for (let i = 0; i < e_phnum; i++) {
    const phOffset = e_phoff + i * e_phentsize;
    const p_type = elfBuffer.readUInt32LE(phOffset);
    if (p_type === PT_LOAD) {
      // In Elf64_Phdr:
      // p_type: 4B, p_flags: 4B, p_offset: 8B, p_vaddr: 8B, p_paddr: 8B, p_filesz: 8B, p_memsz: 8B, p_align: 8B
      const p_flags = elfBuffer.readUInt32LE(phOffset + 4);
      const p_offset = Number(elfBuffer.readBigUInt64LE(phOffset + 8));
      const p_vaddr = Number(elfBuffer.readBigUInt64LE(phOffset + 16));
      const p_filesz = Number(elfBuffer.readBigUInt64LE(phOffset + 32));
      const p_memsz = Number(elfBuffer.readBigUInt64LE(phOffset + 40));
      const p_align = Number(elfBuffer.readBigUInt64LE(phOffset + 48));

      loadSegments.push({ p_offset, p_vaddr, p_filesz, p_memsz, p_align, p_flags });
    }
  }

  if (loadSegments.length === 0) {
    throw new Error('No PT_LOAD segments found in ELF binary');
  }

  // Android 15/16 16KB page alignment requirements:
  // 1. Every PT_LOAD segment must have p_align >= 16384 (16KB)
  // 2. Congruence: (p_vaddr % p_align) === (p_offset % p_align)
  const violations = [];
  for (const seg of loadSegments) {
    if (seg.p_align < 16384) {
      violations.push(`Segment p_align ${seg.p_align} < 16384 (not 16KB aligned)`);
    }
    if ((seg.p_vaddr % seg.p_align) !== (seg.p_offset % seg.p_align)) {
      violations.push(`Segment incongruence: vaddr % align (${seg.p_vaddr % seg.p_align}) != offset % align (${seg.p_offset % seg.p_align})`);
    }
  }

  return {
    valid: violations.length === 0,
    segmentCount: loadSegments.length,
    segments: loadSegments,
    violations
  };
}

function createSyntheticElf64({ align = 16384, offset = 0, vaddr = 0 } = {}) {
  // Construct minimal 64-bit ELF with one PT_LOAD header
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0); // \x7fELF, 64-bit, little-endian, version 1
  header.writeUInt16LE(3, 16);  // e_type = ET_DYN (shared object)
  header.writeUInt16LE(183, 18); // e_machine = EM_AARCH64 (183)
  header.writeUInt32LE(1, 20);   // e_version = 1
  header.writeBigUInt64LE(64n, 32); // e_phoff = 64
  header.writeUInt16LE(64, 52);  // e_ehsize = 64
  header.writeUInt16LE(56, 54);  // e_phentsize = 56 (standard Elf64_Phdr size)
  header.writeUInt16LE(1, 56);   // e_phnum = 1

  const phdr = Buffer.alloc(56);
  phdr.writeUInt32LE(1, 0); // PT_LOAD
  phdr.writeUInt32LE(5, 4); // PF_R | PF_X
  phdr.writeBigUInt64LE(BigInt(offset), 8); // p_offset
  phdr.writeBigUInt64LE(BigInt(vaddr), 16);  // p_vaddr
  phdr.writeBigUInt64LE(BigInt(vaddr), 24);  // p_paddr
  phdr.writeBigUInt64LE(1024n, 32);          // p_filesz
  phdr.writeBigUInt64LE(1024n, 40);          // p_memsz
  phdr.writeBigUInt64LE(BigInt(align), 48);  // p_align

  return Buffer.concat([header, phdr, Buffer.alloc(1024, 0x90)]);
}

test('CHALLENGE-ELF-1: ELF64 validator correctly approves 16KB-aligned PT_LOAD segments', () => {
  const elf = createSyntheticElf64({ align: 16384, offset: 0, vaddr: 0 });
  const result = validateElf16KbAlignment(elf);
  assert.equal(result.valid, true);
  assert.equal(result.violations.length, 0);
  assert.equal(result.segmentCount, 1);
});

test('CHALLENGE-ELF-2: ELF64 validator rejects legacy 4KB-aligned ELF with clear error', () => {
  const legacyElf = createSyntheticElf64({ align: 4096, offset: 0, vaddr: 0 });
  const result = validateElf16KbAlignment(legacyElf);
  assert.equal(result.valid, false);
  assert.match(result.violations[0], /Segment p_align 4096 < 16384/);
});

test('CHALLENGE-ELF-3: ELF64 validator rejects incongruent vaddr/offset alignment', () => {
  // Offset 0x4000 (16KB) but vaddr 0x5000 (16KB + 4KB) -> incongruent
  const incongruentElf = createSyntheticElf64({ align: 16384, offset: 0x4000, vaddr: 0x5000 });
  const result = validateElf16KbAlignment(incongruentElf);
  assert.equal(result.valid, false);
  assert.match(result.violations[0], /Segment incongruence/);
});

test('CHALLENGE-ELF-4: ELF64 validator rejects corrupted program header table bounds gracefully', () => {
  const badElf = createSyntheticElf64();
  // Corrupt e_phoff to point past the buffer
  badElf.writeBigUInt64LE(999999n, 32);
  assert.throws(
    () => validateElf16KbAlignment(badElf),
    /Program header table out of bounds/
  );
});
