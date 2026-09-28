"""技能执行器: node 子进程跑 mineflayer JS, 带超时与输出截断。

阶段0 是最小实现: 起进程、收输出、记胜负。
看门狗(卡死检测/控制状态清理/寻路超时上报)是阶段2 的活, 接口在这里预留。

为什么子进程而不是 eval:
- 技能代码是 LLM 生成的, 隔离崩溃(bot 卡死/死循环)不影响 MCP server 本体
- node 退出码 + stdout/stderr 天然是执行报告, LLM 拿去自我修正(Voyager 迭代精炼)
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Optional

from .store import SkillStore

DEFAULT_TIMEOUT_S = 120          # 一次技能执行的上限(挖一片树/盖小屋够用)
MAX_OUTPUT_CHARS = 8000          # 回传给 LLM 的输出上限, 防上下文炸弹


def execute(store: SkillStore, name: str, timeout: int = DEFAULT_TIMEOUT_S,
            node_bin: Optional[str] = None) -> str:
    """执行技能, 返回人类/LLM 可读的报告。永不抛异常——失败也是情报。"""
    code = store.read_code(name)
    if code is None:
        return f"技能 {name} 不存在或代码文件丢失"

    node = node_bin or "node"
    code_path = store.root / store._code_path(name)  # noqa: SLF001
    try:
        proc = subprocess.run(
            [node, str(code_path)],
            capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            timeout=timeout, cwd=str(store.root),
        )
        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        ok = proc.returncode == 0
        store.bump(name, success=ok, fail=not ok)
        report = [
            f"技能 {name} 执行{'成功' if ok else '失败'}(退出码 {proc.returncode})",
            f"--- stdout ---\n{out[:MAX_OUTPUT_CHARS]}",
        ]
        if err:
            report.append(f"--- stderr ---\n{err[:MAX_OUTPUT_CHARS]}")
        if not out and not err and ok:
            report.append("(无输出——技能代码可能还没有实现任何动作)")
        return "\n".join(report)
    except subprocess.TimeoutExpired:
        store.bump(name, fail=True)
        # TODO(阶段2): 超时 ≠ 失败, 可能是卡死——看门狗接管: 杀进程树 + 恢复例程
        return f"技能 {name} 执行超时({timeout}s), 已终止。若反复出现, 需要看门狗介入。"
    except FileNotFoundError:
        return f"找不到 node 可执行文件({node})——技能执行需要 Node.js"
