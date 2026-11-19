// Adversarial Test Harness: Hermes Bytecode SHA-1 Footer & Corruption Resistance
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  synthesizeHermesBytecode,
  loadGatewayTemplateMetadata,
  patchHermesBundle,
  HBC_MAGIC,
  HBC_VERSION
} from '../patchers/hermes.mjs';

function computeBundleSha1(bundle) {
  return crypto.createHash('sha1').update(bundle.subarray(0, bundle.length - 20)).digest();
}

function verifyBundleIntegrity(bundle) {
  if (bundle.length < 20) return false;
  const expected = computeBundleSha1(bundle);
  const actual = bundle.subarray(bundle.length - 20);
  return expected.equals(actual);
}

test('Hermes SHA-1: Footer calculation is 100% exact across various URLs and tokens', () => {
  const meta = loadGatewayTemplateMetadata();
  const templateBundle = Buffer.alloc(meta.bodyOffset + meta.bodyCapacity + 100);

  const testCases = [
    { url: 'http://127.0.0.1:8080', token: 'ABCDEF' },
    { url: 'https://gateway.example.com:443/api', token: '987654' },
    { url: 'http://192.168.1.50:18080', token: '' },
    { url: '', token: '' },
  ];

  for (const { url, token } of testCases) {
    const synthesized = synthesizeHermesBytecode(templateBundle, meta, url, token);
    assert.equal(synthesized.length, templateBundle.length);

    const actualFooter = synthesized.subarray(synthesized.length - 20);
    const expectedFooter = computeBundleSha1(synthesized);

    assert.ok(
      actualFooter.equals(expectedFooter),
      `SHA-1 footer mismatch for url=${url}, token=${token}`
    );
    assert.equal(verifyBundleIntegrity(synthesized), true);
  }
});

test('Hermes Corruption: Single-byte modification in header or body triggers SHA-1 mismatch', () => {
  const meta = loadGatewayTemplateMetadata();
  const templateBundle = Buffer.alloc(meta.bodyOffset + meta.bodyCapacity + 100);
  const synthesized = synthesizeHermesBytecode(templateBundle, meta, 'http://192.168.1.1:8080', 'K7M9P2');

  const testOffsets = [
    0,                                      // Magic byte
    4,                                      // Version offset
    meta.bodyLengthOffset,                  // Stored body length
    meta.bodyOffset,                        // First opcode byte
    meta.bodyOffset + 10,                   // Mid-body opcode
    meta.bodyOffset + meta.bodyCapacity - 1, // Padding byte
    synthesized.length - 21,                // Last byte before SHA-1 footer
    synthesized.length - 20,                // First byte of SHA-1 footer
    synthesized.length - 1,                 // Last byte of SHA-1 footer
  ];

  for (const offset of testOffsets) {
    const corrupted = Buffer.from(synthesized);
    corrupted[offset] ^= 0x01; // flip 1 bit

    assert.equal(
      verifyBundleIntegrity(corrupted),
      false,
      `Corruption at offset ${offset} went undetected by SHA-1 verification!`
    );
  }
});

test('Hermes Adversarial: Unsupported characters in URL/token throw informative error', () => {
  const meta = loadGatewayTemplateMetadata();
  const templateBundle = Buffer.alloc(meta.bodyOffset + meta.bodyCapacity + 100);

  // URL containing non-standard or unicode character not present in template string table
  assert.throws(
    () => synthesizeHermesBytecode(templateBundle, meta, 'http://example.com/测试', 'TOKEN1'),
    /Unsupported character in connection config/
  );
});

test('Hermes Adversarial: Truncated bundle input (smaller than template body)', () => {
  const meta = loadGatewayTemplateMetadata();
  // Buffer smaller than bodyOffset
  const shortBundle = Buffer.alloc(10);
  assert.throws(
    () => synthesizeHermesBytecode(shortBundle, meta, 'http://localhost:8080', 'ABCDEF'),
    /out of range|out of bounds/i
  );
});

test('Hermes Adversarial: Buffer smaller than 20 bytes for SHA-1 calculation', () => {
  const meta = loadGatewayTemplateMetadata();
  const tinyBundle = Buffer.alloc(15);
  // synthesizeHermesBytecode throws out of bounds on copy
  assert.throws(() => synthesizeHermesBytecode(tinyBundle, meta, 'http://localhost:8080', ''));
});
