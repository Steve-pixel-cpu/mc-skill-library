"""技能存储层: JSONL 条目 + 代码文件, 原子写。

设计决策:
- 一个技能 = skills/<name>.js(可执行代码) + skills/library.jsonl 里一行元数据。
  代码独立成文件而不是塞进 JSON: 方便 git diff、人工审阅、直接 node 调试。
- 写入走 tmp + os.replace: Windows 上 rename 目标存在会炸, replace 是原子替换。
- 检索层(core/search.py)只读本模块提供的全量列表, 存储量级 ≤1w,
  每次全量加载 ~ms 级, 不需要索引文件。
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

# 技能名进文件名, 只放安全字符; 中文允许(Windows 文件系统 OK)但去掉路径分隔符等
_SAFE_NAME = re.compile(r'[\\/:*?"<>|\s]')


@dataclass
class Skill:
    name: str                       # 唯一标识, 如 build_shelter
    description: str                # 自然语言描述, 检索的主要语料
    code: str = ""                  # mineflayer JS 代码(入库时写入 .js 文件)
    tags: list[str] = field(default_factory=list)   # 类型标签: build/mine/farm...
    created_at: float = field(default_factory=time.time)
    # ── 运行时统计(检索排序加权用, bandit 思想) ──
    hits: int = 0                   # 被检索命中次数
    success: int = 0                # 执行成功次数
    fail: int = 0                   # 执行失败次数

    @property
    def success_rate(self) -> float:
        total = self.success + self.fail
        return self.success / total if total else 1.0

    def safe_filename(self) -> str:
        cleaned = _SAFE_NAME.sub("_", self.name).strip("_") or "skill"
        return f"{cleaned}.js"


class SkillStore:
    """技能库持久化。库目录: skills/library.jsonl + skills/<name>.js"""

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.index_file = self.root / "library.jsonl"

    # ── 内部 ──────────────────────────────────────────────
    def _load_all(self) -> dict[str, dict]:
        """全量加载索引。条目损坏跳过(响亮记录)——一条坏数据不该废掉整个库。"""
        out: dict[str, dict] = {}
        if not self.index_file.exists():
            return out
        with open(self.index_file, encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    out[rec["name"]] = rec
                except (json.JSONDecodeError, KeyError):
                    # 坏行跳过但可追溯: 阶段0 先 print, 之后接日志
                    print(f"[store] library.jsonl 第{i}行损坏, 已跳过")
        return out

    def _append(self, rec: dict) -> None:
        """追加一行(JSONL 只追加不重写, 天然并发友好 + 历史可审计)。"""
        with open(self.index_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def _rewrite(self, records: dict[str, dict]) -> None:
        """统计更新时全量重写(量小无所谓); tmp+replace 原子替换防半写。"""
        tmp = self.index_file.with_suffix(".jsonl.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            for rec in records.values():
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        os.replace(tmp, self.index_file)

    def _code_path(self, name: str) -> Path:
        return self.root / Skill(name=name, description="").safe_filename()

    # ── 对外 API ──────────────────────────────────────────
    def save(self, skill: Skill, overwrite: bool = True) -> str:
        """保存技能: 代码落 .js 文件, 元数据追加/更新索引。返回状态说明。"""
        existing = self._load_all()
        if skill.name in existing and not overwrite:
            return f"已存在同名技能 {skill.name}(未覆盖)"
        # 代码文件原子写
        code_path = self._code_path(skill.name)
        tmp = code_path.with_suffix(".js.tmp")
        tmp.write_text(skill.code, encoding="utf-8")
        os.replace(tmp, code_path)
        # 元数据: 保留旧统计(更新描述/代码不该清零战绩)
        old = existing.get(skill.name, {})
        rec = asdict(skill)
        for k in ("hits", "success", "fail", "created_at"):
            if old.get(k) is not None:
                rec[k] = old[k]
        existing[skill.name] = rec
        self._rewrite(existing)
        return f"技能 {skill.name} 已保存({code_path.name})"

    def read_code(self, name: str) -> Optional[str]:
        p = self._code_path(name)
        return p.read_text(encoding="utf-8") if p.exists() else None

    def get(self, name: str) -> Optional[dict]:
        return self._load_all().get(name)

    def list_all(self) -> list[dict]:
        """检索层的数据源。code 不放进记录(大), 按需 read_code。"""
        return list(self._load_all().values())

    def bump(self, name: str, *, hit: bool = False, success: bool = False,
             fail: bool = False) -> None:
        """统计自增。命中/成功/失败都会影响检索排序(见 core/search.py)。"""
        records = self._load_all()
        rec = records.get(name)
        if rec is None:
            return
        if hit:
            rec["hits"] += 1
        if success:
            rec["success"] += 1
        if fail:
            rec["fail"] += 1
        self._rewrite(records)
