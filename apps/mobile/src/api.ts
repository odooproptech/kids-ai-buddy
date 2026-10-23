import * as FileSystem from "expo-file-system";
import { encode } from "base-64";

export type ChatResponse = { transcript: string; reply: string; audio_base64: string; audio_mime: string };
export type AnswerResponse = { transcript: string; correct: boolean; reply: string; animal: string };

const API = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:8000";

async function checked(response: Response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : "Could not reach Buddy.");
  }
  return response;
}

export async function startSession(pin: string): Promise<string> {
  const res = await checked(await fetch(API + "/api/voice/session", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  }));
  return (await res.json()).session_token;
}

export async function endSession(token: string) {
  await checked(await fetch(API + "/api/voice/session/end", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: token }),
  }));
}

export async function sendRecording(uri: string, token: string, animal?: string): Promise<ChatResponse | AnswerResponse> {
  const form = new FormData();
  form.append("session_token", token);
  if (animal) form.append("animal", animal);
  form.append("audio", { uri, name: "child.m4a", type: "audio/mp4" } as unknown as Blob);
  const res = await checked(await fetch(API + (animal ? "/api/voice/answer" : "/api/voice/chat"), {
    method: "POST", body: form,
  }));
  return res.json();
}

export async function speakLesson(token: string, text: string): Promise<string> {
  const res = await checked(await fetch(API + "/api/voice/speak", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: token, text }),
  }));
  const array = await res.arrayBuffer();
  const bytes = new Uint8Array(array);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return saveAudio(encode(binary));
}

export async function saveAudio(base64: string): Promise<string> {
  const path = FileSystem.cacheDirectory + "buddy-" + Date.now() + ".mp3";
  await FileSystem.writeAsStringAsync(path, base64, { encoding: FileSystem.EncodingType.Base64 });
  return path;
}
