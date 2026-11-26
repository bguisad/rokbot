// High-resolution chat image viewer. The official viewer (React Native image-viewer route) draws with expo-image,
// which decodes to the view size (a 1100x10005 screenshot becomes 198 px wide) and zooms at most ~4x, so long
// screenshots stay unreadable. The companion covers it with a tiled BitmapRegionDecoder view when the image is
// clearly larger than the screen. These tests run the geometry on a JVM and check the wiring.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

function javac() {
  return ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
}

test('Image viewer math (JVM): takeover threshold, fits, sample sizes, tiles, clamping, EXIF, data URLs', async () => {
  const javacBin = javac();
  assert.ok(javacBin, 'JDK required for JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-image-viewer-'));
  try {
    const harnessDir = path.join(tmp, 'src/dev/rokbot/nativeapp');
    fs.mkdirSync(harnessDir, { recursive: true });
    // ~300 KB of random bytes as a data URL, with a line break inside, so the 64 KiB streaming chunks and the
    // carried remainder are exercised.
    const payload = Buffer.alloc(300_001);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) >>> 24;
    const b64 = payload.toString('base64');
    const dataUrl = `data:image/png;base64,${b64.slice(0, 70_001)}\n${b64.slice(70_001)}`;
    fs.writeFileSync(path.join(tmp, 'data-url.txt'), dataUrl);
    fs.writeFileSync(path.join(harnessDir, 'ImageViewerMathHarness.java'), `package dev.rokbot.nativeapp;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.List;

public class ImageViewerMathHarness {
    static void out(Object... parts) {
        StringBuilder b = new StringBuilder();
        for (Object p : parts) { if (b.length() > 0) b.append('|'); b.append(p); }
        System.out.println(b);
    }

    public static void main(String[] a) throws Exception {
        int[][] images = { {1100, 10005}, {4000, 3000}, {480, 320}, {1080, 2400}, {1300, 2400}, {1400, 3100}, {10000, 1000} };
        for (int[] im : images) {
            out("img", im[0] + "x" + im[1], ImageViewerMath.needsTakeover(im[0], im[1], 1080, 2400),
                ImageViewerMath.isTall(im[0], im[1], 1080, 2400),
                ImageViewerMath.initialScale(im[0], im[1], 1080, 2400), ImageViewerMath.minScale(im[0], im[1], 1080, 2400),
                ImageViewerMath.maxScale(im[0], im[1], 1080, 2400));
            float min = ImageViewerMath.minScale(im[0], im[1], 1080, 2400);
            int base = ImageViewerMath.baseSampleSize(im[0], im[1], min);
            out("base", im[0] + "x" + im[1], base, im[0] / base, im[1] / base);
        }
        for (float s : new float[] {4f, 1f, 0.98f, 0.5f, 0.49f, 0.24f, 0.1f, 0f}) out("sample", s, ImageViewerMath.sampleSize(s));
        out("dtap", ImageViewerMath.doubleTapTarget(0.98f, 0.98f, 3.92f), ImageViewerMath.doubleTapTarget(2.45f, 0.98f, 3.92f),
            ImageViewerMath.doubleTapTarget(0.27f, 0.27f, 3f), ImageViewerMath.doubleTapTarget(2f, 2f, 3f));
        out("clamp", ImageViewerMath.clampOffset(50f, 2000f, 1080f), ImageViewerMath.clampOffset(-5000f, 2000f, 1080f),
            ImageViewerMath.clampOffset(-300f, 2000f, 1080f), ImageViewerMath.clampOffset(-300f, 500f, 1080f));
        List<int[]> tiles = ImageViewerMath.tiles(-10f, 4000f, 1200f, 6450f, 1100, 10005, 1);
        int[] last = tiles.get(tiles.size() - 1);
        out("tiles", tiles.size(), tiles.get(0)[0], tiles.get(0)[1], last[0], last[1], last[4], last[5]);
        List<int[]> edge = ImageViewerMath.tiles(0f, 9000f, 1100f, 10005f, 1100, 10005, 2);
        int[] e = edge.get(edge.size() - 1);
        out("edge", edge.size(), e[2], e[3], e[4], e[5]);
        out("none", ImageViewerMath.tiles(0f, 0f, 10f, 10f, 0, 0, 1).size());
        for (int o = 0; o <= 9; o++) out("exif", o, ImageViewerMath.rotationOf(o));
        out("key", ImageViewerMath.sourceKey("data:image/png;base64,AAAA"), ImageViewerMath.sourceKey(null));
        for (String u : new String[] { "data:image/png;base64,QUJD", "DATA:image/jpeg;BASE64,QUJD", "data:image/svg+xml,<svg/>",
                "file:///x.png", "data:image/png;base64" }) out("payload", u, ImageViewerMath.base64PayloadStart(u));

        String url = new String(Files.readAllBytes(Paths.get(a[0], "data-url.txt")), StandardCharsets.US_ASCII);
        ByteArrayOutputStream decoded = new ByteArrayOutputStream();
        ImageViewerMath.decodeBase64(url, ImageViewerMath.base64PayloadStart(url), decoded);
        byte[] bytes = decoded.toByteArray();
        StringBuilder hex = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) hex.append(String.format("%02x", b));
        out("b64", bytes.length, hex);
        System.out.println("IMAGE_VIEWER_MATH_OK");
    }
}
`);
    const out = path.join(tmp, 'classes');
    cp.execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-d', out,
      path.join(SRC, 'ImageViewerMath.java'), path.join(harnessDir, 'ImageViewerMathHarness.java')], { stdio: 'pipe' });
    const res = cp.execFileSync(javaBin, ['-cp', out, 'dev.rokbot.nativeapp.ImageViewerMathHarness', tmp], { encoding: 'utf8' });
    assert.ok(res.includes('IMAGE_VIEWER_MATH_OK'), res);
    const lines = res.trim().split('\n').map(l => l.split('|'));
    const row = (...prefix) => lines.find(l => prefix.every((p, i) => l[i] === p));
    const num = v => Number(v);

    // Takeover: the user's README screenshot and a 12 MP photo go native; small and screen-sized images stay official.
    assert.equal(row('img', '1100x10005')[2], 'true');
    assert.equal(row('img', '4000x3000')[2], 'true');
    assert.equal(row('img', '480x320')[2], 'false');
    assert.equal(row('img', '1080x2400')[2], 'false', 'a phone screenshot keeps the official viewer');
    assert.equal(row('img', '1300x2400')[2], 'false', 'slightly larger than the screen keeps the official viewer');
    assert.equal(row('img', '1400x3100')[2], 'true');

    // Long images open at the full width (1080/1100) and can zoom out to the whole page; others open contained.
    const long = row('img', '1100x10005');
    assert.equal(long[3], 'true');
    assert.ok(Math.abs(num(long[4]) - 1080 / 1100) < 1e-4, long[4]);
    assert.ok(Math.abs(num(long[5]) - 2400 / 10005) < 1e-4, long[5]);
    assert.ok(num(long[6]) >= 3.9, 'at least 4x the full-width fit');
    const big = row('img', '4000x3000');
    assert.equal(big[3], 'false');
    assert.ok(Math.abs(num(big[4]) - 0.27) < 1e-4, big[4]);
    assert.equal(num(big[6]), 3, '3 screen px per image px at most');
    assert.equal(row('img', '10000x1000')[3], 'false', 'panoramas are contained, not stretched to the height');

    // Base layer: small enough to always upload as a texture, never full size for the large images.
    for (const name of ['1100x10005', '4000x3000', '10000x1000', '1400x3100']) {
      const [, , sample, w, h] = row('base', name);
      assert.ok(num(w) <= 4096 && num(h) <= 4096 && num(w) * num(h) <= 4 * 1024 * 1024, `${name} base ${w}x${h}`);
      assert.ok(num(sample) >= 2, `${name} base is subsampled`);
    }
    assert.deepEqual(row('base', '1100x10005').slice(2), ['4', '275', '2501']);
    assert.equal(row('base', '480x320')[2], '1');

    // Sample sizes: the largest power of two not above image pixels per screen pixel.
    assert.deepEqual(lines.filter(l => l[0] === 'sample').map(l => l[2]), ['1', '1', '1', '2', '2', '4', '8', '1']);

    // Double tap: fit -> 1:1 (at least 2.5x the fit), zoomed -> back to the fit.
    const dtap = row('dtap').slice(1).map(num);
    assert.ok(Math.abs(dtap[0] - 2.45) < 1e-4, String(dtap[0]));
    assert.ok(Math.abs(dtap[1] - 0.98) < 1e-4, String(dtap[1]));
    assert.equal(dtap[2], 1);
    assert.equal(dtap[3], 3, 'a small image already above 1:1 zooms to the 3x cap');

    // Pan limits: no gap at either edge; content smaller than the view is centered.
    assert.deepEqual(row('clamp').slice(1).map(num), [0, -920, -300, 290]);

    // Tiles at sample 1 (512 px): x 0..1100 -> 3 columns, y 4000..6450 -> rows 7..12, last tile clipped to the width.
    assert.deepEqual(row('tiles').slice(1).map(num), [18, 0, 7, 2, 12, 1100, 6656]);
    // Sample 2 (1024 px source tiles): the bottom row is clipped to the image height.
    assert.deepEqual(row('edge').slice(1).map(num), [4, 1024, 9216, 1100, 10005]);
    assert.equal(row('none')[1], '0');

    // EXIF orientation -> clockwise rotation.
    assert.deepEqual(lines.filter(l => l[0] === 'exif').map(l => l[2]), ['0', '0', '0', '180', '180', '90', '90', '270', '270', '0']);

    // Data URLs: only base64 payloads; streaming decode is byte-exact across chunk boundaries and line breaks.
    assert.deepEqual(lines.filter(l => l[0] === 'payload').map(l => l[2]), ['22', '23', '-1', '-1', '-1']);
    assert.match(row('key')[1], /^[0-9a-f]+-26$/);
    assert.equal(row('key')[2], '');
    const [, length, sha] = row('b64');
    assert.equal(num(length), payload.length);
    assert.equal(sha, (await import('node:crypto')).createHash('sha256').update(payload).digest('hex'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Image viewer wiring: React activities only, nothing inserted into React Native, official viewer kept for its menu', () => {
  const boot = read('RokBotBootstrap.java');
  assert.match(boot, /if \(isReactActivity\(activity\)\) ImageViewerTakeover\.onReactResumed\(activity\);/);
  assert.match(boot, /ImageViewerTakeover\.onReactPaused\(activity\);/);

  const takeover = read('ImageViewerTakeover.java');
  // Found by the official testIDs and expo-image's kept field names.
  for (const id of ['image-viewer-cover', 'image-viewer-box', 'image-viewer-home-clip']) assert.ok(takeover.includes(`"${id}"`), id);
  assert.ok(takeover.includes('"expo.modules.image.ExpoImageViewWrapper"'));
  assert.match(takeover, /field\(expoImage\.getClass\(\), "sources"\)/);
  assert.match(takeover, /field\(item\.getClass\(\), "uri"\)/);
  // The cover goes on the decor view (a sibling of the React content), never into the React tree.
  assert.match(takeover, /decor\.addView\(overlay,/);
  assert.doesNotMatch(takeover, /\b(cover|viewer|box|current|content)\)?\.addView\(/);
  // Only large images are taken over; remote URLs and GIFs stay with the official viewer.
  assert.match(takeover, /ImageViewerMath\.needsTakeover\(/);
  assert.match(takeover, /return null; \/\/ Remote URLs/);
  assert.match(takeover, /"image\/gif"\.equals\(o\.outMimeType\)/);
  // Close goes through Back (React Native closes its viewer); More hands the session back and opens its menu.
  assert.match(takeover, /act\.onBackPressed\(\)/);
  assert.match(takeover, /sSessionHandedBack = true;\s*dismissOverlay\(false\)/);

  const view = read('ZoomImageView.java');
  assert.match(view, /BitmapRegionDecoder\.newInstance\(next\.path, false\)/);
  assert.match(view, /decoder\.decodeRegion\(region, o\)/);
  assert.match(view, /new ScaleGestureDetector\(/);
  assert.match(view, /onDoubleTap\(MotionEvent e\)/);
});

test('Image viewer classes are in the shipped companion dex', () => {
  const dex = fs.readFileSync(path.join(NATIVE_ROOT, 'bin/classes2.dex'));
  for (const cls of ['ImageViewerTakeover', 'ImageViewerMath', 'ZoomImageView']) {
    assert.ok(dex.includes(Buffer.from(`Ldev/rokbot/nativeapp/${cls};`)), `${cls} missing from bin/classes2.dex (run companion/build.sh)`);
  }
});
