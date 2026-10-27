import base64
import sys
from types import SimpleNamespace

from fastapi.testclient import TestClient
from app.main import app, _sessions

client = TestClient(app)


def start_voice(monkeypatch):
    monkeypatch.setenv("PARENT_PIN", "842963")
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-only")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "qwen-test-only")
    result = client.post("/api/voice/session", json={"pin": "842963"})
    assert result.status_code == 200
    return result.json()["session_token"]


def test_health():
    assert client.get("/health").json()["status"] == "ok"


def test_lessons():
    assert client.get("/api/lessons").json()[0]["id"] == "farm-animals"


def test_parent_pin_required(monkeypatch):
    monkeypatch.delenv("PARENT_PIN", raising=False)
    result = client.post("/api/voice/session", json={"pin": "1234"})
    assert result.status_code == 503


def test_wrong_parent_pin(monkeypatch):
    monkeypatch.setenv("PARENT_PIN", "842963")
    result = client.post("/api/voice/session", json={"pin": "0000"})
    assert result.status_code == 403


def test_session_end_revokes_token(monkeypatch):
    token = start_voice(monkeypatch)
    assert token in _sessions
    assert client.post("/api/voice/session/end", json={"session_token": token}).status_code == 200
    assert token not in _sessions


def test_chat_rejects_invalid_token(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-only")
    result = client.post(
        "/api/voice/chat",
        data={"session_token": "x" * 32},
        files={"audio": ("child.webm", b"fake", "audio/webm")},
    )
    assert result.status_code == 401


def test_chat_rejects_wrong_media_type(monkeypatch):
    token = start_voice(monkeypatch)
    result = client.post(
        "/api/voice/chat",
        data={"session_token": token},
        files={"audio": ("child.txt", b"hello", "text/plain")},
    )
    assert result.status_code == 415


def test_tts_requires_approved_phrase(monkeypatch):
    token = start_voice(monkeypatch)
    result = client.post("/api/voice/speak", json={
        "session_token": token, "text": "Please read an entire novel.",
    })
    assert result.status_code == 400


def test_chat_transcribes_and_speaks(monkeypatch):
    token = start_voice(monkeypatch)

    class FakeTranscription:
        async def create(self, **kwargs):
            assert kwargs["model"] == "gpt-4o-mini-transcribe"
            return SimpleNamespace(text="What is a circle?")

    class FakeCompletions:
        async def create(self, **kwargs):
            assert kwargs["model"] == "qwen-plus"
            assert "personal information" in kwargs["messages"][0]["content"]
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="A circle is round! Can you draw one?"))])

    class FakeSpeech:
        async def create(self, **kwargs):
            assert kwargs["voice"] == "coral"
            return SimpleNamespace(content=b"fake mp3 data")

    class FakeOpenAI:
        def __init__(self, **kwargs):
            assert kwargs["api_key"] in ("unit-test-only", "qwen-test-only")
            self.chat = SimpleNamespace(completions=FakeCompletions())
            self.audio = SimpleNamespace(
                transcriptions=FakeTranscription(), speech=FakeSpeech(),
            )


    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(AsyncOpenAI=FakeOpenAI))
    result = client.post(
        "/api/voice/chat",
        data={"session_token": token},
        files={"audio": ("child.webm", b"fake webm bytes", "audio/webm")},
    )
    assert result.status_code == 200, result.text
    payload = result.json()
    assert payload["transcript"] == "What is a circle?"
    assert payload["reply"] == "A circle is round! Can you draw one?"
    assert base64.b64decode(payload["audio_base64"]) == b"fake mp3 data"
    assert len(_sessions[token]["history"]) == 2
