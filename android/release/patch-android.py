#!/usr/bin/env python3
"""Standalone Native Android Client Patcher CLI for RokBot (official ai.x.grok.bot 1.16.0)."""
import os
from pathlib import Path
import subprocess
import sys

SCRIPT_DIR = Path(__file__).resolve().parent
MJS_ENTRY = SCRIPT_DIR / "patch-android.mjs"

def main():
    if not MJS_ENTRY.is_file():
        sys.stderr.write(f"Error: {MJS_ENTRY} not found\n")
        sys.exit(1)

    cmd = ["node", str(MJS_ENTRY)] + sys.argv[1:]
    proc = subprocess.run(cmd)
    sys.exit(proc.returncode)

if __name__ == "__main__":
    main()
