# mc-skill-library

> 为 LLM Agent 设计的技能库:语义检索 + 可执行代码 —— 让 Agent 学会的技能终身复用,零 LLM 调用。

[![Python](https://img.shields.io/badge/Python-3.12+-blue)](https://python.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 这是什么

LLM Agent 玩 Minecraft 时,每个动作都过一遍 LLM,延迟 1-10 秒,体验割裂。
本项目的思路(源自 [Voyager](https://arxiv.org/abs/2305.16291)):**把 Agent 学到的能力
沉淀为可执行代码(技能),向量化入库;新任务来了语义检索复用,命中即零 LLM 调用**。

```
"帮我弄个住的地方" ──► skill_search ──► build_shelter.js ──► skill_exec
                        (语义检索,~1ms)     (技能库命中)        (流畅执行,无 LLM)
```

## 架构

```
任意 MCP 客户端                     mc-skill-library (本仓库)
(x-code / Claude Desktop / Cursor)
        │            MCP stdio      ┌────────────────────────────┐
        ├─ skill_save ─────────────►│ 入库: 描述 → embedding      │
        ├─ skill_search ───────────►│ 检索: 语义 top-k + 元数据过滤│
        ├─ skill_exec ─────────────►│ 执行: node 子进程 + 看门狗   │
        └─ skill_stats ────────────►│ 统计: 命中/成功率(排序加权)  │
                                   │                            │
                                   │ 检索引擎: numpy 暴力精确检索  │
                                   │ (≤1万级技能 0.1ms,够用且更对)│
                                   └────────────────────────────┘
```

**为什么不用向量数据库/HNSW**:技能库量级 ≤1k,1024 维暴力检索 ~0.1ms,
占端到端延迟(embedding 300ms + LLM 秒级)的万分之一。
生产路径 = 最简单、精确、过滤友好的方案;ANN 从零实现作为独立实验项目
测「从什么规模开始才值得用」(见 `bench/`)。

## 快速开始

```bash
git clone https://github.com/Steve-pixel-cpu/mc-skill-library
cd mc-skill-library
uv sync  # 或 pip install -e .

# 直接跑(开发模式)
python server.py
```

配置到任意 MCP 客户端(以 Claude Code 风格配置为例):

```json
{
  "mcpServers": {
    "skills": {
      "command": "python",
      "args": ["path/to/mc-skill-library/server.py"]
    }
  }
}
```

## MCP 工具

| 工具 | 说明 |
|------|------|
| `skill_save` | 保存技能:名称+描述+JS 代码,自动 embedding 入库 |
| `skill_search` | 语义检索:任务描述 → top-k 技能(支持元数据过滤) |
| `skill_exec` | 执行技能:node 子进程跑 JS,带超时与看门狗 |
| `skill_stats` | 库统计:技能数/命中/成功率 |

## 路线图

- [x] 阶段 0: MCP server 骨架 + JSONL 存储 + 关键词检索(能跑)
- [ ] 阶段 1: 接入 Minecraft bot,种子技能 5 个
- [x] 阶段 2: embedding 语义检索 + 混合路由(结构化查字典/语义走向量)
- [ ] 阶段 3: benchmark(暴力 vs chromadb + 规模扫描,交叉点分析)
- [ ] 选修: 自研 HNSW 补入对比曲线
- [ ] 可选: 事件桥(MC 事件唤醒 Agent)+ 技能自动沉淀

## 已定边界

- 只支持官方 Java 版(锁 1.21.x)+ 离线模式;不进第三方反作弊服务器
- 不做战斗/实时反应(那是 Mineflayer 行为树的课题,不是本项目的)
- 技能载体是 mineflayer JS;检索/存储/执行器全 Python

## License

MIT
