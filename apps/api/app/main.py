import asyncio
import base64
import hmac
import io
import os
import re
import secrets
import time
from collections import defaultdict
from typing import Annotated

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

app = FastAPI(title="Little Buddy API", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

ANIMALS = {
    "cow": ("moo", {"cow", "moo"}),
    "cat": ("meow", {"cat", "meow", "kitty"}),
    "dog": ("woof", {"dog", "woof", "puppy"}),
}
MIME_EXTENSIONS = {
    "audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3",
}
MAX_AUDIO_BYTES = 2_000_000
SESSION_SECONDS = 15 * 60
MAX_TURNS = 20
MAX_SESSIONS = 100
MODEL = "gpt-4.1-mini"
TUTOR_INSTRUCTIONS = (
    "You are Little Buddy, a warm, cheerful English tutor for children aged 4 to 7. "
    "Speak only in clear, very simple English. Use at most 2 short sentences, "
    "maximum 35 words. Ask only one easy question at a time. "
    "Help the child learn shapes, colors, animals, counting, and letter sounds. "
    "Praise effort, never shame mistakes. Politely redirect unrelated requests to learning. "
    "Never ask for or repeat personal information (names, addresses, schools, contact details). "
    "Do not discuss mature or frightening topics. If the child needs real-world help, "
    "ask them to speak to a trusted grown-up. Do not claim to be a human."
)

# In-memory state only. Restarting the API intentionally ends sessions and erases history.
_sessions: dict[str, dict] = {}
_failed_pins: dict[str, list[float]] = defaultdict(list)
_state_lock = asyncio.Lock()


class Answer(BaseModel):
    transcript: str
    correct: bool
    reply: str
    animal: str


class StartSession(BaseModel):
    pin: str = Field(min_length=4, max_length=64)


class EndSession(BaseModel):
    session_token: str = Field(min_length=16, max_length=128)


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    session_token: str = Field(min_length=16, max_length=128)


def evaluate(transcript: str, animal: str) -> Answer:
    if animal not in ANIMALS:
        raise HTTPException(400, "Unknown activity")
    words = set(re.findall(r"[a-z]+", transcript.lower()))
    correct = bool(words & ANIMALS[animal][1])
    if not words:
        reply = f"I couldn't hear you. Try saying {animal}!"
    elif correct:
        reply = f"Wonderful! Yes, that's a {animal}! You earned a star!"
    else:
        reply = f"Good try! Let's say {animal} together."
    return Answer(transcript=transcript[:300], correct=correct, reply=reply, animal=animal)


def get_key() -> str:
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        raise HTTPException(503, "AI voice is not configured")
    return key


def require_session(token: str) -> dict:
    session = _sessions.get(token)
    if not session or session["expires_at"] <= time.monotonic():
        _sessions.pop(token, None)
        raise HTTPException(401, "Voice session has ended. Ask a parent to start another.")
    return session


async def read_audio(audio: UploadFile) -> tuple[bytes, str]:
    mime = (audio.content_type or "").split(";")[0].strip().lower()
    if mime not in MIME_EXTENSIONS:
        raise HTTPException(415, "Unsupported audio format")
    data = await audio.read(MAX_AUDIO_BYTES + 1)
    if not data or len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Recording must be under 2 MB")
    return data, mime


def safe_reply(text: str) -> str:
    # Bound TTS cost and duration even if the model ignores the length instruction.
    clean = " ".join(text.strip().split())
    return clean[:280].rsplit(" ", 1)[0] if len(clean) > 280 else clean


@app.get("/health")
def health():
    return {"status": "ok", "mode": "ai-enabled" if os.getenv("OPENAI_API_KEY") else "local-demo"}


@app.get("/api/lessons")
def lessons():
    return [{"id": "farm-animals", "title": "Farm Animals", "activity_count": 3}]


@app.post("/api/voice/session")
async def start_session(body: StartSession, request: Request):
    parent_pin = os.getenv("PARENT_PIN", "")
    if len(parent_pin) < 4:
        raise HTTPException(503, "Set PARENT_PIN in .env before enabling voice.")
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    async with _state_lock:
        attempts = [t for t in _failed_pins[ip] if now - t < 300]
        _failed_pins[ip] = attempts
        if len(attempts) >= 5:
            raise HTTPException(429, "Too many attempts. Try again in five minutes.")
        if not hmac.compare_digest(body.pin, parent_pin):
            _failed_pins[ip].append(now)
            raise HTTPException(403, "Incorrect parent PIN")
        _failed_pins.pop(ip, None)
        # Remove expired sessions and bound resource use.
        for token, state in list(_sessions.items()):
            if state["expires_at"] <= now:
                _sessions.pop(token, None)
        if len(_sessions) >= MAX_SESSIONS:
            raise HTTPException(503, "Too many active voice sessions")
        token = secrets.token_urlsafe(32)
        _sessions[token] = {
            "expires_at": now + SESSION_SECONDS,
            "history": [],
            "turns": 0,
            "last_turn": 0.0,
            "busy": False,
        }
    return {"session_token": token, "expires_in_seconds": SESSION_SECONDS}


@app.post("/api/voice/session/end")
def end_session(body: EndSession):
    _sessions.pop(body.session_token, None)
    return {"ended": True}


@app.post("/api/voice/answer", response_model=Answer)
async def voice_answer(
    animal: Annotated[str, Form(...)],
    session_token: Annotated[str, Form(...)],
    audio: UploadFile = File(...),
):
    session = require_session(session_token)
    if animal not in ANIMALS:
        raise HTTPException(400, "Unknown activity")
    key = get_key()
    data, mime = await read_audio(audio)
    if session["turns"] >= MAX_TURNS:
        raise HTTPException(429, "Session limit reached")
    session["turns"] += 1
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=key, timeout=30.0)
        result = await client.audio.transcriptions.create(
            model=os.getenv("STT_MODEL", "gpt-4o-mini-transcribe"),
            file=(f"answer.{MIME_EXTENSIONS[mime]}", io.BytesIO(data), mime),
            prompt="A young child is saying an animal name such as cow, cat or dog.",
        )
        return evaluate(result.text, animal)
    except Exception:
        raise HTTPException(502, "Speech recognition unavailable. Please use picture choices.")


# Fixed lesson phrases only: callers cannot synthesize arbitrary text at our expense.
LESSON_PHRASES = {
    "Hello, superstar! Let's play with farm animals. Which animal says moo?",
    "Amazing! You finished the animal game!",
    "Well done for trying! You finished the animal game!",
}
for sound in ("meow", "woof"):
    for prefix in ("Great job!", "Nice try!"):
        LESSON_PHRASES.add(f"{prefix} Which animal says {sound}?")


@app.post("/api/voice/speak")
async def voice_speak(body: SpeechRequest):
    require_session(body.session_token)
    if body.text not in LESSON_PHRASES:
        raise HTTPException(400, "Unapproved lesson phrase")
    key = get_key()
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=key, timeout=30.0)
        result = await client.audio.speech.create(
            model="gpt-4o-mini-tts", voice="coral", input=body.text,
            instructions="Speak slowly, warmly and clearly for a young English learner.",
            response_format="mp3",
        )
        return Response(content=result.content, media_type="audio/mpeg",
                        headers={"Cache-Control": "no-store"})
    except Exception:
        raise HTTPException(502, "Voice playback unavailable")


@app.post("/api/voice/chat")
async def voice_chat(
    session_token: Annotated[str, Form(...)],
    audio: UploadFile = File(...),
):
    state = require_session(session_token)
    key = get_key()
    data, mime = await read_audio(audio)
    now = time.monotonic()
    async with _state_lock:
        if state["busy"]:
            raise HTTPException(409, "Buddy is finishing the previous response")
        if state["turns"] >= MAX_TURNS:
            raise HTTPException(429, "Session limit reached. Ask a parent to restart.")
        if now - state["last_turn"] < 2:
            raise HTTPException(429, "Please wait before speaking again")
        state["busy"] = True
        state["last_turn"] = now
        state["turns"] += 1
        context = list(state["history"][-6:])
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=key, timeout=35.0)
        result = await client.audio.transcriptions.create(
            model=os.getenv("STT_MODEL", "gpt-4o-mini-transcribe"),
            file=(f"child.{MIME_EXTENSIONS[mime]}", io.BytesIO(data), mime),
            prompt="A child aged 4 to 7 is practicing simple English about animals, shapes, colors and numbers.",
        )
        transcript = (result.text or "").strip()[:200]
        if not transcript:
            return {"transcript": "", "reply": "I couldn't hear you. Can you try again?",
                    "audio_base64": "", "audio_mime": "audio/mpeg"}
        response = await client.responses.create(
            model=os.getenv("CHAT_MODEL", MODEL),
            instructions=TUTOR_INSTRUCTIONS,
            input=context + [{"role": "user", "content": transcript}],
            max_output_tokens=120,
            store=False,
        )
        reply = safe_reply(response.output_text or "")
        if not reply:
            reply = "Let's learn! Can you name a color?"
        speech = await client.audio.speech.create(
            model="gpt-4o-mini-tts",
            voice="coral",
            input=reply,
            instructions="Speak very clearly, gently and slowly in English for a child aged four to seven. Pause naturally.",
            response_format="mp3",
        )
        if require_session(session_token) is not state:
            raise HTTPException(401, "Voice session expired")
        state["history"] = (context + [
            {"role": "user", "content": transcript},
            {"role": "assistant", "content": reply},
        ])[-6:]
        return {
            "transcript": transcript,
            "reply": reply,
            "audio_base64": base64.b64encode(speech.content).decode("ascii"),
            "audio_mime": "audio/mpeg",
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(502, "Buddy couldn't respond right now. Please try again.")
    finally:
        state["busy"] = False
