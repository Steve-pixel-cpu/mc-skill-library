"""config 加载测试: JSON 配置文件优先于环境变量, key 不落 git。

设计: 项目根 config.json { "embedder": {...} }, 手改即生效(MCP server
是长驻子进程, 重启 x-code 才重载; 但比环境变量少一层"新终端"的坑)。
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from mc_skill_library.core import config   # noqa: E402


def test_load_missing_file_returns_empty(tmp_path, monkeypatch):
    monkeypatch.delenv("ZHIPU_API_KEY", raising=False)
    monkeypatch.delenv("MC_EMBEDDER_API_KEY", raising=False)
    monkeypatch.delenv("SILICONFLOW_API_KEY", raising=False)
    monkeypatch.delenv("MC_EMBEDDER_PROVIDER", raising=False)
    # 无文件无环境变量 → 形状统一的空配置(降级 FakeEmbedder)
    assert config.load(tmp_path / "nope.json") == \
        {"embedder": {"provider": "", "api_key": ""}}


def test_load_json_config(tmp_path):
    f = tmp_path / "config.json"
    f.write_text(json.dumps({"embedder": {"provider": "zhipu",
                                          "api_key": "k1"}}),
                 encoding="utf-8")
    assert config.load(f)["embedder"]["api_key"] == "k1"


def test_broken_json_returns_empty(tmp_path):
    f = tmp_path / "config.json"
    f.write_text("{ not json", encoding="utf-8")
    assert config.load(f) == {"embedder": {"provider": "", "api_key": ""}}


def test_env_fallback_when_no_file(tmp_path, monkeypatch):
    monkeypatch.setenv("ZHIPU_API_KEY", "env-key")
    cfg = config.load(tmp_path / "nope.json",
                      env={"ZHIPU_API_KEY": "env-key"})
    assert cfg["embedder"]["api_key"] == "env-key"
    assert cfg["embedder"]["provider"] == "zhipu"


def test_file_overrides_env(tmp_path, monkeypatch):
    f = tmp_path / "config.json"
    f.write_text(json.dumps({"embedder": {"provider": "zhipu",
                                          "api_key": "file-key"}}),
                 encoding="utf-8")
    cfg = config.load(f, env={"ZHIPU_API_KEY": "env-key"})
    assert cfg["embedder"]["api_key"] == "file-key"   # 文件优先


def test_make_embedder_from_config(tmp_path):
    from mc_skill_library.core.config import load
    from mc_skill_library.core.embedder import ZhipuEmbedder, make_embedder
    f = tmp_path / "config.json"
    f.write_text(json.dumps({"embedder": {"provider": "zhipu",
                                          "api_key": "cfg-key"}}),
                 encoding="utf-8")
    e = make_embedder(config=load(f))
    assert isinstance(e, ZhipuEmbedder)
    assert e.api_key == "cfg-key"
