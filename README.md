<div align="center">

# Skin Picker — Rooms Server

**Real-time Socket.IO backend for [Skin Picker](https://github.com/Nano315/lol-skin-picker).**

[![Tests](https://github.com/Nano315/skin-picker-rooms-server/actions/workflows/test.yml/badge.svg)](https://github.com/Nano315/skin-picker-rooms-server/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/github/license/Nano315/skin-picker-rooms-server)](LICENSE)

</div>

---

## Overview

This server orchestrates multiplayer rooms for the Skin Picker desktop app: identity handshake, real-time synchronization of skin selections, color and Skin Line synergy computation, friend-to-friend room invitations, and coordinated auto-apply once every member has locked their champion.

It is a dedicated companion backend — no UI, no account system. Clients identify themselves with their LCU `puuid` at connect time. State is kept in memory; no gameplay, account, or chat data is processed or persisted.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| HTTP | Express 5 + Helmet + express-rate-limit |
| Real-time | Socket.IO 4 |
| Language | TypeScript 5 |
| Tests | Jest + Supertest |
| Logging | Winston |
| Process manager | PM2 (`ecosystem.config.js`) |

## Architecture

- **Rooms** — in-memory state per 6-character code; selection updates are broadcast to members in real time.
- **Synergy engine** — computes shared Skin Lines and shared chroma colors across the room's available options, emitted alongside raw selections so the client can render suggestions.
- **Presence** — tracks identified clients across their active rooms.
- **Invitations** — point-to-point delivery of room invites between identified clients, with per-target rate limiting.
- **Versioning** — event payloads are versioned (`CURRENT_EVENT_VERSION` in `src/types/event-versions.ts`, currently **v3**) and adapted per-client so older and newer app versions can coexist during rollouts. v3 added `members[].lockedSkin` to `room-state` (per-match skin lock); V2 clients still get the field stripped automatically.

## Getting started (development)

Requires Node.js 18+.

```bash
npm install
npm run dev             # ts-node hot-reload on src/server.ts
npm test                # Jest unit + integration tests
npm run test:coverage
npm run simulator       # interactive socket simulator (see tools/simulator/README.md)
```

Build and run:

```bash
npm run build           # emit dist/
npm start               # node dist/server.js
```

## Deployment

Production runs under PM2 (see `ecosystem.config.js`). A GitHub Actions workflow (`.github/workflows/deploy-back.yml`) deploys on push to `main`. CORS origin and rate limits are currently permissive defaults and should be tightened for a production multi-tenant setup.

## Project relationship

This server is consumed exclusively by [Skin Picker (desktop)](https://github.com/Nano315/lol-skin-picker). There is no public HTTP API surface beyond what the app uses, and no authentication system — identity is derived from the client-supplied LCU `puuid`.

## Contributing

Issues and pull requests welcome. For security reports, please email `valentin3135@gmail.com` rather than opening a public issue.

## License

[MIT](LICENSE) — Valentin Dumas
