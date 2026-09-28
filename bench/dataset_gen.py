"""bench/dataset_gen 测试通过基准评测集生成器。

两个用途:
1. build_eval_set(): 真实技能 + 人工改写/hard case → 检索质量评测(recall@k)
2. gen_synthetic(n): 合成技能库 → 规模扫描(1k/1w/10w)的暴力 vs ANN 对比

设计原则:
- 改写(query)与技能描述零字面重叠是常态——这正是语义检索的存在意义
- hard case 来自真实验收中发现的失败案例(PLAN 有记录), 不是臆造
- 合成库确定性(seed), benchmark 可复现
"""

from __future__ import annotations

import random

# ── 种子技能池(与 skills/ 正式库对齐) ─────────────────────────
SKILL_POOL: list[dict] = [
    {"name": "build_shelter", "tags": ["build", "survival"],
     "description": "盖一个简易住所: 采集木头, 搭建带门的小屋, 躲避夜间怪物"},
    {"name": "mine_wood", "tags": ["mine", "gather"],
     "description": "伐木: 在固定林场种橡树苗骨粉催熟, 斧砍收集原木并补种"},
    {"name": "craft_table", "tags": ["craft"],
     "description": "合成工作台: 用原木合成工作台并放置到脚下"},
    {"name": "smelt_iron", "tags": ["mine", "smelt"],
     "description": "挖铁矿并用熔炉炼成铁锭"},
    {"name": "farm_wheat", "tags": ["farm"],
     "description": "种小麦: 开垦农田, 播种浇水等待成熟后收割"},
    {"name": "patrol_area", "tags": ["move"],
     "description": "在基地附近巡逻: 沿正方形航点行走一圈并报告位置"},
]

# ── 每技能的同义/口语改写(与描述刻意低字面重叠) ───────────────
_REWRITES: dict[str, list[str]] = {
    "build_shelter": [
        "帮我弄个住的地方",
        "搞个落脚点睡觉",
        "天黑了怪物要来了, 需要个掩体",
        "我想有个自己的小窝",
        "晚上没地方待, 弄个能躲怪的屋子",
    ],
    "mine_wood": [
        "去搞点木材",
        "家里没木头了",
        "需要一些原木做东西",
        "帮我囤点木头",
        "林场该轮伐了",
    ],
    "craft_table": [
        "我要做合成台",
        "怎么弄个能合成的方块",
        "给我整一个工作台放地上",
        "合成需要个台子",
    ],
    "smelt_iron": [
        "炼点铁",
        "搞些铁锭来",
        "需要金属材料",
        "熔炉炼铁",
    ],
    "farm_wheat": [
        "搞点吃的",
        "种点粮食吧",
        "我们该种地了",
        "收获一波麦子",
    ],
    "patrol_area": [
        "在基地周围转一圈",
        "帮我巡视下附近",
        "走一圈看看周围情况",
        "例行巡逻",
    ],
}

# ── hard case: 真实验收中发现检索失败的案例(2026-09-28 GLM 验收记录) ──
_HARD: list[dict] = [
    {"query": "搞点吃的", "expected": "farm_wheat"},
    {"query": "饿了, 想办法弄食物", "expected": "farm_wheat"},
    {"query": "家里进怪了怎么办, 有防御手段吗", "expected": "build_shelter"},
    {"query": "出生点附近安全吗", "expected": "patrol_area"},
]


def build_eval_set() -> list[dict]:
    """评测集: [{query, expected, kind}]。rewrite 为主, hard 单独标注。"""
    out: list[dict] = []
    for skill in SKILL_POOL:
        for q in _REWRITES.get(skill["name"], []):
            out.append({"query": q, "expected": skill["name"],
                        "kind": "rewrite"})
    out.extend({"kind": "hard", **h} for h in _HARD)
    return out


def hard_cases() -> list[dict]:
    return [e for e in build_eval_set() if e["kind"] == "hard"]


# ── 合成技能库(规模扫描用) ────────────────────────────────────
_TOPICS = [
    "采集", "建造", "合成", "熔炼", "种植", "驯服", "探索", "战斗准备",
    "运输", "储存", "照明", "防御", "灌溉", "垂钓", "狩猎", "酿造",
    "附魔准备", "修补", "装饰", "红石机关", "电梯", "铁路", "矿道",
    "桥梁", "塔楼", "农场自动化", "牧场", "渔场", "林场", "采石场",
]
_OBJS = [
    "圆石", "砂岩", "石英", "黑曜石", "荧石", "雪块", "黏土", "玄武岩",
    "深板岩", "铜锭", "金锭", "青金石", "红石粉", "绿宝石", "钻石",
    "小麦", "胡萝卜", "马铃薯", "甜菜根", "西瓜", "南瓜", "仙人掌",
    "甘蔗", "竹子", "可可豆", "蘑菇", "苹果", "生鱼", "生猪排", "羽毛",
]
_ACTIONS = [
    "批量", "快速", "安全", "高效", "循环", "自动化", "手动", "半自动",
    "应急", "远征", "就近", "定点", "巡游", "定时",
]
_TEMPLATE = "{action}{topic}{obj}: 围绕{obj}的{topic}流程, " \
            "在{place}{adv}执行并{result}"
_PLACES = ["基地", "野外", "矿洞", "水边", "山顶", "平原", "丛林", "沼泽"]
_ADVS = ["谨慎", "专注", "连续", "分批", "一次性"]
_RESULTS = ["收集产出", "记录坐标", "更新台账", "汇报状态", "归档结果"]


def gen_synthetic(n: int, seed: int = 7) -> list[dict]:
    """n 条合成技能(name/description/tags), 描述唯一, 同 seed 可复现。"""
    rng = random.Random(seed)
    seen: set[str] = set()
    out: list[dict] = []
    i = 0
    while len(out) < n:
        i += 1
        topic = rng.choice(_TOPICS)
        obj = rng.choice(_OBJS)
        desc = _TEMPLATE.format(
            action=rng.choice(_ACTIONS), topic=topic, obj=obj,
            place=rng.choice(_PLACES), adv=rng.choice(_ADVS),
            result=rng.choice(_RESULTS))
        if desc in seen:
            continue
        seen.add(desc)
        out.append({"name": f"synth_{i:07d}",
                    "description": desc,
                    "tags": [rng.choice(_TOPICS), rng.choice(_ACTIONS)]})
    return out
