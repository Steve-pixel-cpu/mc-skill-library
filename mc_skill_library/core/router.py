"""混合路由: 结构化查询(合成表等)走字典直查, 其余走向量检索。

工程判断: 合成表/方块 ID 是**封闭词表 + 精确匹配**问题,
语义检索反而可能召回错配方; 字典直查 O(1) 且零 embedding 成本。
自然语言任务(「搞个住的地方」)才是向量的主场。

返回 None = 非结构化查询, 调用方走向量; 返回字符串 = 字典结果。
"""

from __future__ import annotations

import re

# 合成表字典: 别名 → 配方。真实数据集(minecraft 数据)阶段 1 接入,
# 先放最小可用集验证路由机制。
_CRAFT_TABLE: dict[str, str] = {
    "木板": "4 木板 ← 1 原木",
    "planks": "4 planks ← 1 log",
    "工作台": "1 工作台 ← 4 木板",
    "crafting_table": "1 crafting_table ← 4 planks",
    "木棍": "4 木棍 ← 2 木板",
    "stick": "4 sticks ← 2 planks",
    "火把": "4 火把 ← 1 煤炭 + 1 木棍",
    "torch": "4 torches ← 1 coal + 1 stick",
}

_TABLE_KEYS = ("合成表", "配方", "怎么合成", "recipe", "craft")


def route(query: str) -> str | None:
    """识别结构化查询并直查字典; 非结构化返回 None(走向量)。"""
    q = query.strip()
    low = q.lower()
    has_table_intent = any(k in low for k in _TABLE_KEYS)
    if not has_table_intent:
        return None
    # 找宾语: 查询里出现的已知物品词
    for alias, recipe in _CRAFT_TABLE.items():
        if alias in q or alias.lower() in low:
            return f"table:{recipe}"
    return None          # 有合成意图但没匹配到物品 → 还是交给语义层兜
