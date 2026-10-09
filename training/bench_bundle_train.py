#!/usr/bin/env python3
"""Time the epochs of a trainer bundle in the Python trainer (bundle_train.py over bundle_env.py + bundle_loop.py).

    python3 training/bench_bundle_train.py BUNDLE.json [--epochs 5] [--profile]

Prints the seconds of each epoch (training only, without validation). --profile adds the top of a cProfile by cumulative time.
"""
import argparse, cProfile, json, os, pstats, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bundle_train as bt  # noqa: E402


def bundle_epochs(bundle, epochs, profile):
    b = json.loads(json.dumps(bundle))
    b['recipe'].update({'epochs': epochs, 'evalEvery': 100000})
    s = bt.Session(b, None)
    run = bt.Run(epochs, None, None)
    times = []
    orig = bt._evaluate

    def timed_evaluate(s_, run_, model, epoch, best, curves, evaluations, **kw):   # epoch boundary hook: record wall time per epoch
        times.append(time.perf_counter())
        return orig(s_, run_, model, epoch, best, curves, evaluations, **kw)
    bt._evaluate = timed_evaluate
    pr = cProfile.Profile() if profile else None
    try:
        t0 = time.perf_counter()
        if pr: pr.enable()
        bt.TRAINERS[b['recipe']['method']](s, run, None)
        if pr: pr.disable()
    finally: bt._evaluate = orig
    setup = times[0] - t0
    per_epoch = [(times[i] - times[i - 1]) for i in range(1, len(times))]
    print(f"bundle: setup+epoch1 {setup:.3f}s, epochs 2..{epochs}: {' '.join(f'{x:.3f}' for x in per_epoch)} s → mean {sum(per_epoch) / max(1, len(per_epoch)):.3f} s/epoch "
          f"(B={s.recipe['episodesPerEpoch'] * s.recipe['replicas']}, budget {s.env.budget})")
    if pr: pstats.Stats(pr).sort_stats('cumulative').print_stats(20)
    return per_epoch


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('bundle'); ap.add_argument('--epochs', type=int, default=5); ap.add_argument('--profile', action='store_true')
    a = ap.parse_args()
    with open(a.bundle) as f: bundle = json.load(f)
    bundle_epochs(bundle, a.epochs, a.profile)


if __name__ == '__main__':
    main()
