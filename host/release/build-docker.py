#!/usr/bin/env python3
"""Build a local Host image from project patches and user-owned original resources."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from bytepatch import file_digest
from platforms import BOX as BOX_SPEC, INPUTS, check_box_execution, docker_platform

ROOT = Path(__file__).resolve().parents[1]
BOX = BOX_SPEC['repository'] + '@' + BOX_SPEC['manifestDigest']
BOX_ID = BOX_SPEC['configDigest']
BOX_MANIFEST = BOX.split('@', 1)[1]
# The classic image store reports the config digest as the image ID; the containerd
# image store (default on new Docker 29+ installs) reports the pinned manifest digest.
BOX_IDENTITIES = {BOX_ID, BOX_MANIFEST}
BOX_TAG = BOX_SPEC['localTag']


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def image_id(reference):
    probe = subprocess.run(['docker', 'image', 'inspect', reference, '--format', '{{.Id}}'], capture_output=True, text=True)
    return probe.stdout.strip() if probe.returncode == 0 else None


def load_verified_archive(path):
    """Verify a docker-save archive by its config digest, independent of the Docker image store."""
    with tarfile.open(path, 'r:*') as archive:
        names = {member.name.lstrip('./'): member for member in archive}
        entries = json.load(archive.extractfile(names['manifest.json']))
        if len(entries) != 1:
            raise ValueError('Box archive must contain exactly one image')
        config = archive.extractfile(names[entries[0]['Config'].lstrip('./')]).read()
    if 'sha256:' + hashlib.sha256(config).hexdigest() != BOX_ID:
        raise ValueError('Unsupported Box archive identity')
    loaded = subprocess.run(['docker', 'load', '-i', str(path)], check=True, capture_output=True, text=True).stdout
    match = re.search(r'Loaded image(?: ID)?: (\S+)', loaded)
    if not match:
        raise ValueError('Docker did not report the loaded Box image')
    return match.group(1)


def prepare_box(box_archive):
    if box_archive:
        source = load_verified_archive(box_archive.resolve())
        run('docker', 'tag', source, BOX_TAG)
        return BOX_ID
    mirror_ref = (os.environ.get('ROKBOT_BOX_IMAGE') or os.environ.get('GROKBOT_BOX_IMAGE') or '').strip()
    candidates = (*( [mirror_ref] if mirror_ref else () ), BOX, BOX_TAG, BOX_ID)
    source = next((ref for ref in candidates if image_id(ref) in BOX_IDENTITIES), None)
    if not source:
        pull_ref = mirror_ref or BOX
        run('docker', 'pull', '--platform', BOX_SPEC['platform'], pull_ref)
        source = pull_ref
    identity = image_id(source)
    if identity not in BOX_IDENTITIES:
        raise ValueError('Unsupported Box image identity')
    run('docker', 'tag', source, BOX_TAG)
    return identity


def web_bundle(target, bundle=None, source=None):
    """Put the web client bundle for the image in target/web.zip; return its SHA-256 or None.

    The bundle carries the official interface from the administrator's own installer, so it only
    goes into this local-only image when asked for; never push such an image to a public registry.
    """
    target.mkdir()
    if source:
        patcher = ROOT.parent / 'web/patchers/patch.mjs'
        node = shutil.which('node')
        if not patcher.is_file():
            raise ValueError('--web-source needs the full repository (web/patchers/patch.mjs); use --web-bundle with a ready ZIP.')
        if not node:
            raise ValueError('--web-source needs Node.js 22.12+ to run web/patchers/patch.mjs.')
        output = target.parent / 'web-output'
        run(node, str(patcher), '--source', str(source.resolve(strict=True)), '--output', str(output), '--force',
            stdout=subprocess.DEVNULL)
        built = sorted(output.glob('RokBotLocal-web-*.zip'))
        if len(built) != 1:
            raise ValueError('web/patchers/patch.mjs did not produce exactly one bundle')
        bundle = built[0]
    if not bundle:
        return None
    bundle = bundle.resolve(strict=True)
    if not zipfile.is_zipfile(bundle) or 'web-bundle.json' not in zipfile.ZipFile(bundle).namelist():
        raise ValueError('Not a web client bundle from web/patchers/patch.mjs: ' + str(bundle))
    shutil.copy2(bundle, target / 'web.zip')
    if source:
        shutil.rmtree(bundle.parent)  # keep the build context to inputs/ and web/
    return file_digest(target / 'web.zip')


def choose_runtime(platform, host_only):
    if platform == 'linux/arm64':
        return 'rokbot-arm-runtime:local', not host_only
    return BOX_TAG, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host-archive', type=Path)
    parser.add_argument('--box-archive', type=Path, help='Optional original docker-save tar or tar.gz')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--box-only', action='store_true', help='Prepare only the verified desktop')
    modes.add_argument('--host-only', action='store_true', help='Build a Host for a separate execution node')
    parser.add_argument('--image', default='rokbot-host:local')
    parser.add_argument('--base-image', default='rokbot-patch-base:local')
    web = parser.add_mutually_exclusive_group()
    web.add_argument('--web-source', type=Path,
                     help='Official Grok_Bot_1.2.3_Setup.exe: build the web client bundle into this local-only image')
    web.add_argument('--web-bundle', type=Path, help='A bundle ZIP from web/patchers/patch.mjs to build into this local-only image')
    args = parser.parse_args()
    manifest = INPUTS
    started = time.monotonic()
    platform = docker_platform()
    arm = platform == 'linux/arm64'
    if arm and args.host_only and args.box_archive:
        raise ValueError('ARM host-only mode does not use a desktop archive.')
    if not args.host_only:
        check_box_execution(platform)
    runtime_image, needs_box = choose_runtime(platform, args.host_only)
    identity = prepare_box(args.box_archive) if needs_box else None
    box_image = BOX_TAG if identity else None
    if args.box_only:
        print(json.dumps({'boxImage': box_image, 'originalImageId': identity, 'inputSeconds': round(time.monotonic()-started, 3)}))
        return
    with tempfile.TemporaryDirectory(prefix='rokbot-build-') as temporary:
        work = Path(temporary)
        archive = args.host_archive
        if not archive:
            archive = work / 'host.tgz'
            archive_url = os.environ.get('ROKBOT_HOST_ARCHIVE_URL') or os.environ.get('GROKBOT_HOST_ARCHIVE_URL') or manifest['archive']['url']
            with urllib.request.urlopen(archive_url, timeout=60) as response, archive.open('wb') as target:
                shutil.copyfileobj(response, target)
        if file_digest(archive) != manifest['archive']['sha256']:
            raise ValueError('Unsupported Host archive SHA-256')
        input_seconds = time.monotonic()-started
        run('docker', 'build', '--platform', platform, '-f', str(ROOT / 'release/Dockerfile.base'), '-t', args.base_image, str(ROOT))
        if arm:
            run('docker', 'build', '--platform', platform, '-f', str(ROOT / 'release/Dockerfile.arm-runtime'),
                '-t', runtime_image, str(ROOT))
        base_seconds = time.monotonic()-started-input_seconds
        (work / 'inputs').mkdir()
        shutil.copy2(archive, work / 'inputs/host.tgz')
        web_sha256 = web_bundle(work / 'web', args.web_bundle, args.web_source)
        run('docker', 'build', '--platform', platform, '-f', str(ROOT / 'release/Dockerfile.host'),
            '--build-arg', f'PATCH_IMAGE={args.base_image}', '--build-arg', f'RUNTIME_IMAGE={runtime_image}',
            '--build-arg', f'HOST_REVISION={manifest["archive"]["version"]}',
            '--build-arg', f'WEB_BUNDLE_SHA256={web_sha256 or ""}', '-t', args.image, str(work))
    print(json.dumps({'image': args.image, 'platform': platform, 'boxImage': box_image, 'inputSeconds': round(input_seconds, 3),
        'baseBuildSeconds': round(base_seconds, 3), 'finalBuildSeconds': round(time.monotonic()-started-input_seconds-base_seconds, 3),
        'originalImageId': identity, 'webBundleSha256': web_sha256, 'distribution': 'local-only'}))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from error
