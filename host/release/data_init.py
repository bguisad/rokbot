#!/usr/bin/env python3
"""Create the Host data trees that the execution desktop is allowed to see."""
import argparse
import json
import os
from pathlib import Path
import sys

from backup import DATA_TREES

UID = 1000
GID = 1000
MODE = 0o750


def metadata(path, *, uid=UID, gid=GID, mode=MODE):
    if os.name == 'posix':
        os.chown(path, uid, gid, follow_symlinks=False)
        if not path.is_symlink():
            path.chmod(mode)


def ensure_directory(path, *, trusted_root=Path('/data'), uid=UID, gid=GID, mode=MODE):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Host data path must be an absolute path without parent traversal.')
    trusted_root = Path(trusted_root)
    if not path.is_relative_to(trusted_root):
        raise ValueError(f'Host data path must stay below {trusted_root}.')
    current = trusted_root
    created = False
    for part in path.relative_to(trusted_root).parts:
        current /= part
        try:
            current.lstat()
        except FileNotFoundError:
            current.mkdir(mode=mode)
            metadata(current, uid=uid, gid=gid, mode=mode)
            created = True
            continue
        if current.is_symlink():
            raise ValueError(f'Host data path contains a symlink: {current}')
        if not current.is_dir():
            raise ValueError(f'Host data path is not a directory: {current}')
    return created


def initialise(host_data, *, trusted_root=Path('/data'), uid=UID, gid=GID, mode=MODE):
    host_data = Path(host_data)
    root_created = ensure_directory(host_data, trusted_root=trusted_root, uid=uid, gid=gid, mode=mode)
    created = []
    for tree in DATA_TREES:
        path = host_data / tree
        if path.exists() and not path.is_dir():
            raise ValueError(f'Host data tree is not a directory: {path}')
        if path.is_symlink():
            raise ValueError(f'Host data tree is a symlink: {path}')
        if not path.exists():
            path.mkdir(mode=mode)
            metadata(path, uid=uid, gid=gid, mode=mode)
            created.append(tree)
    return {'rootCreated': root_created, 'created': created}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('host_data', nargs='?', default='/data/runtime/host-data', type=Path)
    args = parser.parse_args(argv)
    print(json.dumps(initialise(args.host_data)))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from error
