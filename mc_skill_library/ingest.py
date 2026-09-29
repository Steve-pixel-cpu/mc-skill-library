"""ingest: 轻量入库 CLI — mcbridge(thinker) 学会新技能后上报语义库。

为什么不走 MCP: stdio server 已被 x-code 占用, 再起一个握手太重;
CLI 子进程一行调用, 失败也不影响 bot 主流程(thinker 侧已容错)。

用法:
  python ingest.py --name bridge_crossing --description "过河搭桥" --code-file skills/bridge_crossing.js
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mc_skill_library.store import Skill, SkillStore   # noqa: E402

try:
    from mc_skill_library.embedder import get_embedder  # 阶段2+ 语义入库
    from mc_skill_library.store import SkillStore as _S
    _HAS_EMBEDDER = True
except ImportError:
    _HAS_EMBEDDER = False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--description", required=True)
    ap.add_argument("--code-file", required=True)
    ap.add_argument("--tags", default="learned,self-taught")
    args = ap.parse_args()

    code = Path(args.code_file).read_text(encoding="utf-8")
    store = SkillStore(Path(__file__).resolve().parent.parent / "skills")

    if _HAS_EMBEDDER:
        try:
            get_embedder()   # 预热验证 key 可用; 失败则退化为纯存储
        except Exception as e:
            print(f"(embedding 不可用, 仅入库元数据: {e})")

    msg = store.save(Skill(
        name=args.name,
        description=args.description,
        code=code,
        tags=[t.strip() for t in args.tags.split(",") if t.strip()],
    ))
    print(msg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
