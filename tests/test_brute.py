"""brute 检索器的单元测试: 余弦 top-k / 归一化 / 布尔掩码过滤。

设计意图(与 PLAN 对齐):
- 向量入库前归一化 → 余弦相似度退化为点积, ~0.1ms 级
- mask 过滤是精确的布尔掩码(类型/成功率), 在相似度计算**之前**做
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))

from mc_skill_library.index.brute import topk   # noqa: E402


def _norm(v):
    return (np.asarray(v, dtype=np.float32) /
            np.linalg.norm(v)).tolist()


def test_topk_ranking_by_cosine():
    # 查询与第 2 条同向(相似度 1.0), 与第 1 条正交(0.0), 第 3 条反向(-1.0)
    query = _norm([1.0, 0.0])
    vecs = np.array([_norm([0.0, 1.0]),
                     _norm([2.0, 0.0]),
                     _norm([-1.0, 0.0])], dtype=np.float32)
    idx, scores = topk(query, vecs, k=3)
    assert idx[0] == 1 and scores[0] == pytest_approx(1.0)
    assert idx[1] == 0 and scores[1] == pytest_approx(0.0)
    assert idx[2] == 2 and scores[2] == pytest_approx(-1.0)


def test_topk_ignores_vector_magnitude():
    # 未归一化的库向量: 相似度只看方向
    query = _norm([3.0, 4.0])
    vecs = np.array([[6.0, 8.0], [0.0, 1.0]], dtype=np.float32)
    idx, scores = topk(query, vecs, k=1)
    assert idx[0] == 0 and scores[0] == pytest_approx(1.0)


def test_topk_mask_excludes_entries():
    query = _norm([1.0, 0.0])
    vecs = np.array([_norm([1.0, 0.0]), _norm([1.0, 0.0])],
                    dtype=np.float32)
    mask = np.array([False, True])          # 第 1 条被过滤(如成功率过低)
    idx, _ = topk(query, vecs, k=5, mask=mask)
    assert list(idx) == [1]                 # k 超过可用量时只返回存活的


def test_topk_k_larger_than_pool():
    query = [1.0, 0.0]
    vecs = np.array([_norm([1.0, 0.0])], dtype=np.float32)
    idx, scores = topk(query, vecs, k=10)
    assert list(idx) == [0] and len(scores) == 1


def pytest_approx(expected, tol=1e-5):
    class _Approx:
        def __eq__(self, other):
            return abs(other - expected) < tol

        def __repr__(self):
            return f"~{expected}"
    return _Approx()
