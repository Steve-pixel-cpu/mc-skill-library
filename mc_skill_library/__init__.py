"""mc-skill-library: 为 LLM Agent 设计的技能库(语义检索 + 可执行代码)。

分层:
- server.py   MCP 入口(本文件): 工具定义与注册
- core.store  技能存储: JSONL + 代码文件, 原子写
- core.search 检索: 关键词(阶段0) → embedding 语义检索(阶段2)
- core.executor 技能执行: node 子进程 + 超时(看门狗在阶段2完善)
"""

__version__ = "0.1.0"
