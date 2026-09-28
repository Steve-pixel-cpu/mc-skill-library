"""bench/dataset_gen 测试: 评测集生成器的结构与质量约束。

评测集设计(Voyager 式): 每个技能配 N 条同义/口语化任务描述改写,
检索任务 = 给改写, 期望召回原技能 → recall@k 的分子分母都从这里来。
hard case(如「搞点吃的」)单独标注, 用于分析检索质量短板。
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from bench.dataset_gen import (                       # noqa: E402
    SKILL_POOL, build_eval_set, gen_synthetic, hard_cases,
)


def test_skill_pool_covers_seed_skills():
    """种子技能池 ≥5 条, 每条含 name/description/tags。"""
    assert len(SKILL_POOL) >= 5
    for s in SKILL_POOL:
        assert s["name"] and s["description"] and s["tags"]


def test_eval_set_structure():
    """评测集条目: query + expected(技能名) + kind(rewrite/hard)。"""
    evals = build_eval_set()
    assert len(evals) >= 10
    names = {s["name"] for s in SKILL_POOL}
    for e in evals:
        assert e["query"].strip()
        assert e["expected"] in names
        assert e["kind"] in ("rewrite", "hard")


def test_hard_cases_present():
    """已知 hard case(「搞点吃的」类)要进评测集且标记 kind=hard。"""
    hc = hard_cases()
    assert len(hc) >= 2
    assert all(h["kind"] == "hard" for h in hc)


def test_gen_synthetic_scaling():
    """合成技能库: 指定条数、描述不重复, 用于规模扫描(1k/1w/10w)。"""
    lib = gen_synthetic(1000)
    assert len(lib) == 1000
    descs = [s["description"] for s in lib]
    assert len(set(descs)) == 1000          # 描述唯一 = 向量不退化


def test_gen_synthetic_deterministic():
    """同 seed 同结果——benchmark 可复现。"""
    a = gen_synthetic(50, seed=42)
    b = gen_synthetic(50, seed=42)
    assert [s["name"] for s in a] == [s["name"] for s in b]
