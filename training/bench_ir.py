"""Micro-benchmark (not a test): replay the grid-step program exported by `node frontend/ir/bench.mjs` batched.

    ~/.cache/neurom-venv/bin/python training/bench_ir.py [batch ...]

Reports lanes/s per batch size (one lane = one env step of one episode).
"""
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ir  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[1] / 'frontend/ir/fixtures/bench-grid.json'


def main(batches):
    fx = json.loads(FIXTURE.read_text())
    program, types = fx['program'], fx['paramTypes']
    compiled = ir.compile(program, types, exact=True)
    state_t, params_t = types[0], types[2]
    print(f"grid step: {sum(1 + len(n.get('body', {}).get('nodes', [])) for n in program['nodes'])} nodes, static cost {compiled.cost}")
    for B in batches:
        states = [fx['states'][i % len(fx['states'])] for i in range(B)]
        state = ir.to_batch(state_t, states)
        params = ir.to_batch(params_t, [fx['params']] * B)
        action = np.arange(B, dtype=np.float64) % 5
        for _ in range(3): state = compiled.run([state, action, params], B)['state']  # warm-up
        state = ir.to_batch(state_t, states)
        steps, start = 0, time.perf_counter()
        while time.perf_counter() - start < 2.0:
            out = compiled.run([state, (action + steps) % 5, params], B)
            state = out['state']
            steps += 1
        elapsed = time.perf_counter() - start
        print(f'Python B={B}: {steps} batched steps in {elapsed:.2f} s → {steps / elapsed:.1f} steps/s, {B * steps / elapsed:,.0f} lanes/s')


if __name__ == '__main__':
    main([int(a) for a in sys.argv[1:]] or [1, 64, 1024, 8192])
