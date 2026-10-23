import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { AudioPlayer, createAudioPlayer, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { AnswerResponse, ChatResponse, endSession, saveAudio, sendRecording, speakLesson, startSession } from "./src/api";

type Mode = "chat" | "animals";
type State = "idle" | "listening" | "thinking" | "speaking";
const animals = [
  { name: "cow", sound: "moo", emoji: "🐄", options: ["🐄", "🐈", "🐕"], answer: "🐄" },
  { name: "cat", sound: "meow", emoji: "🐈", options: ["🐕", "🐈", "🐄"], answer: "🐈" },
  { name: "dog", sound: "woof", emoji: "🐕", options: ["🐄", "🐕", "🐈"], answer: "🐕" },
];
const label = (emoji: string) => emoji === "🐄" ? "cow" : emoji === "🐈" ? "cat" : "dog";

export default function App() {
  const [pin, setPin] = useState("");
  const [token, setToken] = useState("");
  const tokenRef = useRef("");
  const [mode, setMode] = useState<Mode>("chat");
  const [state, setState] = useState<State>("idle");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Hi, friend! Let's learn English together!");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState(0);
  const [stars, setStars] = useState(0);
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [lastAudio, setLastAudio] = useState<string | null>(null);
  const audioRef = useRef<AudioPlayer | null>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recordingRef = useRef(false);
  const recordingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cached = useRef<string[]>([]);
  const stepRef = useRef(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recordingTimer.current) clearTimeout(recordingTimer.current);
      audioRef.current?.remove();
      cached.current.forEach((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}));
    };
  }, []);

  const notify = (err: unknown) => {
    if (mounted.current) setError(err instanceof Error ? err.message : "Something went wrong.");
  };

  async function stopSound() {
    const player = audioRef.current;
    audioRef.current = null;
    player?.remove();
    if (mounted.current) setState("idle");
  }

  async function play(uri: string) {
    await stopSound();
    if (!tokenRef.current) return;
    setLastAudio(uri);
    setState("speaking");
    const player = createAudioPlayer({ uri });
    audioRef.current = player;
    player.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish && mounted.current) {
        void stopSound();
      }
    });
    player.play();
  }

  async function unlock() {
    if (busy || !pin.trim()) return;
    setBusy(true); setError("");
    try {
      const value = await startSession(pin);
      tokenRef.current = value;
      setToken(value); setPin("");
      setMessage("Hello, superstar! Tap the microphone and say hello!");
      setMode("chat");
    } catch (e) { notify(e); }
    finally { setBusy(false); }
  }

  async function finishSession() {
    const old = tokenRef.current;
    tokenRef.current = ""; setToken("");
    if (recordingTimer.current) clearTimeout(recordingTimer.current);
    if (recordingRef.current) {
      recordingRef.current = false;
      await recorder.stop().catch(() => {});
    }
    await stopSound();
    setLastAudio(null); setTranscript("");
    setMessage("See you next time, superstar!");
    for (const uri of cached.current) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    cached.current = [];
    if (old) await endSession(old).catch(() => {});
  }

  async function lessonSpeech(text: string) {
    setMessage(text);
    if (!tokenRef.current) return;
    try {
      const uri = await speakLesson(tokenRef.current, text);
      cached.current.push(uri);
      await play(uri);
    } catch (e) { notify(e); setState("idle"); }
  }

  function startGame() {
    if (busyRef.current) return;
    setMode("animals"); setStarted(true); setFinished(false);
    setStep(0); stepRef.current = 0; setStars(0); setTranscript("");
    void lessonSpeech("Hello, superstar! Let's play with farm animals. Which animal says moo?");
  }

  function choose(emoji: string) {
    if (busyRef.current || state === "listening" || state === "thinking" || finished) return;
    const i = stepRef.current;
    const correct = emoji === animals[i].answer;
    if (correct) setStars((n) => n + 1);
    if (i === 2) {
      setFinished(true);
      void lessonSpeech(correct ? "Amazing! You finished the animal game!" : "Well done for trying! You finished the animal game!");
    } else {
      stepRef.current = i + 1;
      setStep(i + 1);
      void lessonSpeech((correct ? "Great job!" : "Nice try!") + " Which animal says " + animals[i + 1].sound + "?");
    }
  }

  async function send(uri: string, currentMode: Mode, currentStep: number) {
    if (!tokenRef.current || busyRef.current) return;
    busyRef.current = true; setBusy(true); setState("thinking"); setError("");
    setMessage("Buddy is thinking...");
    try {
      const result = await sendRecording(uri, tokenRef.current, currentMode === "animals" ? animals[currentStep].name : undefined);
      if (!tokenRef.current || !mounted.current) return;
      setTranscript(result.transcript);
      if (currentMode === "chat") {
        const chat = result as ChatResponse;
        setMessage(chat.reply);
        if (chat.audio_base64) {
          const soundUri = await saveAudio(chat.audio_base64);
          cached.current.push(soundUri);
          await play(soundUri);
        } else setState("idle");
      } else {
        const answer = result as AnswerResponse;
        setMessage(answer.reply);
        busyRef.current = false; setBusy(false); setState("idle");
        choose(answer.correct ? animals[currentStep].answer : "__wrong__");
      }
    } catch (e) {
      notify(e); setMessage("Let's try again!");
      setState("idle");
    } finally {
      busyRef.current = false; setBusy(false);
      if (mounted.current) setState((s) => s === "thinking" ? "idle" : s);
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  }

  async function stopRecording() {
    if (recordingTimer.current) clearTimeout(recordingTimer.current);
    if (!recordingRef.current) return;
    recordingRef.current = false;
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const uri = recorder.uri;
      setState("idle");
      if (uri && tokenRef.current) await send(uri, mode, stepRef.current);
    } catch (e) { notify(e); setState("idle"); }
  }

  async function toggleMic() {
    if (state === "listening") { await stopRecording(); return; }
    if (!tokenRef.current || busyRef.current || state !== "idle") return;
    if (mode === "animals" && (!started || finished)) return;
    setError(""); setTranscript("");
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Microphone permission is required to talk to Buddy.");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingRef.current = true;
      setState("listening");
      setMessage("I'm listening! Tap again to finish.");
      recordingTimer.current = setTimeout(() => { void stopRecording(); }, 12_000);
    } catch (e) { notify(e); setState("idle"); }
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.header}><Text style={styles.brand}>✦ Little Buddy</Text><Text style={styles.tag}>🔒 Family learning</Text></View>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>🌈 LET'S LEARN TOGETHER</Text>
          <Text style={styles.heading}>Every little word{"\n"}<Text style={styles.purple}>is a big adventure!</Text></Text>
          <View style={styles.robotBox}>
            <Text style={[styles.robot, state === "speaking" && styles.talking]}>{state === "listening" ? "🤖🎤" : state === "thinking" ? "🤖💭" : "🤖"}</Text>
            <Text style={styles.robotState}>{state === "speaking" ? "● Buddy is speaking" : state === "listening" ? "● Buddy is listening" : state === "thinking" ? "● Thinking..." : "Your English buddy"}</Text>
          </View>
          <View style={styles.bubble}><Text style={styles.bubbleText}>{message}</Text></View>
          {transcript ? <Text style={styles.transcript}>You said: {transcript}</Text> : null}
          <View style={styles.audioRow}>
            <TouchableOpacity style={styles.softButton} disabled={!lastAudio} onPress={() => lastAudio && void play(lastAudio)}><Text style={styles.softText}>🔊 Hear again</Text></TouchableOpacity>
            <TouchableOpacity style={styles.softButton} onPress={() => void stopSound()}><Text style={styles.softText}>■ Stop talking</Text></TouchableOpacity>
          </View>
        </View>
        <View style={styles.card}>
          <View style={styles.tabs}>
            <TouchableOpacity style={[styles.tab, mode === "chat" && styles.tabSelected]} onPress={() => { if (state === "idle") { setMode("chat"); setMessage("Tell me about a color, shape, or animal!"); } }}><Text style={styles.tabText}>🎤 Talk to Buddy</Text></TouchableOpacity>
            <TouchableOpacity style={[styles.tab, mode === "animals" && styles.tabSelected]} onPress={() => { if (state === "idle") { setMode("animals"); setMessage("Let's play the animal game!"); } }}><Text style={styles.tabText}>🐾 Animal game</Text></TouchableOpacity>
          </View>
          {!token ? (
            <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.gate}>
              <Text style={styles.gateEmoji}>🔐</Text>
              <Text style={styles.title}>Parent starts voice time</Text>
              <Text style={styles.description}>A grown-up enters the parent PIN to enable 15 minutes of supervised voice learning.</Text>
              <TextInput style={styles.input} value={pin} onChangeText={setPin} placeholder="Parent PIN" secureTextEntry autoCapitalize="none" autoCorrect={false} />
              <TouchableOpacity style={styles.primary} onPress={() => void unlock()} disabled={busy}>
                {busy ? <ActivityIndicator color="#fff"/> : <Text style={styles.primaryText}>Start voice time →</Text>}
              </TouchableOpacity>
            </KeyboardAvoidingView>
          ) : (
            <View style={styles.session}><Text style={styles.sessionText}>● Voice session active</Text><TouchableOpacity onPress={() => void finishSession()}><Text style={styles.endText}>End session</Text></TouchableOpacity></View>
          )}
          {mode === "chat" ? (
            <View style={styles.content}>
              <Text style={styles.emojis}>🎨 🐻 ⭐</Text>
              <Text style={styles.title}>Let's talk!</Text>
              <Text style={styles.description}>Say: "Hello Buddy! Teach me shapes!"</Text>
            </View>
          ) : (
            <View style={styles.content}>
              <Text style={styles.emojis}>{finished ? "🏆" : "🐄 🐈 🐕"}</Text>
              <Text style={styles.title}>{finished ? "Wonderful work!" : started ? "Who says “" + animals[step].sound + "”?" : "Animal Sounds!"}</Text>
              <Text style={styles.description}>{finished ? "You earned " + stars + " stars!" : "Listen, choose, and earn stars!"}</Text>
              {started && !finished ? <View style={styles.choices}>{animals[step].options.map((emoji, i) =>
                <TouchableOpacity key={i} style={styles.choice} disabled={busy || state !== "idle"} accessibilityLabel={"Choose " + label(emoji)} onPress={() => choose(emoji)}><Text style={styles.choiceEmoji}>{emoji}</Text></TouchableOpacity>)}</View> : null}
              {started ? <Text style={styles.stars}>{"⭐".repeat(stars)}{"☆".repeat(3 - stars)}</Text> : null}
              {(!started || finished) && <TouchableOpacity style={styles.primary} onPress={startGame}><Text style={styles.primaryText}>{finished ? "Play again ↻" : "Let's play! →"}</Text></TouchableOpacity>}
            </View>
          )}
          <View style={styles.micArea}>
            <TouchableOpacity style={[styles.mic, state === "listening" && styles.micActive, (!token || busy || state === "speaking" || state === "thinking") && styles.micDisabled]} disabled={!token || busy || state === "speaking" || state === "thinking"} onPress={() => void toggleMic()}>
              <Text style={styles.micIcon}>{state === "listening" ? "■" : "🎤"}</Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }}><Text style={styles.micTitle}>{state === "listening" ? "Tap to finish" : state === "thinking" ? "Buddy is thinking..." : "Tap and speak"}</Text><Text style={styles.micHint}>Short English answers, up to 12 seconds</Text></View>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Text style={styles.disclaimer}>AI-generated voice. Audio is sent to OpenAI for processing with parent permission. Supervise children. Do not share personal details.</Text>
        </View>
        <Text style={styles.footer}>Made with ♥ for little learners</Text>
      </ScrollView>
    </View>
  );
}

const PURPLE = "#7955e7";
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#faf7ff" },
  scroll: { paddingHorizontal: 16, paddingTop: Platform.OS === "android" ? 42 : 58, paddingBottom: 45, gap: 18 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8 },
  brand: { color: "#6542c7", fontSize: 22, fontWeight: "900" },
  tag: { fontSize: 11, color: "#4d8069", backgroundColor: "#e6f8ed", padding: 9, borderRadius: 30 },
  hero: { backgroundColor: "#ebe9ff", borderRadius: 30, padding: 23, alignItems: "center" },
  eyebrow: { fontSize: 11, letterSpacing: 2, color: "#7955e7", marginBottom: 12, fontWeight: "800" },
  heading: { fontSize: 25, textAlign: "center", fontWeight: "900", color: "#27215d", lineHeight: 34 },
  purple: { color: PURPLE },
  robotBox: { alignItems: "center", marginVertical: 24 },
  robot: { fontSize: 110 },
  talking: { transform: [{ scale: 1.07 }] },
  robotState: { color: "#7662b1", fontSize: 12, marginTop: 4 },
  bubble: { backgroundColor: "#fff", padding: 19, borderRadius: 20, width: "100%", minHeight: 74, justifyContent: "center" },
  bubbleText: { color: "#2c225c", textAlign: "center", fontWeight: "700", fontSize: 16 },
  transcript: { marginTop: 12, color: "#5c5184", textAlign: "center" },
  audioRow: { flexDirection: "row", gap: 9, marginTop: 13 },
  softButton: { backgroundColor: "#fff", paddingVertical: 9, paddingHorizontal: 15, borderRadius: 20 },
  softText: { color: "#6e53c6", fontSize: 12, fontWeight: "700" },
  card: { backgroundColor: "#fff", borderRadius: 30, padding: 16, minHeight: 410 },
  tabs: { flexDirection: "row", backgroundColor: "#f0eafd", padding: 5, borderRadius: 16, marginBottom: 15 },
  tab: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: "center" },
  tabSelected: { backgroundColor: "#fff" },
  tabText: { fontSize: 12, color: "#5f42a5", fontWeight: "800" },
  gate: { alignItems: "center", padding: 12, gap: 10 },
  gateEmoji: { fontSize: 48 },
  title: { fontSize: 24, fontWeight: "900", color: "#282057", textAlign: "center" },
  description: { fontSize: 14, lineHeight: 22, color: "#82769e", textAlign: "center", marginVertical: 8 },
  input: { borderWidth: 1, borderColor: "#d8cbf5", borderRadius: 15, padding: 14, width: "100%", fontSize: 17, marginTop: 6 },
  primary: { backgroundColor: PURPLE, padding: 16, borderRadius: 16, alignItems: "center", minWidth: 180, marginTop: 9 },
  primaryText: { color: "#fff", fontWeight: "900", fontSize: 15 },
  session: { backgroundColor: "#e8f9ed", borderRadius: 14, padding: 12, flexDirection: "row", justifyContent: "space-between" },
  sessionText: { color: "#297b50", fontWeight: "800", fontSize: 12 },
  endText: { color: "#ad3261", fontWeight: "800", fontSize: 12 },
  content: { alignItems: "center", paddingVertical: 23, minHeight: 170 },
  emojis: { fontSize: 45, marginBottom: 13 },
  choices: { flexDirection: "row", gap: 10, marginTop: 15 },
  choice: { backgroundColor: "#f2edff", borderRadius: 20, padding: 12 },
  choiceEmoji: { fontSize: 39 },
  stars: { marginTop: 14, fontSize: 21 },
  micArea: { backgroundColor: "#f7f2ff", borderRadius: 18, padding: 14, flexDirection: "row", gap: 13, alignItems: "center" },
  mic: { backgroundColor: "#e7dcff", width: 60, height: 60, borderRadius: 30, alignItems: "center", justifyContent: "center" },
  micActive: { backgroundColor: "#ffb5c5" },
  micDisabled: { opacity: .45 },
  micIcon: { fontSize: 26 },
  micTitle: { color: "#2e235c", fontSize: 15, fontWeight: "800" },
  micHint: { color: "#8777a9", fontSize: 11, marginTop: 4 },
  error: { color: "#bf3353", padding: 12, fontSize: 13 },
  disclaimer: { color: "#9286aa", textAlign: "center", fontSize: 10, lineHeight: 16, marginTop: 15 },
  footer: { textAlign: "center", color: "#9386af", fontSize: 11 },
});
