"""语义检索管线: Embedder + 向量缓存 + brute top-k + 统计加权。

数据流:
  skill_save   → store.save 后 ensure_vectors: 缺向量的技能批量 embed,
                 向量写回 library.jsonl(持久缓存, 重启零重算)
  skill_search → 查询 embed 1 次 + 缓存向量矩阵暴力点积 + tag 掩码
                 + 统计加权(与关键词版共用同一公式)

降级: embedder 抛 EmbeddingError 时回落关键词检索(core/search.py),
检索质量降级但服务不中断。
"""

from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..core.embedder import Embedder, EmbeddingError
from ..index.brute import topk
from ..search import search as keyword_search
from ..store import SkillStore

_EMBED_TEXT = "{name}: {description}"       # 入库向量化的语料


class SemanticSearch:

    def __init__(self, store: SkillStore, embedder: Embedder):
        self.store = store
        self.embedder = embedder
        self._names: list[str] = []           # 与矩阵行对齐的技能名
        self._matrix: Optional[np.ndarray] = None
        self.rebuild()

    # ── 缓存管理 ─────────────────────────────────────────
    def rebuild(self) -> None:
        """全量加载: 有缓存向量的直接用, 缺的批量补算并写回库。

        embedder 故障(如 API 不可达)时不抛——矩阵留空,
        search() 会降级关键词检索; 下次 rebuild 再补算。
        """
        records = self.store.list_all()
        missing = [r for r in records if not r.get("embedding")]
        if missing:
            try:
                vecs = self.embedder.embed_batch(
                    [_EMBED_TEXT.format(name=r["name"],
                                        description=r["description"])
                     for r in missing])
                for r, v in zip(missing, vecs):
                    r["embedding"] = v
                self.store.update_embeddings(
                    {r["name"]: r["embedding"] for r in missing})
            except EmbeddingError:
                missing = []                    # 补算失败, 降级由 search 兜
        ready = [r for r in records if r.get("embedding")]
        self._names = [r["name"] for r in ready]
        self._matrix = (np.asarray([r["embedding"] for r in ready],
                                   dtype=np.float32)
                        if ready else None)

    def invalidate(self) -> None:
        """库变了(save 后)调用——下次检索前重算缺失向量。"""
        self.rebuild()

    # ── 检索 ────────────────────────────────────────────
    def search(self, query: str, top_k: int = 5,
               tag: Optional[str] = None) -> list[dict]:
        """语义检索 + 统计加权; embedder 故障时降级关键词检索。"""
        if self._matrix is not None and len(self._names):
            try:
                return self._search_semantic(query, top_k, tag)
            except EmbeddingError:
                pass                            # 降级, 不中断
        return keyword_search(self.store, query, top_k=top_k, tag=tag)

    def _search_semantic(self, query: str, top_k: int,
                         tag: Optional[str]) -> list[dict]:
        records = {r["name"]: r for r in self.store.list_all()}
        mask = None
        if tag:
            mask = np.asarray(
                [tag in records[n].get("tags", []) for n in self._names])
        q = self.embedder.embed(query)          # 只 embed 查询 1 次
        idx, sims = topk(q, self._matrix, k=top_k, mask=mask)
        out: list[dict] = []
        for i, sim in zip(idx, sims):
            rec = records[self._names[i]]
            score = float(sim) * (1 + 0.1 * math.log1p(rec.get("hits", 0))) \
                * (0.5 + 0.5 * _rate(rec))
            out.append({**rec, "embedding": None, "code": None,
                        "score": round(score, 3)})
        return out


def _rate(rec: dict) -> float:
    total = rec.get("success", 0) + rec.get("fail", 0)
    return rec.get("success", 0) / total if total else 1.0
