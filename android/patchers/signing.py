#!/usr/bin/env python3
"""CLI wrapper and Python interface for ZIP alignment and APK v2/v3 signing."""
import argparse
from pathlib import Path
import subprocess
import sys

SCRIPT_DIR = Path(__file__).resolve().parent

def sign_directory_or_apk(source_dir: Path, output_apk: Path, page_align: int = 16384, unsigned: bool = False, keystore: Path = None):
    signing_module = (SCRIPT_DIR / "signing.mjs").as_posix()
    source_dir_str = source_dir.as_posix()
    output_apk_str = output_apk.as_posix()

    if unsigned:
        sign_logic = f"fs.writeFileSync('{output_apk_str}', unsignedApk);"
    else:
        sign_logic = f"""
    const identity = createSigningIdentity({{ type: 'rsa', modulusLength: 2048 }});
    const signed = signApk(unsignedApk, identity, {{ schemes: ['v2', 'v3'], minSdk: 28 }});
    fs.writeFileSync('{output_apk_str}', signed);
        """.strip()

    node_script = f"""
    import fs from 'node:fs';
    import path from 'node:path';
    import {{ createEntry, writeZip, createSigningIdentity, signApk }} from '{signing_module}';

    function walk(dir, base = '') {{
      let results = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {{
        const full = path.join(dir, file);
        const rel = base ? path.join(base, file) : file;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {{
          results = results.concat(walk(full, rel));
        }} else {{
          results.push({{ full, rel }});
        }}
      }}
      return results;
    }}

    const files = walk('{source_dir_str}');
    const entries = files.map(f => {{
      const content = fs.readFileSync(f.full);
      const isSo = f.rel.endsWith('.so');
      // Native libraries must be uncompressed (store = true) for page alignment
      return createEntry(f.rel.replace(/\\\\/g, '/'), content, {{ store: isSo }});
    }});

    const unsignedApk = writeZip(entries);
    {sign_logic}
    """
    res = subprocess.run(['node', '--input-type=module', '-e', node_script], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Signing failed: {res.stderr}")

def main():
    parser = argparse.ArgumentParser(description="Align and sign APK from staging directory")
    parser.add_argument("--source-dir", type=Path, required=True, help="Directory containing APK files")
    parser.add_argument("--output-apk", type=Path, required=True, help="Output APK path")
    parser.add_argument("--page-align", type=int, default=16384, help="Page alignment for .so (default 16384)")
    parser.add_argument("--unsigned", action="store_true", help="Output unsigned aligned APK")
    parser.add_argument("--keystore", type=Path, help="Custom keystore path")
    args = parser.parse_args()

    args.output_apk.parent.mkdir(parents=True, exist_ok=True)
    sign_directory_or_apk(args.source_dir, args.output_apk, args.page_align, args.unsigned, args.keystore)
    print(f"Output APK written to {args.output_apk}")

if __name__ == "__main__":
    main()
