"""Release CLI failure paths, using only temporary synthetic input (no Xcode or device)."""
from pathlib import Path
import json
import os
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile


PATCHER = Path(__file__).resolve().parents[1] / 'release' / 'patch-ios.py'
APP_PATCHER = PATCHER.parents[1] / 'patchers' / 'ios' / 'patch-app.py'
MANIFEST = PATCHER.parents[1] / 'recipes' / 'ios' / 'manifest.json'
ICON_DIR = PATCHER.parents[2] / 'assets' / 'logo' / 'ios'


def synthetic_arm64_macho():
    # Minimal thin arm64 Mach-O with one LC_SEGMENT_64 (__TEXT/__text) at fileoff 4096,
    # leaving generous zero header padding for LC_LOAD_DYLIB injection.
    section = struct.pack('<16s16sQQIIIIIIII', b'__text', b'__TEXT', 0x100004000, 64, 4096, 2, 0, 0, 0, 0, 0, 0)
    seg_cmd_size = 72 + len(section)
    segment = struct.pack('<II16sQQQQIIII', 0x19, seg_cmd_size, b'__TEXT', 0x100000000, 8192, 0, 4160, 7, 5, 1, 0) + section
    header = struct.pack('<IIIIIIII', 0xfeedfacf, 0x100000c, 0, 2, 1, len(segment), 0, 0)
    payload = bytearray(4160)
    payload[:len(header)] = header
    payload[len(header):len(header) + len(segment)] = segment
    payload[4096:4160] = b'\xc0\x03\x5f\xd6' * 16
    return bytes(payload)


class ReleaseOutput(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='rokbot-ios-release-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'demo.ipa'
        self.output = self.root / 'result'

    def refused(self, reason, patcher=PATCHER):
        before = self.source.read_bytes()
        result = subprocess.run([sys.executable, '-B', str(patcher), '--input', str(self.source),
                                 '--output', str(self.output)], capture_output=True, encoding='utf-8',
                                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(reason, result.stderr)
        self.assertEqual(self.source.read_bytes(), before)

    def app_metadata(self, version, build, identifier='co.anysphere.sand'):
        with zipfile.ZipFile(self.source, 'w') as archive:
            archive.writestr('Payload/Demo.app/Info.plist', plistlib.dumps({'CFBundleIdentifier': identifier,
                'CFBundleShortVersionString': version, 'CFBundleVersion': build, 'CFBundleExecutable': 'Demo'}))
            archive.writestr('Payload/Demo.app/Demo', b'synthetic, not an executable')

    def test_rejects_wrong_version_build_or_bundle_identifier_independently(self):
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        for version, build, identifier in [(pins['version'] + '.1', pins['build'], 'co.anysphere.sand'),
                                           (pins['version'], pins['build'] + '0', 'co.anysphere.sand'),
                                           (pins['version'], pins['build'], 'dev.fixture.demo')]:
            with self.subTest(version=version, build=build, identifier=identifier):
                self.app_metadata(version, build, identifier)
                self.refused('Unsupported app version')
                self.assertEqual(list(self.root.iterdir()), [self.source])
        self.app_metadata(pins['version'], pins['build'])
        self.refused('Expected thin arm64 executable')
        self.assertEqual(list(self.root.iterdir()), [self.source])

    def test_metadata_gate_and_help_follow_the_packaged_manifest(self):
        # Copy only the release scripts and manifest into an isolated package. No working
        # IPA, patch recipes or native library are supplied: the binary gate must still fail.
        package = self.root / 'fixture-package'
        patcher = package / 'release' / PATCHER.name
        patcher.parent.mkdir(parents=True)
        for name in (PATCHER.name, 'bytepatch.py', 'native_text.py'):
            shutil.copyfile(PATCHER.with_name(name), patcher.with_name(name))
        manifest = package / 'recipes' / 'ios' / 'manifest.json'
        manifest.parent.mkdir(parents=True)
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        pins.update(version='0.0.7', build='9001')
        manifest.write_text(json.dumps(pins), encoding='utf-8')
        self.app_metadata(pins['version'], pins['build'])
        self.refused('Expected thin arm64 executable', patcher)
        help_text = subprocess.check_output([sys.executable, '-B', str(patcher), '--help'], encoding='utf-8',
                                            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        self.assertIn('0.0.7 (9001)', help_text)
        self.assertEqual(set(self.root.iterdir()), {package, self.source})

    def test_invalid_archive_leaves_no_output(self):
        self.source.write_bytes(b'demo, not an archive')
        self.refused('not a zip file')
        self.assertEqual(list(self.root.iterdir()), [self.source])

    def test_unsupported_app_leaves_no_output(self):
        with zipfile.ZipFile(self.source, 'w') as archive:
            archive.writestr('Payload/Demo.app/Info.plist', plistlib.dumps({'CFBundleIdentifier': 'dev.fixture.demo'}))
        self.refused('Unsupported app version')
        self.assertEqual(list(self.root.iterdir()), [self.source])

    def test_existing_output_is_unchanged(self):
        self.source.write_bytes(b'demo')
        self.output.mkdir()
        previous = self.output / 'prior-build'
        previous.write_bytes(b'original')
        self.refused('Output exists')
        self.assertEqual(list(self.output.iterdir()), [previous])
        self.assertEqual(previous.read_bytes(), b'original')
        self.assertEqual(set(self.root.iterdir()), {self.source, self.output})

    def test_patch_app_rebrands_injects_dylib_and_wires_app_icons(self):
        pins = json.loads(MANIFEST.read_text(encoding='utf-8'))
        source_app = self.root / 'Demo.app'
        source_app.mkdir()
        (source_app / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': 'co.anysphere.sand',
            'CFBundleShortVersionString': pins['version'],
            'CFBundleVersion': pins['build'],
            'CFBundleExecutable': 'Demo',
            'CFBundleDisplayName': 'Grok Bot',
            'CFBundleIconName': 'AppIcon',
            'CFBundleIconFiles': ['AppIcon60x60'],
            'CFBundleIconFile': 'AppIcon.png',
            'GrokBotPresenceAppGroup': 'group.co.anysphere.sand',
        }))
        (source_app / 'Expo.plist').write_bytes(plistlib.dumps({'EXUpdatesEnabled': True, 'EXUpdatesURL': 'https://example.invalid/update'}))
        (source_app / 'Demo').write_bytes(synthetic_arm64_macho())
        (source_app / 'AppIcon60x60@2x.png').write_bytes(b'stale-icon')
        (source_app / 'Assets.car').write_bytes(b'RN_ASSETS_CAR')
        (source_app / 'main.jsbundle').write_bytes(b'original-hbc')

        dylib = self.root / 'RokBotLocal.dylib'
        dylib.write_bytes(b'synthetic-dylib')
        resources = self.root / 'resources'
        resources.mkdir()
        (resources / 'gateway-template.hbc').write_bytes(b'gateway-hbc')
        (resources / 'unpaired.hbc').write_bytes(b'unpaired-hbc')

        result = subprocess.run(
            [sys.executable, '-B', str(APP_PATCHER),
             '--source', str(source_app), '--output', str(self.output),
             '--dylib', str(dylib), '--resources', str(resources),
             '--unsigned', '--remove-extensions'],
            capture_output=True, encoding='utf-8',
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

        report = json.loads((self.output / 'patch-report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['schema'], 'rokbot-ios-app-patch/v1')
        self.assertEqual(report['bundleId'], 'dev.rokbot.local')
        self.assertTrue(report['dylibInjected'])
        self.assertFalse(report['expoUpdatesEnabled'])
        self.assertEqual(report['signing'], 'unsigned')

        ipa = self.output / 'RokBot-Local-resignable.ipa'
        self.assertTrue(ipa.is_file())
        patched_app = self.output / 'Payload' / 'Demo.app'
        self.assertTrue((patched_app / 'Frameworks' / 'RokBotLocal.dylib').is_file())
        self.assertFalse((patched_app / 'Frameworks' / 'GrokBotLocal.dylib').exists())
        self.assertTrue((patched_app / 'Frameworks' / 'RokBotLocal.bundle' / 'unpaired.hbc').is_file())
        self.assertEqual((patched_app / 'main.jsbundle').read_bytes(), b'unpaired-hbc')
        self.assertEqual((patched_app / 'Assets.car').read_bytes(), b'RN_ASSETS_CAR')
        self.assertFalse((patched_app / 'AppIcon60x60@2x.png').exists())

        info = plistlib.loads((patched_app / 'Info.plist').read_bytes())
        self.assertEqual(info['CFBundleIdentifier'], 'dev.rokbot.local')
        self.assertEqual(info['CFBundleDisplayName'], 'RokBot')
        self.assertEqual(info['CFBundleURLTypes'][0]['CFBundleURLSchemes'], ['rokbot-local', 'rblocal', 'rblocal-ios'])
        self.assertEqual(info['SandAppGroupIdentifier'], 'group.dev.rokbot.local')
        self.assertNotIn('GrokBotPresenceAppGroup', info)
        for legacy_key in ('CFBundleIconName', 'CFBundleIconFiles', 'CFBundleIconFile'):
            self.assertNotIn(legacy_key, info)
        self.assertEqual(info['CFBundleIcons'], {'CFBundlePrimaryIcon': {'CFBundleIconFiles': ['RokBotAppIcon60x60']}})
        self.assertEqual(info['CFBundleIcons~ipad'], {'CFBundlePrimaryIcon': {'CFBundleIconFiles': ['RokBotAppIcon60x60', 'RokBotAppIcon76x76', 'RokBotAppIcon83.5x83.5']}})

        expected_icons = {
            'RokBotAppIcon60x60@2x.png': 'AppIcon-120.png',
            'RokBotAppIcon60x60@3x.png': 'AppIcon-180.png',
            'RokBotAppIcon76x76@2x~ipad.png': 'AppIcon-152.png',
            'RokBotAppIcon83.5x83.5@2x~ipad.png': 'AppIcon-167.png',
            'RokBotAppIcon1024x1024.png': 'AppIcon-1024.png',
        }
        with zipfile.ZipFile(ipa) as z:
            names = set(z.namelist())
            for dst_name, src_name in expected_icons.items():
                expected_bytes = (ICON_DIR / src_name).read_bytes()
                self.assertEqual((patched_app / dst_name).read_bytes(), expected_bytes)
                self.assertIn(f'Payload/Demo.app/{dst_name}', names)
                self.assertEqual(z.read(f'Payload/Demo.app/{dst_name}'), expected_bytes)
            self.assertNotIn('Payload/Demo.app/AppIcon60x60@2x.png', names)
            self.assertIn('Payload/Demo.app/Assets.car', names)
            self.assertIn('Payload/Demo.app/Frameworks/RokBotLocal.dylib', names)
            self.assertIn('Payload/Demo.app/Frameworks/RokBotLocal.bundle/gateway-template.hbc', names)

        injected_exe = (patched_app / 'Demo').read_bytes()
        self.assertIn(b'@executable_path/Frameworks/RokBotLocal.dylib\0', injected_exe)


if __name__ == '__main__':
    unittest.main()
