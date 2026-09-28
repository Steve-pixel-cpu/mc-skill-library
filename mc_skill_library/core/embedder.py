"""Embedding 抽象层: 协议 + 确定性假实现 + SiliconFlow API 实现。

- 协议 embed/embed_batch: 单条与批量, 返回 float 列表
- FakeEmbedder: 种子哈希确定性向量, 供测试与离线开发, 零网络
- SiliconFlowEmbedder: BAAI/bge-m3(免费档, 1024 维, 中英双语)
- API key 从 MC_EMBEDDER_API_KEY 或 SILICONFLOW_API_KEY 读;
  都没有时 make_embedder() 返回 FakeEmbedder(检索质量降级但功能可用)
"""

from __future__ import annotations

import hashlib
import math
import os
from typing import Protocol

import httpx

_API_URL = "https://api.siliconflow.cn/v1/embeddings"
_MODEL = "BAAI/bge-m3"
_ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4/embeddings"
_TIMEOUT = 30.0


class EmbeddingError(Exception):
    """embedding 调用失败(网络/HTTP/响应格式)。上层可捕获后降级为关键词检索。"""


class Embedder(Protocol):
    def embed(self, text: str) -> list[float]: ...
    def embed_batch(self, texts: list[str]) -> list[list[float]]: ...


class FakeEmbedder:
    """确定性伪 embedding: SHA-256 种子 → 伪随机向量。

    没有语义能力(相同文本才相同向量), 用于测试管线/路由/降级路径,
    保证「无 API key 也能全链路跑通」。
    """

    def __init__(self, dim: int = 1024):
        self.dim = dim

    def embed(self, text: str) -> list[float]:
        # 每 8 字节取一个 float 种子 → 归一化向量; 空文本也能产出
        raw = hashlib.sha256(text.encode("utf-8")).digest()
        while len(raw) < self.dim * 4:
            raw += hashlib.sha256(raw).digest()
        vals = []
        for i in range(self.dim):
            chunk = raw[i * 4:i * 4 + 4]
            vals.append(int.from_bytes(chunk, "big") / 2**32 - 0.5)
        norm = math.sqrt(sum(v * v for v in vals)) or 1.0
        return [v / norm for v in vals]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [self.embed(t) for t in texts]


class SiliconFlowEmbedder:
    """SiliconFlow embeddings API(BAAI/bge-m3, 免费档)。"""

    def __init__(self, api_key: str, model: str = _MODEL):
        self.api_key = api_key
        self.model = model

    def embed(self, text: str) -> list[float]:
        return self.embed_batch([text])[0]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        try:
            resp = httpx.post(
                _API_URL,
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={"model": self.model, "input": texts},
                timeout=_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()["data"]
        except (httpx.HTTPError, OSError) as e:
            raise EmbeddingError(f"SiliconFlow 请求失败: {e}") from e
        except (KeyError, ValueError) as e:
            raise EmbeddingError(f"SiliconFlow 响应格式异常: {e}") from e
        # API 不保证返回有序, 按 index 对齐
        return [d["embedding"] for d in sorted(data, key=lambda d: d["index"])]


class ZhipuEmbedder:
    """智谱 GLM embedding-3(OpenAI 兼容格式, 256/512/1024/2048 维可选)。

    免费档够项目用; dimensions 默认 1024 与 brute 检索器的假设一致。
    """

    def __init__(self, api_key: str, model: str = "embedding-3",
                 dimensions: int = 1024):
        self.api_key = api_key
        self.model = model
        self.dimensions = dimensions

    def embed(self, text: str) -> list[float]:
        return self.embed_batch([text])[0]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        try:
            resp = httpx.post(
                _ZHIPU_URL,
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={"model": self.model, "input": texts,
                      "dimensions": self.dimensions},
                timeout=_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()["data"]
        except (httpx.HTTPError, OSError) as e:
            raise EmbeddingError(f"智谱请求失败: {e}") from e
        except (KeyError, ValueError) as e:
            raise EmbeddingError(f"智谱响应格式异常: {e}") from e
        return [d["embedding"]
                for d in sorted(data, key=lambda d: d["index"])]


def make_embedder(config: Optional[dict] = None) -> Embedder:
    """工厂: 优先传 config(core/config.load 的结果), 不传则 load()
    (config.json 优先, 环境变量兜底)。
    provider: zhipu/siliconflow; 无 key → FakeEmbedder(确定性降级)。"""
    if config is None:
        from .config import load
        config = load()
    emb = config.get("embedder") or {}
    provider = str(emb.get("provider", "")).lower()
    key = emb.get("api_key") or ""
    if provider in ("zhipu", "glm") and key:
        return ZhipuEmbedder(key)
    if provider in ("siliconflow", "sf") and key:
        return SiliconFlowEmbedder(key)
    return FakeEmbedder()
