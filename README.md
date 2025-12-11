# LiveShare — 2 Person Live Sharing (Audio/Video/Screen)

This project provides a simple end-to-end example to let an **admin** create a short room code and let **two participants** join the room to share camera, microphone, and screen (app/window) using WebRTC and Socket.io as the signaling server.

It is intentionally simple (mesh peer-to-peer). For more than 2 participants or reliable NAT traversal you should use a TURN server or an SFU (like Janus, mediasoup, Jitsi, or an SFU provider).

## Features
- Admin creates a room code via POST /create-room (protected by ADMIN_PASSWORD).
- Participant joins with the room code.
- Peer-to-peer WebRTC connection for audio/video/screen sharing.
- Basic UI to start camera/mic, share screen, mute/unmute outgoing audio.
- Room capacity limited to 2 participants (mesh).

## Limitations & notes
- No TURN server configured; behind restrictive NATs the connection may fail. For production add a TURN server (coturn) and configure it in the STUN/TURN list in `public/app.js`.
- Admin password is read from environment variable `ADMIN_PASSWORD` (see `.env.example`).
- This example stores rooms in memory; restart the server clears rooms.
- This demo does not persist users or require accounts — admin just creates codes. You can extend this to JWT-based logins and a DB.

## Run locally
1. Copy `.env.example` → `.env` and set `ADMIN_PASSWORD` and optionally `PORT`.
2. Install dependencies and start:
```bash
npm install
npm start
```
3. Open `http://localhost:3000` in two browser windows (or send the URL + room code to another person).
4. Admin: enter the admin password and click **Create Room**. Share the generated code with the other participant.
5. Participant: paste the code and click **Join Room**. Both should then open camera/mic or share screen.
6. Use the **Share Screen** button to capture an app/window or the whole screen (browser will show options).

## Security suggestions for production
- Serve over HTTPS (required to use getUserMedia/getDisplayMedia on many browsers and for secure contexts).
- Use TURN servers for NAT traversal.
- Use authentication and short-lived tokens for admin operations instead of a single password string.
- Implement rate-limits and room cleanup policies.

## Files
- server.js — Express + Socket.io signaling server
- public/index.html — Frontend UI
- public/app.js — WebRTC + signaling logic
- package.json — dependencies and start script
- .env.example — sample env variables

Enjoy — this is intended as a starting point. If you want, I can:
- add TURN server configuration and instructions to set up coturn;
- add persistent user accounts (SQLite + JWT) so admin/users authenticate;
- package a desktop Electron wrapper;
- add screen-recording/record-to-server capability (requires storage and heavier infra).# Live-Share
