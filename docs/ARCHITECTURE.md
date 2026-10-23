# Architecture

Current: Next.js client-side scripted lesson; browser speech synthesis and local MediaRecorder; FastAPI service with health and lesson listing. Docker Compose for local testing. No database or external AI services are connected.

Target: parent authentication, role-checked API, PostgreSQL with SQLAlchemy/Alembic, versioned approved curriculum, deterministic answer evaluator, restricted conversation orchestrator, STT/TTS provider adapters, moderation and parent controls. No unrestricted child chatbot.

Security gates before public deployment: authentication, authorization, session expiration, rate limiting, consent and deletion controls, audio retention policy, third-party processor review, child privacy legal review, monitoring, and abuse testing.
