# 🐳 Docker Snooze

**Intelligent Container Lifecycle Manager — Schedule, Snooze, and Save Resources**

A sleek web dashboard that lets you schedule Docker Compose projects to automatically stop ("snooze") and start ("unsnooze") on cron schedules. Perfect for development machines and home labs where containers don't need to run 24/7.

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Docker](https://img.shields.io/badge/Docker-API-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![SQLite](https://img.shields.io/badge/SQLite-WASM-003B57?logo=sqlite&logoColor=white)](https://sql.js.org/)

---

## The Problem

Running Docker Compose stacks on a dev machine or home server eats RAM and CPU even when you're sleeping or away. Manually starting and stopping projects is tedious. Existing solutions (Kubernetes CronJobs, systemd timers) are overkill for small setups.

**Docker Snooze** gives you a beautiful UI to schedule exactly when your projects should run, with automatic catch-up if your machine was asleep when a schedule should have fired.

---

## Features

- 🕐 **Cron-based scheduling** — Set snooze/unsnooze schedules with full cron expression support
- 🔄 **Missed schedule catch-up** — Automatically enforces the "dominant" schedule if the host OS was sleeping
- 📊 **Live system stats** — Real-time CPU, memory, disk usage, and top processes
- 🐳 **Per-container stats** — Memory and CPU usage per Docker container
- 🔒 **TOTP + Password auth** — Secure access with 2FA (Google Authenticator compatible)
- 🎯 **One-click snooze/unsnooze** — Instant manual control alongside schedules
- 📝 **Audit log** — Full history of all snooze/unsnooze actions (manual + scheduled)
- 🌐 **Zero dependencies on Docker daemon APIs** — Uses `docker compose` CLI for maximum compatibility

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    WEB DASHBOARD                      │
│          (Futuristic UI — HTML/CSS/JS)                │
└────────────────────────┬─────────────────────────────┘
                         │ REST API
┌────────────────────────▼─────────────────────────────┐
│                   EXPRESS SERVER                      │
│  ┌──────────┐  ┌────────────┐  ┌─────────────────┐  │
│  │   Auth   │  │  Scheduler │  │ Docker Manager  │  │
│  │  (TOTP)  │  │  (node-cron│  │ (docker compose │  │
│  │  (JWT)   │  │   catchup) │  │    CLI calls)   │  │
│  └──────────┘  └────────────┘  └─────────────────┘  │
│                                                      │
│  ┌──────────────────────────────────────────────────┐│
│  │              SQLite (sql.js WASM)                ││
│  │  projects │ schedules │ logs                     ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **sql.js (WASM)** instead of better-sqlite3 | Zero native compilation — works everywhere, no `node-gyp` nightmares |
| **docker compose CLI** instead of Docker API | Works with any Docker Compose version, no socket permissions needed |
| **Custom TOTP** from scratch | No dependency on `speakeasy` or `otplib` runtime — pure crypto implementation |
| **Catch-up scheduler** | Handles macOS/laptop sleep gracefully — reruns missed schedules on wake |

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/decodeswapnil/docker-snooze.git
cd docker-snooze

# 2. Install dependencies
npm install

# 3. Start
npm start
# → http://localhost:4242
```

On first visit, you'll be prompted to set up a password and scan a QR code for TOTP 2FA.

---

## How It Works

1. **Register a project** → Point to any `docker-compose.yml` on your machine
2. **Create schedules** → Set cron expressions for when to snooze (stop) or unsnooze (start)
3. **Let it run** → The scheduler handles everything, even catching up after sleep/hibernate
4. **Monitor** → Dashboard shows live status, container stats, and full audit log

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | List all projects with live Docker status |
| `POST` | `/api/projects` | Register a new Docker Compose project |
| `POST` | `/api/projects/:id/snooze` | Immediately stop all containers |
| `POST` | `/api/projects/:id/unsnooze` | Immediately start all containers |
| `GET` | `/api/projects/:id/stats` | Per-container memory/CPU stats |
| `POST` | `/api/schedules` | Create a cron schedule |
| `PATCH` | `/api/schedules/:id/toggle` | Enable/disable a schedule |
| `GET` | `/api/system-stats` | Host CPU, memory, disk, top processes |
| `GET` | `/api/logs` | Audit trail of all actions |

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| **Server** | Express 4.x |
| **Database** | SQLite via sql.js (WASM — no native build) |
| **Auth** | Custom TOTP (RFC 6238) + JWT + scrypt password hashing |
| **Scheduler** | node-cron with missed-schedule catch-up |
| **Docker Control** | docker compose CLI via child_process |
| **Frontend** | Vanilla HTML/CSS/JS with futuristic dark theme |

---

## Project Structure

```
docker-snooze/
├── server.js             # Express API server + routes
├── db.js                 # SQLite setup, models, persistence
├── scheduler.js          # Cron manager + catch-up logic
├── docker-manager.js     # Docker Compose CLI wrapper
├── auth.js               # TOTP, JWT, password hashing (custom crypto)
├── public/
│   ├── index.html        # Dashboard UI
│   ├── index.css         # Futuristic dark theme
│   └── app.js            # Client-side logic
├── .env.example         # Configuration reference
├── package.json
└── .gitignore
```

---

## Security

- 🔐 TOTP-based 2FA (Google Authenticator / Authy compatible)
- 🔑 Passwords hashed with scrypt (salt + timing-safe comparison)
- 🎫 JWT tokens with 24h expiry
- 🚫 All API endpoints protected (except health check)
- 📁 Auth config stored locally, never committed to git

---

## License

MIT

---

*Built by [@decodeswapnil](https://github.com/decodeswapnil)*
