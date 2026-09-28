"""检索层(阶段0: 关键词; 阶段2: embedding 语义检索)。

阶段0 的诚实定位: 关键词检索是**占位实现**, 用来打通 MCP 闭环——
它注定召不回「帮我弄个住的地方 → build_shelter」, 这正是阶段2 要解决的,
留着这个限制本身就是项目叙事的一部分(暴力 vs 语义的对照实验素材)。

排序信号(阶段0 就设计好, 两个阶段共用):
  score = match_score * (1 + 0.1 * log1p(hits)) * (0.5 + 0.5 * success_rate)
  命中多、成功率高的技能往前排 —— bandit 思想, 让好用的技能自然浮现。
"""

from __future__ import annotations

import math
import re
from typing import Optional

from .store import SkillStore

_WORD = re.compile(r"[\w\u4e00-\u9fff]+")   # 英文单词 + 中文单字


def _tokens(text: str) -> set[str]:
    """极简分词: 英文按词、中文按字。够占位用, 语义检索来了就退役。"""
    words = _WORD.findall(text.lower())
    toks = set(words)
    for w in words:
        if re.search(r"[\u4e00-\u9fff]", w):
            toks.update(w)          # 中文词再拆成单字, 提高召回
    return toks


def _name_boost(query: str, name: str) -> float:
    """技能名直接出现在查询里(build_shelter ↔ 'shelter')是强信号。"""
    q, n = query.lower(), name.lower()
    if n in q:
        return 2.0
    parts = [p for p in re.split(r"_", n) if len(p) > 2]
    return 1.5 if any(p in q for p in parts) else 0.0


def search(store: SkillStore, query: str, top_k: int = 5,
           tag: Optional[str] = None) -> list[dict]:
    """关键词检索 + 统计加权。返回 [{name, description, tags, score, ...}]"""
    q_tokens = _tokens(query)
    results: list[dict] = []
    for rec in store.list_all():
        if tag and tag not in rec.get("tags", []):
            continue                          # 元数据过滤: 布尔掩码, 精确
        name_hit = _name_boost(query, rec["name"])
        text = f"{rec['name']} {rec['description']} {' '.join(rec.get('tags', []))}"
        overlap = len(q_tokens & _tokens(text))
        match = overlap + name_hit
        if match <= 0:
            continue
        hits = rec.get("hits", 0)
        rate = _success_rate(rec)
        score = match * (1 + 0.1 * math.log1p(hits)) * (0.5 + 0.5 * rate)
        results.append({**rec, "code": None, "score": round(score, 3)})
    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:top_k]


def _success_rate(rec: dict) -> float:
    total = rec.get("success", 0) + rec.get("fail", 0)
    return rec.get("success", 0) / total if total else 1.0
