"""配置加载: config.json(项目根, gitignore)优先, 环境变量兜底。

为什么不用纯环境变量: MCP server 是 x-code 的子进程, setx 写注册表后
必须重启 x-code 才生效; config.json 手改即存, 只需重启 x-code 里的
skills server(或整个 x-code), 少一层坑, 且 key 不进 git。

格式:
{
  "embedder": { "provider": "zhipu", "api_key": "..." }
}
provider: zhipu / siliconflow; 省略 api_key → FakeEmbedder 降级。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

_DEFAULT_PATH = Path(__file__).parent.parent.parent / "config.json"


def load(path: Optional[Path] = None,
         env: Optional[dict[str, str]] = None) -> dict:
    """合并 config.json 与环境变量, 文件优先。坏文件 → 当作不存在。"""
    cfg: dict = {}
    p = Path(path) if path else _DEFAULT_PATH
    try:
        if p.exists():
            cfg = json.loads(p.read_text(encoding="utf-8"))
            if not isinstance(cfg, dict):
                cfg = {}
    except (json.JSONDecodeError, OSError):
        cfg = {}

    env = env if env is not None else os.environ
    emb = dict(cfg.get("embedder") or {})
    provider = emb.get("provider") or env.get("MC_EMBEDDER_PROVIDER", "")
    if not provider:
        if env.get("ZHIPU_API_KEY") or env.get("MC_EMBEDDER_API_KEY"):
            provider = "zhipu"
        elif env.get("SILICONFLOW_API_KEY"):
            provider = "siliconflow"
    emb.setdefault("provider", provider)
    if not emb.get("api_key"):
        emb["api_key"] = (env.get("ZHIPU_API_KEY")
                          or env.get("MC_EMBEDDER_API_KEY")
                          or env.get("SILICONFLOW_API_KEY") or "")
    return {**cfg, "embedder": emb}
