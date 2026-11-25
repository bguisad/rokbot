"""Preserve the shipped extensions and isolate their storage and app links."""
import hashlib
import plistlib
import re
import struct

EXTENSIONS_BY_RELEASE = {
    ('1.27.0', '29519'): {
        'Widgets.appex': ('widgets', 'f0099f0a76eaed154724f1ab4229d047e84a53a43a801186e274bdd40f62feb0'),
        'ImageShareExtension.appex': ('share', '799dc218e713251168c082ad2d2def4be22d033e0ac6172195e78af971d9a01a'),
        'NotificationService.appex': ('NotificationService', '3d1fc6db37862406cfda7e8fdf2007693f85de53ae531cea59dc1a8b090f4e22'),
    },
    ('1.26.0', '29388'): {
        'Widgets.appex': ('widgets', 'bb9293d61347ec69fc68b51319ee161e382ab985694296a4ffb21c566561cabd'),
        'ImageShareExtension.appex': ('share', '4fa14f55ba2300059a9bf7caf9b6ddc8cf30daa2713e0c4e4a4a10ed73eacbc6'),
        'NotificationService.appex': ('NotificationService', '72ccc1ee5c3e80bdcc45a551306ae0a8dc8355b0368fdeadc74022cf0098cbfd'),
    },
    ('1.16.0', '23152'): {
        'Widgets.appex': ('widgets', '5b0d5f5f4453f17f5f10cc3ecd78fc7a484f16de314191d725ed8342c4ca1682'),
        'ImageShareExtension.appex': ('share', '6d178828c60621193dabf9b5235af1ee2f28936995aa34f34bb0f1f9b122fb6c'),
        'NotificationService.appex': ('NotificationService', '54edfb6a5eea656681caf5056fc6f510351cd67579ad1e4c158942babd0bf49d'),
    },
}

WIDGETS_SCHEME_COUNTS_BY_RELEASE = {
    ('1.27.0', '29519'): 2,
    ('1.26.0', '29388'): 1,
    ('1.16.0', '23152'): 1,
}

EXTENSIONS = EXTENSIONS_BY_RELEASE[('1.27.0', '29519')]

# The widget embeds its deep-link scheme as four back-to-back MOV-wide
# immediates spelling "grokbot\0". Locate that exact sequence and replace with "rblocal\0".
WIDGETS_SCHEME_IMMEDIATES = (0x7267, 0x6B6F, 0x6F62, 0x0074)
WIDGETS_SCHEME_PARTS = (0x6272, 0x6F6C, 0x6163, 0x006C)


def scheme_sites(data, start, length):
    found = []
    for index in range(start, start + length - 16, 4):
        values = struct.unpack_from('<4I', data, index)
        if tuple((value >> 5) & 0xFFFF for value in values) == WIDGETS_SCHEME_IMMEDIATES:
            found.append(index)
    return found


def identifier(value):
    if not re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', value):
        raise ValueError('Invalid bundle or App Group identifier')
    return value


def text_section(data, commands):
    for command, offset, size in commands(data):
        if command in (0x21, 0x2c) and struct.unpack_from('<I', data, offset + 16)[0]:
            raise ValueError('Extensions must also be decrypted; use --remove-extensions only to explicitly omit them')
        if command == 0x19:
            for index in range(struct.unpack_from('<I', data, offset + 64)[0]):
                section = offset + 72 + 80 * index
                if data[section:section + 16].rstrip(b'\0') == b'__text':
                    length = struct.unpack_from('<Q', data, section + 40)[0]
                    start = struct.unpack_from('<I', data, section + 48)[0]
                    result = (start, length)
    if 'result' not in locals():
        raise ValueError('Extension has no text section')
    return result


def rebrand_info_strings(bundle, display_name):
    for strings_path in sorted(bundle.glob('*.lproj/InfoPlist.strings')):
        if not strings_path.is_file():
            continue
        try:
            strings = plistlib.loads(strings_path.read_bytes())
        except (plistlib.InvalidFileException, ValueError, OSError):
            continue
        if not isinstance(strings, dict):
            continue
        changed = False
        for key in ('CFBundleDisplayName', 'CFBundleName'):
            if key in strings and strings[key] != display_name:
                strings[key] = display_name
                changed = True
        for key, value in list(strings.items()):
            if key.startswith('NS') and key.endswith('UsageDescription') and isinstance(value, str):
                updated = value.replace('Grok Bot', display_name).replace('GrokBot', display_name)
                if updated != value:
                    strings[key] = updated
                    changed = True
        if changed:
            strings_path.write_bytes(plistlib.dumps(strings, fmt=plistlib.FMT_BINARY))


def prepare_extensions(app, bundle_id, group, commands, display_name='RokBot', release=None):
    expected_map = EXTENSIONS if release is None else EXTENSIONS_BY_RELEASE.get(tuple(release))
    if expected_map is None:
        raise ValueError('Unsupported release for extensions: ' + repr(release))
    plugins = app / 'PlugIns'
    if not plugins.exists():
        raise ValueError('Missing original extensions; provide the complete IPA or explicitly use --remove-extensions')
    if {p.name for p in plugins.iterdir()} != set(expected_map):
        raise ValueError('Expected all three original extensions')
    records = []
    for name, (suffix, expected) in expected_map.items():
        extension = plugins / name
        info = plistlib.loads((extension / 'Info.plist').read_bytes())
        if info['CFBundleIdentifier'] != 'co.anysphere.sand.' + suffix:
            raise ValueError('Unexpected extension bundle ID: ' + name)
        executable = info['CFBundleExecutable']
        if '/' in executable or executable in ('.', '..'):
            raise ValueError('Invalid extension executable')
        path = extension / executable
        data = bytearray(path.read_bytes())
        start, length = text_section(data, commands)
        if hashlib.sha256(data[start:start + length]).hexdigest() != expected:
            raise ValueError('Unsupported original extension: ' + name)
        if name == 'Widgets.appex':
            release_key = tuple(release) if release is not None else ('1.27.0', '29519')
            if release_key not in WIDGETS_SCHEME_COUNTS_BY_RELEASE:
                raise ValueError('Unsupported release for widget scheme patching: ' + repr(release_key))
            expected_sites = WIDGETS_SCHEME_COUNTS_BY_RELEASE[release_key]
            offsets = scheme_sites(data, start, length)
            if len(offsets) != expected_sites:
                raise ValueError(
                    'Expected %d widget scheme construction(s), found %d'
                    % (expected_sites, len(offsets))
                )
            for offset in offsets:
                for index, part in enumerate(WIDGETS_SCHEME_PARTS):
                    instruction = struct.unpack_from('<I', data, offset + index * 4)[0]
                    instruction = (instruction & ~(0xffff << 5)) | (part << 5)
                    struct.pack_into('<I', data, offset + index * 4, instruction)
        elif name == 'ImageShareExtension.appex':
            if data.count(b'sand-mobile\0') != 1:
                raise ValueError('Unexpected original share URL scheme')
            data = data.replace(b'sand-mobile\0', b'rblocal-ios\0')
        path.write_bytes(data)
        info['CFBundleIdentifier'] = bundle_id + '.' + suffix
        info['CFBundleName'] = display_name
        info['CFBundleDisplayName'] = display_name
        info['SandAppGroupIdentifier'] = group
        if isinstance(info.get('GrokAppProtection'), dict):
            info['GrokAppProtection'] = {
                **info['GrokAppProtection'],
                'appGroupIdentifiers': [group],
                'keychainAccessGroups': [],
            }
        info.pop('UISupportedDevices', None)
        (extension / 'Info.plist').write_bytes(plistlib.dumps(info))
        rebrand_info_strings(extension, display_name)
        records.append({'name': name, 'bundleId': info['CFBundleIdentifier'],
                        'sourceTextSha256': expected, 'appGroup': group})
    return records
