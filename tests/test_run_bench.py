"""run_bench 测试: 检索质量(recall@k)与性能(QPS/构建时间)度量。

不依赖网络: 用 FakeEmbedder 跑质量指标; 性能指标直接测 brute.topk 的
矩阵运算(embedding 网络延迟在阶段 3 结论里单独说明, 不混进引擎耗时)。
"""

import sys
import time
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from bench.run_bench import (                            # noqa: E402
    build_matrix, eval_recall, time_queries,
)
from mc_skill_library.core.embedder import FakeEmbedder   # noqa: E402
from bench.dataset_gen import SKILL_POOL, build_eval_set  # noqa: E402


def _pool_with_embeddings(pool):
    emb = FakeEmbedder(dim=64)
    return [{**s, "embedding": emb.embed(f"{s['name']}: {s['description']}")}
            for s in pool]


def test_build_matrix_shape():
    pool = _pool_with_embeddings(SKILL_POOL)
    m = build_matrix(pool)
    assert m.shape == (len(SKILL_POOL), 64)
    assert m.dtype == np.float32


def test_eval_recall_self_query():
    """用技能自己的入库语料当 query → recall@1 应为 1.0(自己排第一)。
    入库语料 = "{name}: {description}"(与 core/semantic._EMBED_TEXT 一致)。"""
    pool = _pool_with_embeddings(SKILL_POOL)
    emb = FakeEmbedder(dim=64)
    evals = [{"query": f"{s['name']}: {s['description']}",
              "expected": s["name"], "kind": "rewrite"}
             for s in SKILL_POOL]
    r = eval_recall(evals, pool, emb, k=1)
    assert r["recall@1"] == 1.0
    assert r["n"] == len(SKILL_POOL)


def test_eval_recall_reports_both_kinds():
    pool = _pool_with_embeddings(SKILL_POOL)
    emb = FakeEmbedder(dim=64)
    evals = build_eval_set()
    r = eval_recall(evals, pool, emb, k=3)
    assert r["n"] == len(evals)
    assert 0.0 <= r["recall@k"] <= 1.0
    assert "hard_recall@k" in r            # hard case 单独成列


def test_time_queries_returns_qps():
    """性能度量: 返回 QPS 与平均延迟, 数值合理(>0)。"""
    rng = np.random.default_rng(7)
    vecs = rng.standard_normal((1000, 256), dtype=np.float32)
    queries = [rng.standard_normal(256).astype(np.float32).tolist()
               for _ in range(50)]
    stats = time_queries(queries, vecs, k=10)
    assert stats["n"] == 50
    assert stats["qps"] > 0
    assert 0 < stats["avg_ms"] < 1000      # 暴力检索应远低于 1s
