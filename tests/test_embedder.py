"""embedder 层测试: 协议、确定性、API 客户端参数与降级路径。

FakeEmbedder 用确定性哈希向量: 让语义检索管线/路由的测试零网络、零 mock 框架。
SiliconFlowEmbedder 只测参数组装与错误分类, 不打真实网络(避免 flaky)。
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from mc_skill_library.core.embedder import (   # noqa: E402
    EmbeddingError, FakeEmbedder, SiliconFlowEmbedder,
)


def test_fake_embedder_deterministic_and_dim():
    e = FakeEmbedder(dim=64)
    a = e.embed("帮我弄个住的地方")
    b = e.embed("帮我弄个住的地方")
    assert a == b                                  # 确定性: 同文本同向量
    assert len(a) == 64 and isinstance(a[0], float)


def test_fake_embedder_different_texts_differ():
    e = FakeEmbedder(dim=32)
    assert e.embed("伐木") != e.embed("盖房子")


def test_fake_embedder_empty_text_no_crash():
    e = FakeEmbedder(dim=8)
    v = e.embed("")
    assert len(v) == 8                             # 空文本也给合法向量


def test_siliconflow_request_shape(monkeypatch):
    """请求按 BAAI/bge-m-zh 规格组装; 返回按 index 对齐——不依赖列表顺序。"""
    captured = {}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            # 故意乱序返回, 验证按 index 还原
            return {"data": [
                {"index": 1, "embedding": [0.0, 1.0]},
                {"index": 0, "embedding": [1.0, 0.0]},
            ]}

    def fake_post(url, **kw):
        captured.update(kw, url=url)
        return FakeResp()

    monkeypatch.setattr(
        "mc_skill_library.core.embedder.httpx.post", fake_post)
    e = SiliconFlowEmbedder(api_key="test-key")
    out = e.embed_batch(["第一条", "第二条"])
    assert captured["url"].endswith("/v1/embeddings")
    assert captured["headers"]["Authorization"] == "Bearer test-key"
    assert captured["json"]["model"] == "BAAI/bge-m3"
    assert captured["json"]["input"] == ["第一条", "第二条"]
    assert out == [[1.0, 0.0], [0.0, 1.0]]         # 按 index 对齐


def test_siliconflow_error_wrapped(monkeypatch):
    """网络/HTTP 异常统一包成 EmbeddingError, 让上层能选择降级。"""

    def fake_post(url, **kw):
        raise ConnectionError("boom")

    monkeypatch.setattr(
        "mc_skill_library.core.embedder.httpx.post", fake_post)
    e = SiliconFlowEmbedder(api_key="k")
    with pytest.raises(EmbeddingError):
        e.embed_batch(["x"])
