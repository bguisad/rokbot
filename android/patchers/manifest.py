#!/usr/bin/env python3
"""CLI wrapper and Python interface for manifest patching."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

SCRIPT_DIR = Path(__file__).resolve().parent

def patch_manifest(input_path: Path, output_path: Path, manifest_pin: Path = None):
    # Delegate to manifest.mjs
    node_script = f"""
    import fs from 'node:fs';
    import {{ patchManifest }} from '{SCRIPT_DIR / "manifest.mjs"}';
    const input = fs.readFileSync('{input_path}');
    let options = {{}};
    {f"const pin = JSON.parse(fs.readFileSync('{manifest_pin}', 'utf8')); options.permissions = pin.permissions;" if manifest_pin and manifest_pin.exists() else ""}
    const patched = patchManifest(input, options);
    fs.writeFileSync('{output_path}', patched);
    """
    res = subprocess.run(['node', '--input-type=module', '-e', node_script], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Manifest patch failed: {res.stderr}")

def main():
    parser = argparse.ArgumentParser(description="Patch AndroidManifest.xml binary AXML")
    parser.add_argument("--input", type=Path, required=True, help="Input AndroidManifest.xml")
    parser.add_argument("--output", type=Path, required=True, help="Output AndroidManifest.xml")
    parser.add_argument("--manifest-pin", type=Path, help="Path to manifest.json pinning file")
    args = parser.parse_args()

    patch_manifest(args.input, args.output, args.manifest_pin)
    print(f"Patched manifest written to {args.output}")

if __name__ == "__main__":
    main()
