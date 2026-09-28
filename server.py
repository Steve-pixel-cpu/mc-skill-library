"""MCP server 入口: 4 个工具(skill_save/search/exec/stats)。

启动方式: 任意 MCP 客户端以 stdio 拉起本文件; 也可 python server.py 手动验证。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from mc_skill_library.core.embedder import make_embedder        # noqa: E402
from mc_skill_library.core.router import route                  # noqa: E402
from mc_skill_library.core.semantic import SemanticSearch       # noqa: E402
from mc_skill_library.executor import execute                   # noqa: E402
from mc_skill_library.store import Skill, SkillStore            # noqa: E402

SKILLS_DIR = Path(os.environ.get(
    "MC_SKILLS_DIR", Path(__file__).parent / "skills"))

_store = SkillStore(SKILLS_DIR)
_semantic = SemanticSearch(_store, make_embedder())

try:
    # mcp SDK 2.x: FastMCP 更名为 MCPServer(2026 起 2.x 为默认安装版本)
    from mcp.server.mcpserver import MCPServer as McpServerImpl
except ImportError:
    try:
        from mcp.server.fastmcp import FastMCP as McpServerImpl   # mcp 1.x
    except ImportError:
        sys.exit("缺少依赖: uv pip install 'mcp[cli]'")

mcp = McpServerImpl("skills", instructions=(
    "LLM Agent 技能库。接到新任务时先 skill_search 查已有技能;"
    "命中则 skill_exec 执行(零 LLM 决策); 未命中再自己实现, 成功后"
    "skill_save 沉淀, 下次直接复用。skill_stats 看库的健康度。"
))


@mcp.tool()
def skill_save(name: str, description: str, code: str,
               tags: str = "") -> str:
    """保存技能。name 用 snake_case 英文(build_shelter);
    description 是自然语言任务描述(检索主要语料, 写清楚"能干什么、什么场景用");
    code 是 mineflayer JS 代码; tags 逗号分隔(build,mine,farm...)。"""
    s = Skill(
        name=name,
        description=description,
        code=code,
        tags=[t.strip() for t in tags.split(",") if t.strip()],
    )
    result = _store.save(s)
    _semantic.invalidate()          # 新技能/新描述 → 补算向量并刷新矩阵
    return result


@mcp.tool()
def skill_search(query: str, top_k: int = 5, tag: str = "") -> str:
    """按任务描述检索技能。query 用自然语言(如"帮我弄个住的地方");
    可用 tag 过滤类型(build/mine/farm/craft)。返回候选技能与适配度。"""
    structured = route(query)       # 混合路由: 合成表等结构化查询字典直查
    if structured:
        return f"[字典直查] {structured}"
    hits = _semantic.search(query, top_k=top_k, tag=tag or None)
    if not hits:
        return (f"未找到匹配「{query}」的技能——考虑自己实现并用 skill_save 沉淀。")
    for h in hits:
        _store.bump(h["name"], hit=True)
    lines = [f"「{query}」的候选技能({len(hits)} 个):"]
    for h in hits:
        rate = h.get("success", 0) / max(1, h.get("success", 0) + h.get("fail", 0))
        lines.append(
            f"- {h['name']} (score={h['score']}, 成功率{rate:.0%}, "
            f"命中{h.get('hits', 0)}次): {h['description']}")
    lines.append("用 skill_exec 执行, 或先查看代码再执行。")
    return "\n".join(lines)


@mcp.tool()
def skill_exec(name: str, timeout: int = 120) -> str:
    """执行技能(node 子进程)。返回执行报告(stdout/stderr/退出码);
    失败报告可直接反馈给 LLM 自我修正后重新 skill_save。"""
    return execute(_store, name, timeout=timeout)


@mcp.tool()
def skill_stats() -> str:
    """技能库统计: 总数、各技能命中/成功/失败, 用于健康度判断。"""
    all_skills = _store.list_all()
    if not all_skills:
        return "技能库为空。用 skill_save 存入第一个技能。"
    lines = [f"共 {len(all_skills)} 个技能:"]
    for r in sorted(all_skills, key=lambda x: -x.get("hits", 0)):
        total = r.get("success", 0) + r.get("fail", 0)
        rate = r["success"] / total if total else None
        rate_s = f"{rate:.0%}" if rate is not None else "未执行"
        lines.append(f"- {r['name']}: 命中{r.get('hits', 0)}, 执行{total} 次"
                     f"({rate_s}) [{','.join(r.get('tags', [])) or '无标签'}]")
    return "\n".join(lines)


if __name__ == "__main__":
    mcp.run()   # stdio 传输: MCP 客户端(x-code/Claude)直接拉起
