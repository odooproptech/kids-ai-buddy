import io
import os
import re
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Little Buddy API", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"], allow_methods=["GET", "POST"], allow_headers=["*"])
ANIMALS = {"cow": ("moo", {"cow", "moo"}), "cat": ("meow", {"cat", "meow", "kitty"}), "dog": ("woof", {"dog", "woof", "puppy"})}
MAX_AUDIO = 2_000_000

class Answer(BaseModel):
    transcript: str
    correct: bool
    reply: str
    animal: str

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

@app.get("/health")
def health():
    return {"status": "ok", "mode": "ai-enabled" if os.getenv("OPENAI_API_KEY") else "local-demo"}

@app.get("/api/lessons")
def lessons():
    return [{"id": "farm-animals", "title": "Farm Animals", "activity_count": 3}]

@app.post("/api/voice/answer", response_model=Answer)
async def voice_answer(animal: str = Form(...), audio: UploadFile = File(...)):
    if animal not in ANIMALS:
        raise HTTPException(400, "Unknown activity")
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(503, "AI voice requires OPENAI_API_KEY. Picture choices still work.")
    if audio.content_type not in {"audio/webm", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg", "audio/x-wav"}:
        raise HTTPException(415, "Unsupported audio format")
    data = await audio.read(MAX_AUDIO + 1)
    if not data or len(data) > MAX_AUDIO:
        raise HTTPException(413, "Recording must be under 2 MB")
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=key, timeout=25.0)
        ext = {"audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3"}[audio.content_type]
        result = await client.audio.transcriptions.create(model=os.getenv("STT_MODEL", "gpt-transcribe"), file=(f"answer.{ext}", io.BytesIO(data), audio.content_type), prompt="A young child is answering a farm animal question with cow, cat, or dog.")
        return evaluate(result.text, animal)
    except Exception:
        raise HTTPException(502, "Speech service unavailable. Please use the picture choices.")

class SpeechRequest(BaseModel):
    text: str

@app.post("/api/voice/speak")
async def voice_speak(body: SpeechRequest):
    from fastapi.responses import Response
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(503, "AI voice requires OPENAI_API_KEY")
    if not body.text or len(body.text) > 300:
        raise HTTPException(400, "Text length must be 1–300")
    # Only approved, short lesson phrases are synthesized; no arbitrary child input.
    allowed = ["hello", "which animal", "great job", "nice try", "wonderful", "amazing", "good try", "i couldn't hear", "let's say"]
    if not any(body.text.lower().startswith(p) for p in allowed):
        raise HTTPException(400, "Unapproved lesson phrase")
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=key, timeout=25.0)
        result = await client.audio.speech.create(model="gpt-4o-mini-tts", voice="coral", input=body.text, instructions="Speak warmly, clearly and slowly to a young English learner.", response_format="mp3")
        return Response(content=result.content, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
    except Exception:
        raise HTTPException(502, "Voice playback service unavailable")
