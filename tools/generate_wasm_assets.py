#!/usr/bin/env python3
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

INCBIN = re.compile(r"INCBIN_[A-Z0-9]+\(([^)]*)\)", re.DOTALL)


def find_incbins():
    incbins = set()
    for ext in ("src/**/*.c", "include/**/*.h", "src/**/*.h"):
        for path in ROOT.glob(ext):
            try:
                text = path.read_text(errors="ignore")
                for match in INCBIN.finditer(text):
                    for item in re.findall(r'"([^"]+)"', match.group(1)):
                        incbins.add(item)
            except Exception:
                pass
    return sorted(incbins)


def build_targets(targets):
    missing = [t for t in targets if not (ROOT / t).exists()]
    if not missing:
        print("All assets up to date.")
        return

    print(f"Generating {len(missing)} assets in batches...")
    batch_size = 80
    env = {k: v for k, v in os.environ.items() if k not in ("MAKEFLAGS", "MFLAGS")}

    for i in range(0, len(missing), batch_size):
        batch = missing[i : i + batch_size]
        print(f"Batch {i // batch_size + 1}/{(len(missing) + batch_size - 1) // batch_size} ({len(batch)} items)...")
        subprocess.run(["make", "-j8", "NODEP=1", *batch], cwd=str(ROOT), check=True, env=env)


def main():
    targets = find_incbins()
    print(f"Found {len(targets)} total INCBIN references.")
    build_targets(targets)
    print("Asset generation complete.")


if __name__ == "__main__":
    main()
