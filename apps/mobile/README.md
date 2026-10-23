# Little Buddy — React Native mobile (Expo)

This repository now contains two clients sharing the same FastAPI + OpenAI backend:

- `apps/web`: existing Next.js website (unchanged).
- `apps/mobile`: native Android/iOS app built with Expo and React Native.
- `apps/api`: existing FastAPI voice endpoints (unchanged).

## Run on Ubuntu

First start the backend from the repository root:

```bash
docker compose up -d --build api
```

The normal Docker Compose file binds port 8000 to localhost. For a phone on your **trusted home LAN**, use this **development-only** override:

```bash
docker compose -f docker-compose.yml -f docker-compose.mobile-dev.yml up -d --build api
```

This publishes port 8000 to your LAN. **Do not forward the port on your router, use public Wi-Fi, or expose this development backend to the internet.** Use HTTPS and proper authentication before production.

Find your Ubuntu host's LAN IP with `hostname -I`. If running under WSL2, the LAN IP visible to your phone may instead be your Windows host IP and may require Windows firewall/port-forward configuration.

```bash
cd apps/mobile
cp .env.example .env
nano .env
npm install
npx expo start --lan
```

Set `EXPO_PUBLIC_API_URL=http://YOUR_REACHABLE_LAN_IP:8000` in `apps/mobile/.env`. Your phone and Ubuntu host must be on the same trusted network.

Open **Expo Go** on your phone and scan the QR code. Use the same **PARENT_PIN** already configured in the backend's root `.env`. The OpenAI API key **never belongs in the mobile app**.

## What works

- Native Talk to Buddy: tap to record up to 12 seconds, tap again to finish.
- OpenAI STT → age-appropriate AI response → MP3 speech playback.
- Parent PIN gate and 15-minute/20-turn backend session.
- Farm animal picture game with AI voice prompts.
- Robot speaking/listening/thinking indicators, replay and stop controls.
- Audio recordings are not uploaded to a separate storage system; temporary local recordings and generated speech are deleted after use or session end where possible.

## Verify

```bash
cd apps/mobile
npm install
npm run typecheck
```

For API tests: `cd apps/api && python -m pytest -q`.

## Limitations

This is a supervised family **prototype**, not a production-ready children's app. The robot is currently an emoji placeholder, not a rigged animated avatar. Parent PIN is a demo gate, not identity verification. The backend sends child audio and text to OpenAI for processing under OpenAI API data handling terms. Native devices may cache audio temporarily. Review child privacy and consent, HTTPS, authentication, rate limits, app-store requirements, and retention before public release. Real-time duplex audio, offline lessons, child profiles, native animation, and progress dashboards are future work.
