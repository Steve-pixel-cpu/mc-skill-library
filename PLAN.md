# mc-skill-library 项目计划

> 为 LLM Agent 设计的技能库:语义检索 + 可执行代码 + 精确检索(选修 ANN 实验)
> 载体:Minecraft Agent | 目标:可展示、可复现的检索系统 + 开源作品
> 仓库:https://github.com/Steve-pixel-cpu/mc-skill-library(2026-09-28 已开仓)

## 进度(2026-09-28)

- [x] **阶段 0 完成**:仓库骨架 + server.py 四工具 + JSONL 存储 + 关键词检索
      + node 执行器;6 项单测全过;端到端冒烟(save→search→exec→stats)通过;已推送 GitHub
- 过程决策:mcp SDK 2.x FastMCP→MCPServer 改名,已做双版本兼容;
  语义鸿沟留了专门测试(「住的地方」召不回 shelter),阶段 2 embedding 上线后改写为应召回


## 定位

- 独立 MCP server(Python + FastMCP),不绑死 x-code,任何 MCP 客户端(Claude Desktop / x-code / Cursor)都能接
- 解决的核心问题:LLM Agent 每个动作都过一遍 LLM 延迟不可接受 → 学会的技能(代码)向量化入库,新任务语义检索复用,已学技能零 LLM 调用(Voyager 验证的架构)
- **检索决策(2026-09-28 定)**:技能库量级 ≤1k 条,1024 维暴力检索 ~0.1ms,
  占端到端延迟(embedding 50-300ms + LLM 秒级)的万分之一 →
  **生产路径 = numpy 暴力精确检索**,简单、精确、元数据过滤天然友好
- HNSW 从零实现降级为**选修实验**:不为项目需要,为深入理解 ANN 原理 + 测出「ANN 从哪个
  规模开始才值得用」的交叉点——比「无脑上 HNSW」更高级的工程叙事
- 技术主线:Agent 架构 + RAG + 检索引擎选型判断 + benchmark 方法学 + 执行器健壮性

## 架构

```
x-code (Agent 壳)                    mc-skill-library (本仓库)
┌──────────────┐    MCP stdio      ┌─────────────────────────┐
│ runtime 循环  │◄────────────────►│ MCP Server (FastMCP)     │
│ mcp_client   │                   │  ├ skill_save 描述→向量入库│
└──────┬───────┘                   │  ├ skill_search 语义检索  │
       │ mcp__minecraft__*         │  ├ skill_exec 执行代码    │
┌──────▼───────┐                   │  └ skill_stats 命中统计   │
│ yuniko MCP   │                   │      │                   │
│ (mineflayer) │                   │      ▼                   │
└──────────────┘                   │  Embedding + 检索引擎      │
                                   │  生产: numpy 暴力(精确)    │
                                   │  选修: 自研HNSW(实验)      │
                                   └─────────────────────────┘
```

## 目录骨架

```
mc-skill-library/
├── server.py              # MCP server 入口(FastMCP)
├── core/
│   ├── embedder.py        # embedding 抽象(先接 API,留本地模型口)
│   ├── store.py           # 技能存储: JSONL + 代码文件 + 元数据
│   ├── executor.py        # mineflayer JS 技能执行沙箱(node 子进程
│   │                      #   + 超时/看门狗/卡死恢复,健壮性是复用前提)
│   └── router.py          # 混合路由: 结构化查询(合成表等)走字典,
│                          #   语义查询走向量——工程判断力展示点
├── index/
│   ├── brute.py           # 生产检索器: 归一化 + 余弦 top-k + 布尔掩码过滤
│   └── hnsw.py            # 选修实验: 从零实现,接口与 brute 一致(不阻塞主线)
├── bench/
│   ├── dataset_gen.py     # 评测集: 任务描述同义改写 → 期望召回技能
│   └── run_bench.py       # recall@k / QPS / 内存 + 规模扫描(找暴力/HNSW 交叉点)
├── skills/                # 运行时技能库(JSONL + 代码文件)
└── tests/
```

## 阶段与任务清单

### 开仓
- [ ] 创建 GitHub 仓库 mc-skill-library:MIT license + README 第一行定位
      (「为 LLM Agent 设计的技能库:语义检索 + 可执行代码」)+ 上述目录骨架

### 阶段 1 — 能跑(1-2 天)
- [ ] x-code 配置 mcpServers:接入 yuniko minecraft server(npx + mineflayer,MC 1.21.x)
      + mc-skill-library 本仓库,bot 进世界能移动
- [ ] server.py 定义 4 个 MCP 工具:skill_save / skill_search / skill_exec / skill_stats
      手动存 5 个技能(build_shelter / mine_wood / craft_table 等)并能检索命中

### 阶段 2 — 语义检索上线(2-3 天,即 MVP 完成)
- [ ] core/embedder.py:API embedding(硅基流动/智谱免费档)+ 本地模型预留接口
- [ ] index/brute.py:**生产检索器质量要求**——向量归一化、top-k、
      元数据布尔掩码过滤(类型/成功率)、命中返回 skill 元信息
- [ ] core/router.py:混合路由——合成表/方块 ID 等结构化查询走字典直查,
      自然语言任务走向量检索(「什么时候不用向量」的实证)
- [ ] (随做随记)executor 看门狗:目标进行中位置 N 秒不变 → clearControlStates
      → 原地跳 → 重试;寻路 noPath/超时显式上报,不让 Promise 挂死

### 阶段 3 — Benchmark(2-3 天)
- [ ] bench/dataset_gen.py:构造评测集(同义改写任务描述 → 期望召回技能)
- [ ] bench/run_bench.py:暴力 vs chromadb(外包基线)+ 规模扫描(1k/1w/10w 合成数据)
- [ ] 输出:recall@k / QPS / 内存曲线 + **暴力/HNSW 交叉点分析**
      (HNSW 实现完成前先出「暴力 vs chromadb」版,结论句式:
      「≤10w 级数据暴力精确检索全面胜出,生产路径用它」)
- [ ] (选修)自研 HNSW 补入对比曲线:分层图 + 贪心搜索 + 启发式选边,
      接口与 brute 一致,周末实验性质,不阻塞主线

### 阶段 4 — 事件桥 + 自动沉淀(可选,兴趣驱动)
- [ ] 事件桥:MC 事件(bot 受伤/聊天/天黑)反向唤醒 agent(x-code WebSocket 推流骨架可复用)
- [ ] Voyager 式自动沉淀:bot 学会新技能自动入库,检索库自然增长
- [ ] 命中统计加权(skill_stats):成功次数多 → 检索排序加分
      (bandit 思想: 好用的技能自然浮现)

### 传播材料(demo/博客)
- [ ] 3 分钟 demo 录屏(教技能 → 检索 → 盖房),放 README 首屏;每阶段结束补录最新版
- [ ] 技术博客选题(二选一或都写):
      A.《我的 Agent 技能库为什么不用向量数据库》——选型判断 + benchmark 实证
      B.《为了测 HNSW 的交叉点,我把它从零写了一遍》——原理向
- [ ] 项目一页纸介绍 + 架构图(定位:检索系统为主 + agent + 游戏)

## 已定的关键决策

1. **生产检索 = numpy 暴力精确检索**(2026-09-28 定,理由见定位节);
   HNSW 降级选修,存在意义 = 原理储备 + 交叉点实验,不阻塞主线
2. embedding 初期走 API;若做 QPS benchmark,换本地小模型(BGE-small)避免网络延迟污染数据
3. 战斗/实时反应不做(Mineflayer 行为树的事,不是本课题)
4. 明确「不是什么」:不是产品、不是通用向量库替代品——造的是「检索系统选型的实证 +
   Agent 基础设施」,定位说清楚,避免误解为造轮子
5. x-code 侧只需三行配置接入(格式与其 McpServerConfig 兼容),不改 x-code 代码
6. 版本支持红线(写给未来 README):只支持官方 Java 版 1.21.x + 离线模式,
   不进第三方反作弊服务器,不追网易版——防 issue 跑步机


## 游戏侧接入清单(阶段 1 的操作步骤,2026-09-28 定稿)

1. 装 Java 21:`winget install Microsoft.OpenJDK.21`,`java -version` 验证
2. 装 PCL2 启动器(pcl2start.cn)→ 离线模式 → 安装原版 **1.21.8**(不用 Forge/Fabric)
3. 建测试世界:**超平坦 + 创造 + 白天**(变量最少,bot 测试友好)
4. 每次玩时:进世界 → `ESC → 对局域网开放`(默认端口 25565;世界开着 LAN bot 才在线)
5. x-code mcpServers 加 minecraft 条目(见下方配置),重启 x-code
6. 验证:聊天里说「让 bot 走到我这」,观察 x-code 调 mcp__minecraft__* 工具

```json
"minecraft": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "github:yuniko-software/minecraft-mcp-server",
           "--host", "localhost", "--port", "25565", "--username", "XBot"]
}
```

注意:yuniko 官方支持到 1.21.11,1.21.8 在区间内;npx 首拉要联网,首次启动慢十几秒正常。

## yuniko vs mineflayer 的关系(双通道架构,2026-09-28 定)

三层洋葱:**yuniko(MCP 协议层)→ mineflayer(协议驱动库)→ MC 服务端**。
yuniko 是用 mineflayer 拼好的现成 MCP server;mineflayer 是库,自己写代码用。

**关键认知:技能库的技能代码不经过 yuniko。**
skill_exec 是自己 fork node 子进程跑技能 JS,技能代码里 `require('mineflayer')` 直连游戏。
yuniko 只给 x-code 对话循环提供低粒度手动控制(学习/调试/即时指令)——「手动挡」;
技能执行走自己的执行器——「自动挡」。所以:

```
x-code 对话循环
├── mcp__minecraft__* (yuniko)   ← 通道1: 手动挡,细粒度调试/即时指令
└── mcp__skills__skill_exec      ← 通道2: 自动挡,技能 JS 直连 mineflayer
```

- [ ] 阶段 2.5(新):自研薄 MCP 包装(约 50 行)替换 yuniko,统一 bot 连接——
      技能执行和手动控制共用一个 bot 实例,消除双 bot 可能;
      架构收益:「自研 bot 控制层,不依赖第三方 MCP」

## MCP 运行机制备忘(为什么"不用启动")

stdio 模式下 MCP server 是 **x-code 的子进程**:x-code 启动时按配置自动 fork
(python server.py),通过 stdin/stdout JSON-RPC 通信;x-code 退出时一并回收。
配置里只有 command/args,没有"启动"步骤——**配好即托管,生死相随**。
独立运行场景只有两个:开发调试(python server.py 直跑)、阶段4 事件桥需要
常驻时(改 type:http,server 自起端口)。

已验证:PID 可查(Get-CimInstance 过滤 CommandLine 含 mc-skill-library),
x-code connected 后 skills 四工具全链路可用。

超时链路注意:x-code(120s)→ server exec(120s)→ node 子进程(120s) 三层要
对齐,不然出现「node 还在跑、server 已超时返回」的幽灵进程——看门狗要处理。

## 当前进度快照(2026-09-28 会话结束)

- [x] 阶段 0:仓库/四工具/测试/GitHub(main 分支)
- [x] x-code 接入 connected,CLI 闭环验证过(craft_table 入库+命中)
- [ ] 阶段 1:游戏侧接入(见上方清单,机器还没装 Java/MC)
- [ ] 阶段 2:embedder → brute → router → 看门狗
- [ ] 阶段 3:benchmark + 选修 HNSW
- 环境备忘:仓库在 D:\workplace\mc-skill-library(venv: .venv, Python 3.14);
  x-code 配置在 ~/.x-code/settings.json 的 mcpServers.skills(venv 绝对路径);
  本机 Node v26.3.0 ✓;Java/MC/PCL2 未装
