"""暴力精确检索器(生产路径): 归一化 + 余弦 top-k + 布尔掩码过滤。

选型结论见 PLAN: 技能库 ≤1w 条, 1024 维暴力点积 ~0.1ms,
占端到端延迟的万分之一 → 不引入 ANN/向量数据库, 精确、简单、过滤友好。
"""

from __future__ import annotations

import numpy as np


def normalize(vecs: np.ndarray) -> np.ndarray:
    """行归一化。零向量保持为零(避免 NaN)。"""
    norms = np.linalg.norm(vecs, axis=-1, keepdims=True)
    return vecs / np.maximum(norms, 1e-12)


def topk(query: list[float], vecs: np.ndarray, k: int,
         mask: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """余弦相似度 top-k。

    query/vecs 可以未归一化——内部统一归一化, 相似度只看方向。
    mask: 与 vecs 等长的布尔数组, False 的条目不参与候选(精确过滤,
    如 tag 不匹配、成功率过低)。返回 (索引, 相似度), 按相似度降序,
    数量 ≤ min(k, 存活条数)。
    """
    q = normalize(np.asarray(query, dtype=np.float32))
    v = normalize(np.asarray(vecs, dtype=np.float32))
    scores = v @ q                                     # 归一化后点积即余弦
    if mask is not None:
        scores = np.where(mask, scores, -np.inf)
    k = min(k, int((scores > -np.inf).sum()))
    idx = np.argsort(-scores)[:k]
    return idx, scores[idx]
