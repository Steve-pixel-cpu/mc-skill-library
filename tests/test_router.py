"""混合路由测试: 结构化查询走字典直查, 自然语言走向量。

「什么时候不用向量」的实证: 合成表/方块 ID 查询是结构化的,
精确字典命中比语义检索更快更准; 自然语言任务才值得花 embedding。
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from mc_skill_library.core.router import route   # noqa: E402


@pytest.mark.parametrize("query,expected", [
    ("合成表 木板", "table:4 木板 ← 1 原木"),
    ("crafting table planks", "table:4 planks ← 1 log"),
    ("合成表", None),                    # 只有关键词没有宾语 → 不是结构化查询
    ("帮我盖个房子", None),               # 自然语言 → 走语义
    ("挖点木头回来", None),
])
def test_route(query, expected):
    assert route(query) == expected


def test_route_dict_direct_hit():
    """结构化命中应绕过 embedding(返回字典结果, 调用方不再走向量)。"""
    r = route("合成表 工作台")
    assert r is not None and r.startswith("table:")
