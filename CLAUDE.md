# EsseAnalytics — content-automation-dashboard

App de escritorio (Electron) + web para gestión y automatización de publicación de
contenido (videos cortos) en YouTube, Instagram y TikTok. Modelo freemium: el núcleo
corre **local** en la PC del usuario (videos físicos + SQLite, sin coste de
almacenamiento), con una **central** en la nube para auth, dominio y tokens OAuth.

## Arquitectura (monorepo, 5 paquetes)

| Carpeta         | Qué es                          | Stack                                          | Puerto |
|-----------------|---------------------------------|------------------------------------------------|--------|
| `frontend/`     | SPA (UI única para local y web) | React 19, Vite 8, Tailwind 4, Radix UI, motion | 5173 (dev) |
| `local-backend/`| Backend que corre en la PC      | Express 5, **better-sqlite3**, tsx             | 4000   |
| `backend/`      | "Central" en la nube            | Express 5, **Mongoose/MongoDB Atlas**, googleapis | 4000 |
| `electron/`     | Empaqueta frontend+local-backend en app de escritorio | Electron 35, electron-builder | — |
| `sync/`         | Scripts Python auxiliares       | esse_transcrip, match_youtube, restore_to_local | — |

> No hay `package.json` raíz: cada paquete se instala/ejecuta por separado.

### Cómo encajan las piezas
- **El frontend es uno solo.** Decide a quién hablar en runtime — ver `frontend/src/config.ts`:
  - Servido desde `esse-analytics.com` (Cloudflare Pages) → habla con la **central**
    (`https://api.esse-analytics.com`). Es el "modo remoto", con funciones limitadas.
  - Servido desde Electron/LAN/túnel → habla con su **propio local-backend** (`window.location.origin`).
- **local-backend** guarda todo en **SQLite** (`esse_local.db` en `app.getPath('userData')`)
  y sirve los archivos de video físicos. Para auth/registro hace **proxy a la central**
  (`local-backend/src/routes/auth-proxy.routes.ts`); el `installId`/secreto de instalación
  vive en SQLite y nunca pasa por el frontend.
- **central (backend)** tiene los usuarios, logs de login, tokens OAuth y un "espejo"
  central del catálogo. Detrás de **Cloudflare Tunnel** (`api.esse-analytics.com → :4000`).
- **App ≠ central no se sincronizan** automáticamente: datos de la app viven en SQLite local,
  el dominio en Mongo. Los tokens OAuth viven en la central.

## Frontend

- Entrada: `frontend/src/App.tsx`. Navegación **por índice** (no router): `navItems[0..8]`.
  - `ACTIVE_VIEWS` = qué vistas están vivas; el resto muestra "PRÓXIMAMENTE".
  - `LOCAL_ONLY_NAV` = vistas que requieren la PC central (se ocultan en modo remoto):
    Videos(1), Subir(2), Taller(5), Gemas(8).
  - Roles: `todopoderoso` (admin), `editor`, etc. `isPremium = isOwner || tier === "premium"`.
- Vistas principales (`frontend/src/components/`): `VideosView`, `YoutubeUploadView`,
  `PublishingQueue` (calendario), `Taller`, `GemsPanel`, `UsersPanel`, `SettingsView`,
  `LoginPage`, `LandingPage`, `RemoteGate` (banner/gate de modo remoto).
- UI primitivos shadcn/Radix en `components/ui/`. Player en `components/player/`.
- Estado/datos: hooks en `frontend/src/hooks/` (`useAuth`, `useBackendType`, `useAutoBackup`,
  `useTheme`), cliente HTTP en `frontend/src/services/api.ts`.

## Backends (local y central comparten forma de rutas)

Las rutas se montan en `*/src/server.ts`. Dominios de endpoints:
`auth`, `video`, `stream`, `scan`, `sync`, `publishing-status`, `youtube-upload`,
`instagram-upload`, `tiktok-upload`, `backup(-sync)`, `gems`/`transcript`/`local-admin` (solo local),
`ideas-centrales`/`components` (solo central).

- **local-backend**: lógica en `controllers/`, acceso a SQLite en `db/*.repo.ts`
  (`file.repo`, `platform-video.repo`, `publishing-status.repo`, `transcript.repo`, `config.repo`),
  esquema/tablas en `db/database.ts`. `scripts/` = utilidades de migración/diagnóstico (tsx).
- **backend (central)**: `controllers/` + `models/` (Mongoose) + `services/`
  (`youtube.service`, `instagram.service`, `tiktok.service` = integraciones OAuth/API).
  Seguridad: helmet, CORS restringido a `ALLOWED_ORIGINS`, rate-limit en `/api`,
  `trust proxy` por el túnel. `scripts/` = seeds, backfills y diagnósticos.
- Scoping multi-usuario: config de calendario y `platform_videos` van por `userId`
  (ver commits recientes sobre scoping/backfill).

## Comandos

```bash
# Frontend
cd frontend && npm run dev          # vite dev server
cd frontend && npm run build        # build a dist/
cd frontend && npm run lint

# Local backend (SQLite)
cd local-backend && npm run dev     # tsx watch
cd local-backend && npm start

# Central backend (MongoDB) — necesita MONGO_URI en .env
cd backend && npm run dev
cd backend && npm start

# Electron (app de escritorio)
cd electron && npm run dev          # build server+main y abre Electron
cd electron && npm run dist:win     # instalador Windows → C:/esse-release
```
No hay tests configurados (`backend test` es un no-op).

## Deploy / infra
- Frontend público: **Cloudflare Pages/Workers** (`wrangler.toml`, assets = `frontend/dist`)
  en `esse-analytics.com`.
- Central: corre en la PC en `:5000`/`:4000`, expuesta vía **Cloudflare Tunnel** como
  `api.esse-analytics.com`. El login depende de central+túnel vivos.
- Desktop: electron-builder publica releases en GitHub (`gessex22/esse-analytics`),
  autoupdate vía `electron-updater`. Secretos (YouTube API key, CLIENT_REGISTER_KEY)
  se inyectan en build-time desde `electron/.env.build`, no en el código.

## Convenciones
- Código y comentarios en **español**; TypeScript en todo (frontend/backends/electron).
- Variables de entorno: cada paquete tiene su `.env.example`. La central no arranca sin `MONGO_URI`.
- Al tocar una vista nueva, recordá habilitarla en `ACTIVE_VIEWS` y, si es local-only,
  agregarla a `LOCAL_ONLY_NAV` en `App.tsx`.
