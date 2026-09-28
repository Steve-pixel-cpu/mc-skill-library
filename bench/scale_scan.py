"""规模扫描 CLI: python -m bench.scale_scan

合成库 1k/1w/10w, 向量用确定性伪随机(与 FakeEmbedder 同级假设:
bench 测的是**检索引擎**, 不是 embedding 模型)。
输出: 各规模的构建时间 / top-10 QPS / 平均延迟 / 内存, Markdown 表。
"""

from __future__ import annotations

import time

import numpy as np

from mc_skill_library.index.brute import topk

SCALES = [1_000, 10_000, 100_000]
DIM = 1024
N_QUERIES = 200
K = 10


def run(scale: int, dim: int = DIM) -> dict:
    rng = np.random.default_rng(scale)
    vecs = rng.standard_normal((scale, dim), dtype=np.float32)
    queries = [rng.standard_normal(dim, dtype=np.float32).tolist()
               for _ in range(N_QUERIES)]
    t0 = time.perf_counter()
    for q in queries:
        topk(q, vecs, k=K)
    dt = time.perf_counter() - t0
    return {
        "scale": scale, "dim": dim,
        "mem_mb": vecs.nbytes / 1024 / 1024,
        "qps": N_QUERIES / dt,
        "avg_ms": dt * 1000 / N_QUERIES,
    }


def main() -> None:
    print(f"| 规模 | 维度 | 内存(MB) | top-{K} QPS | 平均延迟(ms) |")
    print("|---|---|---|---|---|")
    for s in SCALES:
        r = run(s)
        print(f"| {r['scale']:,} | {r['dim']} | {r['mem_mb']:.1f} "
              f"| {r['qps']:,.0f} | {r['avg_ms']:.2f} |")


if __name__ == "__main__":
    main()
