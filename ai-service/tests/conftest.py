import base64
import io
import json
import sys
from pathlib import Path

import httpx
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402


def pytest_addoption(parser):
    parser.addoption("--run-gpu", action="store_true", help="run tests that call the real Ollama model")


def pytest_configure(config):
    config.addinivalue_line("markers", "gpu: calls the real model (needs --run-gpu)")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--run-gpu"):
        return
    skip = pytest.mark.skip(reason="needs --run-gpu")
    for item in items:
        if "gpu" in item.keywords:
            item.add_marker(skip)


def make_settings(**overrides):
    base = dict(host="127.0.0.1", port=8088, token=None, ollama_url="http://ollama.test",
                vision_model="vision:test", text_model="text:test", ocr_enabled=False,
                scan_min_confidence=0.6, ollama_timeout_s=5, keep_alive="1m", max_image_side=512)
    base.update(overrides)
    return Settings(**base)


def jpeg_b64(color=(200, 30, 30), size=(320, 480)) -> str:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "JPEG")
    return base64.b64encode(buf.getvalue()).decode()


class FakeOllama:
    """Records requests and answers /api/chat with queued JSON contents."""

    def __init__(self, models=("vision:test", "text:test")):
        self.models = list(models)
        self.replies: list = []
        self.requests: list[dict] = []
        self.status = 200

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": m} for m in self.models]})
        body = json.loads(request.content)
        self.requests.append(body)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": "x"})
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        content = reply if isinstance(reply, str) else json.dumps(reply)
        return httpx.Response(200, json={"message": {"role": "assistant", "content": content}})


@pytest.fixture
def fake():
    return FakeOllama()


@pytest.fixture
def client_factory(fake):
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.ollama_client import OllamaClient

    def build(**overrides):
        settings = make_settings(**overrides)
        ollama = OllamaClient(settings, transport=httpx.MockTransport(fake.handler))
        return TestClient(create_app(settings, ollama))

    return build
