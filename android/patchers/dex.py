#!/usr/bin/env python3
"""MultiDex merger & companion Dex injector for target Android APK."""
import argparse
from pathlib import Path
import re
import shutil
import sys

def get_next_dex_name(filenames):
    dex_pattern = re.compile(r"^classes(\d*)\.dex$")
    max_index = 0
    for name in filenames:
        m = dex_pattern.match(Path(name).name)
        if m:
            idx_str = m.group(1)
            idx = 1 if idx_str == "" else int(idx_str)
            if idx > max_index:
                max_index = idx
    next_index = 1 if max_index == 0 else max_index + 1
    return "classes.dex" if next_index == 1 else f"classes{next_index}.dex"

def inject_dex_to_dir(apk_dir: Path, companion_dex: Path):
    if not companion_dex.is_file():
        raise FileNotFoundError(f"Companion DEX not found: {companion_dex}")
    content = companion_dex.read_bytes()
    if content[:4] != b"dex\n":
        raise ValueError(f"Invalid DEX magic in {companion_dex}")

    existing_files = [p.name for p in apk_dir.glob("classes*.dex")]
    target_name = get_next_dex_name(existing_files)
    dest = apk_dir / target_name
    shutil.copy2(companion_dex, dest)
    return target_name

def main():
    parser = argparse.ArgumentParser(description="Inject companion DEX into APK staging directory")
    parser.add_argument("--apk-dir", type=Path, required=True, help="Directory containing unpacked APK files")
    parser.add_argument("--companion-dex", type=Path, required=True, help="Path to companion dex file")
    args = parser.parse_args()

    injected = inject_dex_to_dir(args.apk_dir, args.companion_dex)
    print(f"Injected companion DEX as {injected}")

if __name__ == "__main__":
    main()
