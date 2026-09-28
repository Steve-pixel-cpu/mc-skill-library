"""run_bench: 检索质量(recall@k)与引擎性能(QPS/内存)度量。

度量分离原则:
- 质量指标(eval_recall): query embedding × 库向量 → top-k 是否含期望技能
- 性能指标(time_queries): 只测 brute.topk 的纯矩阵运算耗时——
  embedding 是网络调用(50-300ms), 混进引擎耗时会让结论失真
"""

from __future__ import annotations

import time
from typing import Optional, Protocol

import numpy as np

from mc_skill_library.index.brute import topk


class _Embedder(Protocol):
    def embed(self, text: str) -> list[float]: ...


def build_matrix(pool: list[dict]) -> np.ndarray:
    """技能池(含 embedding 字段)→ (n, dim) float32 矩阵。"""
    return np.asarray([s["embedding"] for s in pool], dtype=np.float32)


def eval_recall(evals: list[dict], pool: list[dict], embedder: _Embedder,
                k: int = 3) -> dict:
    """质量指标: recall@k(总体 + hard case 单列)。

    query 语料 = "{name}: {description}"(与 core/semantic 入库语料一致),
    检索只做语义相似度, 不加统计加权——bench 测引擎, 不测 bandit。
    """
    matrix = build_matrix(pool)
    names = [s["name"] for s in pool]
    name_to_idx = {n: i for i, n in enumerate(names)}
    hits = hard_hits = hard_n = 0
    for e in evals:
        q = embedder.embed(e["query"])
        idx, _ = topk(q, matrix, k=k)
        ok = name_to_idx.get(e["expected"]) in set(idx.tolist())
        hits += ok
        if e["kind"] == "hard":
            hard_n += 1
            hard_hits += ok
    return {
        "n": len(evals),
        "k": k,
        "recall@1" if k == 1 else "recall@k": hits / max(1, len(evals)),
        "hard_recall@k": hard_hits / max(1, hard_n),
    }


def time_queries(queries: list[list[float]], vecs: np.ndarray,
                 k: int = 10, mask: Optional = None) -> dict:
    """性能指标: 纯 topk 耗时(不含 embedding)。返回 QPS 与平均延迟。"""
    t0 = time.perf_counter()
    for q in queries:
        topk(q, vecs, k=k, mask=mask)
    dt = time.perf_counter() - t0
    return {"n": len(queries), "qps": len(queries) / dt,
            "avg_ms": dt * 1000 / len(queries)}
