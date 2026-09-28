"""语义检索管线测试: embed → 缓存 → brute top-k → 统计加权。

核心验收: 用一个「有语义能力的假 embedder」验证
「搞个落脚点睡觉」(与 shelter 描述零字面重叠)能召回 build_shelter——
即 test_store_search.py 里那条语义鸿沟测试的反转。

FakeEmbedder 无语义能力, 所以这里用 MapEmbedder:
人工指定「哪些文本彼此相近」, 只测管线逻辑, 不测模型质量。
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from mc_skill_library.core.embedder import FakeEmbedder   # noqa: E402
from mc_skill_library.core.semantic import SemanticSearch  # noqa: E402
from mc_skill_library.store import Skill, SkillStore       # noqa: E402


class MapEmbedder(FakeEmbedder):
    """把『同义组』内的文本映射到同一向量——管线的语义能力注入点。"""

    def __init__(self, groups: list[list[str]], dim: int = 32):
        super().__init__(dim)
        self.groups = groups
        self.calls = 0

    def embed(self, text: str) -> list[float]:
        self.calls += 1
        for gi, group in enumerate(self.groups):
            if any(g in text or text in g for g in group):
                base = super().embed(f"group-{gi}")
                return base
        return super().embed(text)


SHELTER_GROUP = ["住", "睡觉", "落脚", "shelter", "住所", "过夜"]


@pytest.fixture()
def store(tmp_path):
    s = SkillStore(tmp_path / "skills")
    s.save(Skill(name="build_shelter",
                 description="盖一个简易住所: 采集木头, 搭建带门的小屋, 躲避夜间怪物",
                 code="// x", tags=["build"]))
    s.save(Skill(name="mine_wood",
                 description="伐木: 寻找最近的树, 挖掘原木并捡起掉落物",
                 code="// x", tags=["mine"]))
    s.save(Skill(name="craft_table",
                 description="合成工作台: 用原木合成工作台并放置到脚下",
                 code="// x", tags=["craft"]))
    return s


def test_semantic_recall_over_vocab_gap(store):
    """验收: 「搞个落脚点睡觉」零字面重叠仍应召回 build_shelter。"""
    emb = MapEmbedder(groups=[SHELTER_GROUP, ["木头", "原木", "树", "wood"]])
    sem = SemanticSearch(store, emb)
    hits = sem.search("搞个落脚点睡觉", top_k=3)
    assert hits and hits[0]["name"] == "build_shelter"


def test_semantic_tag_filter(store):
    emb = MapEmbedder(groups=[SHELTER_GROUP])
    sem = SemanticSearch(store, emb)
    hits = sem.search("我想睡觉过夜", top_k=5, tag="mine")
    assert all("mine" in h["tags"] for h in hits)
    assert all(h["name"] != "build_shelter" for h in hits)


def test_vector_cache_no_recompute(store):
    """入库时算好的向量要缓存到库里, 检索不再对技能文本重新 embed。"""
    emb = MapEmbedder(groups=[SHELTER_GROUP])
    sem = SemanticSearch(store, emb)
    calls_after_build = emb.calls
    sem.search("睡觉", top_k=3)
    sem.search("过夜", top_k=3)
    # 两次检索只应各 embed 查询 1 次, 技能向量全来自缓存
    assert emb.calls == calls_after_build + 2


def test_cache_invalidated_on_save(store, tmp_path):
    """技能更新(描述变了)后缓存失效重算——向量必须对应最新描述。"""
    emb = MapEmbedder(groups=[SHELTER_GROUP])
    sem = SemanticSearch(store, emb)
    sem.search("睡觉", top_k=3)                       # 建缓存
    store.save(Skill(name="craft_table",
                     description="快速造一个睡觉用的床",  # 语义改到 shelter 组
                     code="// x", tags=["craft"]))
    hits = sem.search("睡觉", top_k=3)
    names = [h["name"] for h in hits]
    assert "craft_table" in names


def test_new_skill_vector_persisted(store):
    """语义检索构建后新存的技能, 下次构建也能拿到向量(缓存随库持久化)。"""
    emb = MapEmbedder(groups=[SHELTER_GROUP])
    sem1 = SemanticSearch(store, emb)
    sem1.search("睡觉", top_k=3)                       # 为 3 条技能算好向量
    store.save(Skill(name="smelt_iron",
                     description="挖铁矿并熔炼成铁锭", code="// x"))
    sem2 = SemanticSearch(store, emb)
    rec = store.get("smelt_iron")
    assert rec.get("embedding"), "新技能入库后应带向量"


def test_embedder_failure_falls_back_to_keyword(store):
    """embedding 挂了(网络错误)→ 降级关键词检索, 不 raise。"""
    class BrokenEmbedder(FakeEmbedder):
        def embed(self, text):
            from mc_skill_library.core.embedder import EmbeddingError
            raise EmbeddingError("network down")

    sem = SemanticSearch(store, BrokenEmbedder())
    hits = sem.search("伐木 挖木头", top_k=3)           # 字面重叠, 降级也能中
    assert hits and hits[0]["name"] == "mine_wood"
