# Muknoon Kids AI — v0.3 Voice-to-Voice

A parent-supervised local educational demo for children aged 4–7. Next.js 15 frontend + FastAPI backend. Includes the existing farm animal picture game and a new **Talk to Muknoon** push-to-talk conversation.

## What works

- Tap the microphone, talk for up to 12 seconds, and tap again to send.
- OpenAI speech-to-text → short, age-appropriate AI reply → generated English MP3 speech.
- Muknoon's robot mouth animates while the generated audio plays.
- A parent enters a configurable PIN to start a 15-minute session (up to 20 turns).
- Chat memory is short-lived in RAM only; there is **no database** and no audio file storage.
- Animal picture game works without AI. Voice recognition and natural speech require an active parent-authorized session.

This is a **prototype, not a production-ready children's service**. Parent supervision is required. Never expose it publicly without further security/privacy review, a proper parent identity solution, and legal review of your jurisdiction's child-privacy obligations.

## Ubuntu / Docker quickstart

~~~bash
git clone https://github.com/odooproptech/kids-ai-buddy.git
cd kids-ai-buddy
cp .env.example .env
nano .env
~~~

Set these values in your local .env file:

~~~dotenv
OPENAI_API_KEY=your-private-openai-api-key
PARENT_PIN=choose-a-private-pin-at-least-4-characters
STT_MODEL=gpt-4o-mini-transcribe
CHAT_MODEL=gpt-4.1-mini
~~~

Do **not** commit .env or share the parent PIN or API key.

~~~bash
docker compose up -d --build
docker compose ps
curl http://localhost:8000/health
~~~

Open **http://localhost:3000** on the same computer. Enter the parent PIN, click **Start voice time**, then choose **Talk to Muknoon**. Grant your browser microphone permission. Ask “Hello Muknoon! Teach me shapes!”

The Next.js \`/api/*\` rewrite targets \`http://api:8000/api/*\` within Docker Compose. If running Next.js outside Docker, set \`API_INTERNAL_URL=http://127.0.0.1:8000\` during its build.

Both published ports are bound to the local loopback address for safety. On a different machine, use an authenticated HTTPS reverse proxy only after a security review.

## Diagnostics

~~~bash
docker compose logs -f --tail=100 web api
docker compose exec api python -c "import os; print(bool(os.getenv('OPENAI_API_KEY')))"
~~~

Microphones generally require \`localhost\` or HTTPS. OpenAI API usage is billed separately from ChatGPT subscriptions. If voice fails, check OpenAI API credits, model access, .env configuration, and Docker logs.

## Developer tests

~~~bash
cd apps/api
python -m pip install -r requirements.txt
pytest -q
~~~

Run the frontend build with \`cd apps/web && npm install && npm run build\`.

## Privacy and limitations

- Audio is sent to OpenAI for transcription; AI text and generated speech are also processed by OpenAI under its API data-handling terms.
- The app itself does not write audio/transcripts to disk, but upstream service retention is governed by the provider's policies. Parents should avoid sharing identifying information.
- Sessions and the last six chat messages are held in Python memory and disappear on API restart or when the session ends. In-flight requests may finish even after a parent ends a session.
- The parent PIN is a **basic demo gate**, not identity verification. Rate-limiting is in-memory and unsuitable for internet deployment.
- This is **turn-based** voice-to-voice, not streaming real-time conversation.
- The model is instructed to stay educational, but no AI safety prompt guarantees perfect responses. Adult supervision is essential.


## Qwen LLM provider

Muknoon uses **Qwen** for the tutor's text responses via the DashScope OpenAI-compatible Chat Completions API. Set `DASHSCOPE_API_KEY` in `.env` and optionally `QWEN_MODEL` (default `qwen-plus`) and `QWEN_BASE_URL` (default international endpoint). **Do not expose keys to the browser or commit them.** The current voice pipeline still uses `OPENAI_API_KEY` for speech recognition and speech synthesis; Qwen replaces only the LLM. The parent's PIN and existing voice session limits remain in place. The two API providers may process children's audio/transcripts; obtain parental consent and review data handling before use.
