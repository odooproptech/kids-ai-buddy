"use client";

import { useEffect, useRef, useState } from "react";

type Mood = "idle" | "listening" | "thinking" | "speaking" | "happy" | "retry";
type Mode = "game" | "chat";
type ChatResult = { transcript: string; reply: string; audio_base64: string; audio_mime: string };
type AnswerResult = { transcript: string; correct: boolean; reply: string };

const activities = [
  { animal: "cow", emoji: "🐄", sound: "moo", choices: ["🐄", "🐈", "🐕"], answer: "🐄" },
  { animal: "cat", emoji: "🐈", sound: "meow", choices: ["🐕", "🐈", "🐄"], answer: "🐈" },
  { animal: "dog", emoji: "🐕", sound: "woof", choices: ["🐄", "🐕", "🐈"], answer: "🐕" },
];
const MAX_RECORDING_MS = 12_000;

function decodeAudio(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes.buffer as ArrayBuffer], { type: mime });
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("chat");
  const [mood, setMood] = useState<Mood>("idle");
  const [message, setMessage] = useState("Hi, friend! Ask a parent to start talking with Buddy.");
  const [parentPin, setParentPin] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [recording, setRecording] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [micError, setMicError] = useState("");
  const [childSaid, setChildSaid] = useState("");
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [step, setStep] = useState(0);
  const [stars, setStars] = useState(0);

  const tokenRef = useRef("");
  const modeRef = useRef<Mode>("chat");
  const stepRef = useRef(0);
  const finishedRef = useRef(false);
  const busyRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackUrlRef = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      requestRef.current?.abort();
      if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current);
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      audioRef.current?.pause();
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
    };
  }, []);

  function stopAudio() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    setMood("idle");
  }

  async function playAudio(blob: Blob) {
    stopAudio();
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
    const url = URL.createObjectURL(blob);
    playbackUrlRef.current = url;
    if (muted) return;
    const player = new Audio(url);
    audioRef.current = player;
    player.onplay = () => setMood("speaking");
    player.onended = () => { if (audioRef.current === player) { audioRef.current = null; setMood("idle"); } };
    player.onerror = () => { setMicError("Audio playback failed."); setMood("idle"); };
    try { await player.play(); }
    catch { setMicError("Tap Hear Again to enable sound in your browser."); setMood("idle"); }
  }

  async function speakLesson(text: string) {
    setMessage(text);
    if (!tokenRef.current || muted) return;
    stopAudio();
    const ctrl = new AbortController();
    requestRef.current = ctrl;
    setMood("thinking");
    try {
      const response = await fetch("/api/voice/speak", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, session_token: tokenRef.current }),
        signal: ctrl.signal,
      });
      if (!response.ok) throw new Error("Natural voice is unavailable.");
      const audio = await response.blob();
      if (!ctrl.signal.aborted && tokenRef.current) await playAudio(audio);
    } catch (err) {
      if (!ctrl.signal.aborted) { setMicError(err instanceof Error ? err.message : "Voice unavailable"); setMood("idle"); }
    } finally { if (requestRef.current === ctrl) requestRef.current = null; }
  }

  async function startSession() {
    if (sessionBusy) return;
    setMicError("");
    setSessionBusy(true);
    try {
      const response = await fetch("/api/voice/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: parentPin }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Unable to start parent session.");
      tokenRef.current = result.session_token;
      setUnlocked(true);
      setParentPin("");
      setMode("chat");
      modeRef.current = "chat";
      setChildSaid("");
      setMessage("Hi, superstar! Tap the microphone and tell me about your favorite color!");
    } catch (err) { setMicError(err instanceof Error ? err.message : "Could not start session."); }
    finally { setSessionBusy(false); }
  }

  function stopRecording(cancel = false) {
    if (recordingTimerRef.current) { clearTimeout(recordingTimerRef.current); recordingTimerRef.current = null; }
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      if (cancel) recorder.onstop = null;
      recorder.stop();
    }
    if (cancel) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
    }
    setRecording(false);
  }

  async function endSession() {
    const previous = tokenRef.current;
    tokenRef.current = "";
    setUnlocked(false);
    stopRecording(true);
    requestRef.current?.abort();
    stopAudio();
    setChildSaid("");
    setMessage("Voice session ended. Ask a parent to start another.");
    if (previous) {
      try {
        await fetch("/api/voice/session/end", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_token: previous }),
        });
      } catch { /* API restart also clears server-side sessions */ }
    }
  }

  function startGame() {
    if (busyRef.current || recording) return;
    setStarted(true); setFinished(false); finishedRef.current = false;
    setStep(0); stepRef.current = 0; setStars(0);
    void speakLesson("Hello, superstar! Let's play with farm animals. Which animal says moo?");
  }

  function choose(choice: string) {
    if (finishedRef.current || busyRef.current || recording) return;
    const index = stepRef.current;
    const correct = choice === activities[index].answer;
    if (correct) setStars((value) => value + 1);
    if (index === activities.length - 1) {
      finishedRef.current = true; setFinished(true);
      void speakLesson(correct
        ? "Amazing! You finished the animal game!"
        : "Well done for trying! You finished the animal game!");
    } else {
      const next = index + 1;
      stepRef.current = next; setStep(next);
      void speakLesson((correct ? "Great job!" : "Nice try!") + " Which animal says " + activities[next].sound + "?");
    }
  }

  async function submitVoice(blob: Blob, mime: string, targetMode: Mode) {
    if (!tokenRef.current || busyRef.current) return;
    busyRef.current = true; setAiBusy(true); setMood("thinking");
    setMicError(""); setMessage("Buddy is thinking...");
    const ctrl = new AbortController();
    requestRef.current = ctrl;
    try {
      const form = new FormData();
      form.append("session_token", tokenRef.current);
      form.append("audio", blob, "recording." + (mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm"));
      if (targetMode === "game") form.append("animal", activities[stepRef.current].animal);
      const response = await fetch(targetMode === "chat" ? "/api/voice/chat" : "/api/voice/answer", {
        method: "POST", body: form, signal: ctrl.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Buddy could not hear you.");
      if (ctrl.signal.aborted || !tokenRef.current) return;
      setChildSaid(result.transcript);
      if (targetMode === "chat") {
        const chat = result as ChatResult;
        setMessage(chat.reply);
        if (chat.audio_base64) await playAudio(decodeAudio(chat.audio_base64, chat.audio_mime));
        else setMood("idle");
      } else {
        const answer = result as AnswerResult;
        setMessage(answer.reply);
        // Finishing the request releases the input lock before advancing the game.
        busyRef.current = false;
        setAiBusy(false);
        choose(answer.correct ? activities[stepRef.current].answer : "__incorrect__");
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setMicError(err instanceof Error ? err.message : "Buddy could not respond.");
        setMood("retry");
        setMessage("Let's try again!");
      }
    } finally {
      if (requestRef.current === ctrl) requestRef.current = null;
      busyRef.current = false; setAiBusy(false);
      setMood((current) => current === "thinking" ? "idle" : current);
    }
  }

  async function toggleRecording() {
    if (recording) { stopRecording(); return; }
    if (!tokenRef.current) { setMicError("Ask a parent to unlock voice chat first."); return; }
    if (busyRef.current || mood === "thinking" || mood === "speaking") return;
    if (modeRef.current === "game" && (!started || finishedRef.current)) {
      setMicError("Start the animal game before answering."); return;
    }
    setMicError(""); setChildSaid("");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
        throw new Error("Microphone unavailable. Use localhost or HTTPS and allow mic access.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!tokenRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const preferred = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg"]
        .find((kind) => MediaRecorder.isTypeSupported(kind));
      const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
      const mime = recorder.mimeType.split(";")[0];
      const thisMode = modeRef.current;
      chunksRef.current = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current);
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null; recorderRef.current = null; setRecording(false);
        const blob = new Blob(chunksRef.current, { type: mime });
        if (blob.size && tokenRef.current) void submitVoice(blob, mime, thisMode);
      };
      recorder.start();
      setRecording(true); setMood("listening");
      setMessage("I'm listening. Speak now! Tap again to finish.");
      recordingTimerRef.current = setTimeout(() => stopRecording(), MAX_RECORDING_MS);
    } catch (err) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setMicError(err instanceof Error ? err.message : "Microphone permission failed.");
      setMood("retry");
    }
  }

  function switchMode(value: Mode) {
    if (recording || aiBusy) return;
    stopAudio();
    setMode(value); modeRef.current = value; setMicError(""); setChildSaid("");
    setMessage(value === "chat"
      ? "Hi, superstar! Tap the microphone and tell me about an animal or a color!"
      : "Let's play with farm animals! Tap Let's play!");
  }

  async function hearAgain() {
    if (playbackUrlRef.current && !muted) {
      stopAudio();
      const player = new Audio(playbackUrlRef.current);
      audioRef.current = player;
      player.onplay = () => setMood("speaking");
      player.onended = () => { if (audioRef.current === player) setMood("idle"); };
      try { await player.play(); } catch { setMicError("Allow audio playback in your browser."); }
    } else if (!unlocked) setMicError("Ask a parent to unlock natural voice.");
  }

  const activity = activities[step];
  return (
    <main>
      <header>
        <div className="brand">✦ Little Buddy <span>Family learning</span></div>
        <div className="private">🔒 Parent-supervised demo</div>
      </header>
      <div className="app">
        <section className="lesson">
          <div className="eyebrow">🌈 LET&apos;S LEARN TOGETHER</div>
          <h1>Every little word<br/><em>is a big adventure!</em></h1>
          <p className="intro">Talk, listen and play with your friendly English learning buddy.</p>
          <div className="mascotWrap">
            <div className={"robot " + mood} aria-label={"Buddy is " + mood} role="img">
              <div className="antenna"><i/></div><div className="head"><div className="face"><div className="eyes"><b/><b/></div><div className="mouth"/></div><div className="cheek left"/><div className="cheek right"/></div>
              <div className="bodyRobot"><div className="heart">♥</div></div>
              <div className="arm armL"/><div className="arm armR"/><div className="feet"><i/><i/></div>
            </div>
            <div className="shadow"/>
          </div>
          <div className="bubble" aria-live="polite">{message}</div>
          {childSaid && <p className="childSaid">You said: {childSaid}</p>}
          <div className="voice">
            <button onClick={() => void hearAgain()} disabled={!playbackUrlRef.current}>🔊 Hear again</button>
            <button onClick={() => { setMuted((value) => !value); stopAudio(); }}>
              {muted ? "🔇 Sound off" : "🎵 Sound on"}
            </button>
            <button onClick={stopAudio} disabled={mood !== "speaking"}>■ Stop talking</button>
          </div>
          <p className="aiDisclosure">Buddy uses an AI-generated voice, not a real person.</p>
        </section>
        <section className="play">
          <div className="modeSwitch" aria-label="Learning mode">
            <button className={mode === "chat" ? "selected" : ""} onClick={() => switchMode("chat")}>🎤 Talk to Buddy</button>
            <button className={mode === "game" ? "selected" : ""} onClick={() => switchMode("game")}>🐾 Animal game</button>
          </div>
          {!unlocked ? (
            <div className="parentGate">
              <div className="gateIcon">🔐</div>
              <h2>Parent starts voice time</h2>
              <p>Ask a grown-up to enter the parent PIN. Voice sessions last 15 minutes, with up to 20 answers.</p>
              <form onSubmit={(event) => { event.preventDefault(); void startSession(); }}>
                <label htmlFor="parentPin">Parent PIN</label>
                <input id="parentPin" type="password" inputMode="numeric" autoComplete="off"
                  minLength={4} maxLength={64} value={parentPin}
                  onChange={(event) => setParentPin(event.target.value)} placeholder="Enter PIN" required />
                <button className="primary" type="submit" disabled={sessionBusy}>{sessionBusy ? "Starting..." : "Start voice time →"}</button>
              </form>
              <p className="gateHint">Picture games can be played without voice access.</p>
            </div>
          ) : (
            <div className="sessionBar"><span>● Voice session active</span><button onClick={() => void endSession()}>End session</button></div>
          )}
          {mode === "chat" ? (
            <div className="chatPanel">
              <div className="animalHero">🎨 🐻 ⭐</div>
              <h2>Let&apos;s talk!</h2>
              <p>Say: “Hello Buddy! Teach me shapes!”</p>
              <div className="micArea">
                <button className={"mic " + (recording ? "active" : "")}
                  onClick={() => void toggleRecording()} disabled={!unlocked || aiBusy || mood === "speaking" || mood === "thinking"}
                  aria-label={recording ? "Stop recording" : "Start speaking"}>{recording ? "■" : "🎤"}</button>
                <div><strong>{recording ? "Tap to finish" : aiBusy ? "Buddy is thinking..." : "Tap and speak"}</strong>
                  <small>{recording ? "Stops automatically after 12 seconds" : "Buddy answers in clear English"}</small></div>
              </div>
            </div>
          ) : (
            <>
              <div className="topline"><span>🐾 FARM ANIMALS</span><span>{finished ? "Completed" : started ? "Question " + (step + 1) + " of 3" : "3 fun questions"}</span></div>
              <div className="progress"><div style={{ width: finished ? "100%" : started ? (step / 3 * 100) + "%" : "0%" }}/></div>
              <div className="stars">{Array.from({ length: 3 }, (_, i) => <span key={i} className={i < stars ? "earned" : ""}>★</span>)} <small>{stars} stars</small></div>
              {!started ? <div className="welcome"><div className="animalHero">🐄 🐈 🐕</div><h2>Animal Sounds!</h2><p>Can you find the animal that makes each sound?</p><button className="primary" onClick={startGame}>Let&apos;s play! →</button></div>
                : finished ? <div className="welcome"><div className="animalHero">🏆</div><h2>Wonderful work!</h2><p>You earned {stars} out of 3 stars.</p><button className="primary" onClick={startGame}>Play again ↻</button></div>
                : <div className="question"><div className="label">LISTEN AND CHOOSE</div><h2>Who says <em>“{activity.sound}”</em>?</h2><p>Tap the correct animal!</p>
                  <div className="choices">{activity.choices.map((choice, i) => <button key={i} onClick={() => choose(choice)} disabled={aiBusy || recording} aria-label={"Choose " + (choice === "🐄" ? "cow" : choice === "🐈" ? "cat" : "dog")}>{choice}</button>)}</div>
                </div>}
              <div className="micArea"><button className={"mic " + (recording ? "active" : "")}
                onClick={() => void toggleRecording()} disabled={!unlocked || aiBusy || mood === "speaking" || mood === "thinking" || !started || finished}
                aria-label={recording ? "Stop recording" : "Answer with your voice"}>{recording ? "■" : "🎤"}</button>
                <div><strong>{recording ? "Tap to finish" : "Answer with your voice"}</strong><small>Say cow, cat or dog</small></div>
              </div>
            </>
          )}
          {micError && <p className="error" role="alert">{micError}</p>}
          <p className="disclaimer">With parent permission, microphone recordings are sent to OpenAI for speech processing. This demo does not save recordings or conversation history to a database. Use under adult supervision.</p>
        </section>
      </div>
      <footer>Made with ♥ for little learners · Parent supervision required</footer>
    </main>
  );
}
