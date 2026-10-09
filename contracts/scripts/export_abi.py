#!/usr/bin/env python3
"""Generate browser ABIs from Solidity. --check verifies committed artifacts."""
import argparse
import json
import os
from pathlib import Path
import subprocess

CONTRACTS = Path(__file__).resolve().parents[1]
DEFAULT_OUT = CONTRACTS.parent / 'frontend' / 'abi'
# (source path relative to contracts/src, contract name) → frontend/abi/<name>.json
TARGETS = (
    ('modules/ModuleFactory.sol', 'ModuleFactory'),
    ('modules/NeuromModule.sol', 'NeuromModule'),
    ('modules/Roles.sol', 'Roles'),
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--forge', default=os.environ.get('FORGE', 'forge'))
    args = parser.parse_args()
    for source, name in TARGETS:
        result = subprocess.run(
            [args.forge, 'inspect', f'src/{source}:{name}', 'abi', '--json'],
            cwd=CONTRACTS, capture_output=True, text=True,
        )
        if result.returncode:
            raise SystemExit(result.stderr or result.stdout)
        content = json.dumps(json.loads(result.stdout), indent=2, sort_keys=True) + '\n'
        destination = args.out / f'{name}.json'
        if args.check:
            if not destination.exists() or destination.read_text(encoding='utf-8') != content:
                raise SystemExit(f'{destination} is stale; run npm run abi')
            print(f'current: {destination.name}')
        else:
            args.out.mkdir(parents=True, exist_ok=True)
            destination.write_text(content, encoding='utf-8')
            print(f'wrote {destination.name}')


if __name__ == '__main__':
    main()
