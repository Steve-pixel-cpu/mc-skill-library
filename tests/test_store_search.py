"""store + search 的单元测试(不依赖 mcp SDK, 纯逻辑层)。

跑法: cd mc-skill-library && python -m pytest tests/ -v
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from mc_skill_library.search import search           # noqa: E402
from mc_skill_library.store import Skill, SkillStore  # noqa: E402

import pytest


@pytest.fixture()
def store(tmp_path):
    s = SkillStore(tmp_path / "skills")
    s.save(Skill(name="build_shelter",
                 description="盖一个简易住所: 采集木头, 搭建带门的小屋, 躲避夜间怪物",
                 code="// build shelter", tags=["build", "survival"]))
    s.save(Skill(name="mine_wood",
                 description="伐木: 寻找最近的树, 挖掘原木并捡起掉落物",
                 code="// mine wood", tags=["mine", "gather"]))
    s.save(Skill(name="craft_table",
                 description="合成工作台: 用原木合成工作台并放置到脚下",
                 code="// craft table", tags=["craft"]))
    return s


def test_save_and_roundtrip(store):
    code = store.read_code("mine_wood")
    assert code == "// mine wood"
    assert store.get("mine_wood")["tags"] == ["mine", "gather"]


def test_save_keeps_stats(store):
    store.bump("mine_wood", hit=True, success=True)
    store.save(Skill(name="mine_wood", description="伐木 v2", code="// v2"))
    rec = store.get("mine_wood")
    assert rec["hits"] == 1 and rec["success"] == 1   # 战绩没被覆盖清零


def test_search_keyword(store):
    hits = search(store, "挖木头 伐木", top_k=3)
    assert hits and hits[0]["name"] == "mine_wood"


def test_search_tag_filter(store):
    hits = search(store, "木头", top_k=5, tag="build")
    assert all("build" in h["tags"] for h in hits)


def test_search_semantic_gap(store):
    """阶段0 的已知局限(叙事素材): 语义鸿沟——没有字面重叠时召不回。
    「搞个落脚点过夜」没有任何 token 与 shelter 描述重叠(单字'夜'除外),
    关键词检索必然失手; embedding 上线后本测试改写为应召回 build_shelter。"""
    hits = search(store, "搞个落脚点睡觉", top_k=3)
    top = hits[0] if hits else None
    # 单字「觉/睡」不应作为强信号; 若误命中, score 应是噪声级(<2)
    if top and top["name"] == "build_shelter":
        assert top["score"] < 2, "关键词检索意外地强——语义鸿沟测试前提变了"



def test_stats_bump(store):
    store.bump("craft_table", success=True)
    store.bump("craft_table", fail=True)
    rec = store.get("craft_table")
    assert rec["success"] == 1 and rec["fail"] == 1


def test_update_embeddings_persists(store):
    """update_embeddings 把向量写回索引, 重启(新实例)后仍在。"""
    store.update_embeddings({"mine_wood": [0.1, 0.2]})
    rec = SkillStore(store.root).get("mine_wood")   # 新实例 = 模拟重启
    assert rec["embedding"] == [0.1, 0.2]
    # 其他技能不受影响
    assert "embedding" not in SkillStore(store.root).get("craft_table")
