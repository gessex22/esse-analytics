# EsseAnalytics — Content Automation Dashboard

*[English below](#english) · [Español más abajo](#español)*

---

## English

Desktop app (Electron) + web dashboard to manage and automate short-video
content publishing to YouTube, Instagram, and TikTok. It's the central hub of
**EsseAnalytics**, a cross-platform product that also includes native
[iOS](https://github.com/gessex22/esse-analytics-ios) and
[Android](https://github.com/gessex22/esse-analytics-android) apps.

### Model

Freemium with a local-first core: the user's videos and library live on their
own PC (SQLite + physical files, no cloud storage cost), while a **central**
cloud service handles authentication, domain, and OAuth tokens for the
publishing platforms.

### Architecture (monorepo, 6 packages)

| Folder            | What it is                                                      | Stack                                    |
|--------------------|-------------------------------------------------------------------|--------------------------------------------|
| `frontend/`        | Single SPA (serves both local and remote/web modes)              | React 19, Vite, Tailwind, Radix UI          |
| `local-backend/`   | Backend running on the user's PC                                  | Express 5, better-sqlite3                   |
| `backend/`         | Central cloud backend                                              | Express 5, MongoDB (Mongoose), googleapis   |
| `electron/`        | Bundles frontend + local-backend into a desktop app                | Electron, electron-builder                  |
| `lab-backend/`     | "Lab" backend: end-to-end mock shared with the mobile apps for QA, without touching real services | Express 5, custom JSON store |
| `sync/`            | Auxiliary sync/transcription scripts                              | Python                                      |

### Core functionality

- Video library with local scanning/organization.
- Publishing queue with calendar view, real-time upload progress to
  YouTube/Instagram/TikTok.
- Analytics for published content.
- User and role management (`todopoderoso`/admin, `editor`, etc.), with
  free/premium tiers.
- Sync and backup between the local PC and the central service.

### Running it locally

Each package installs and runs independently (no root `package.json`):

```bash
# Frontend
cd frontend && npm install && npm run dev

# Local backend (SQLite)
cd local-backend && npm install && npm run dev

# Central backend (requires MongoDB)
cd backend && npm install && npm run dev

# Desktop app (Electron)
cd electron && npm install && npm run dev
```

### Project status

Actively in development. Directed and validated by Gessemberg Cardozo
(product definition, integration testing, debugging, and technical
decisions), with AI-assisted development (Claude Code).

---

## Español

App de escritorio (Electron) + web para gestionar y automatizar la publicación
de contenido de video corto en YouTube, Instagram y TikTok. Es el "hub"
central de **EsseAnalytics**, un producto multiplataforma que también incluye
apps nativas para [iOS](https://github.com/gessex22/esse-analytics-ios) y
[Android](https://github.com/gessex22/esse-analytics-android).

### Modelo

Freemium con núcleo local: los videos y la biblioteca del usuario viven en su
propia PC (SQLite + archivos físicos, sin costo de almacenamiento en la nube),
mientras que una **central** en la nube maneja autenticación, dominio y
tokens OAuth de las plataformas de publicación.

### Arquitectura (monorepo, 6 paquetes)

| Carpeta          | Qué es                                                        | Stack                                            |
|-------------------|----------------------------------------------------------------|---------------------------------------------------|
| `frontend/`       | SPA única (sirve tanto al modo local como al modo remoto/web) | React 19, Vite, Tailwind, Radix UI                 |
| `local-backend/`  | Backend que corre en la PC del usuario                        | Express 5, better-sqlite3                          |
| `backend/`        | Backend central en la nube                                    | Express 5, MongoDB (Mongoose), googleapis          |
| `electron/`       | Empaqueta frontend + local-backend como app de escritorio     | Electron, electron-builder                         |
| `lab-backend/`    | Backend de "Laboratorio": mock end-to-end compartido con las apps móviles, para QA sin tocar servicios reales | Express 5, store JSON propio |
| `sync/`           | Scripts auxiliares de sincronización/transcripción            | Python                                             |

### Funcionalidad principal

- Biblioteca de videos con escaneo/organización local.
- Cola de publicación con calendario, subida a YouTube/Instagram/TikTok con
  progreso en tiempo real.
- Analítica de contenido publicado.
- Gestión de usuarios y roles (`todopoderoso`/admin, `editor`, etc.), con
  niveles free/premium.
- Sincronización y backup entre PC y central.

### Cómo correrlo

Cada paquete se instala y corre por separado (no hay `package.json` raíz):

```bash
# Frontend
cd frontend && npm install && npm run dev

# Backend local (SQLite)
cd local-backend && npm install && npm run dev

# Backend central (requiere MongoDB)
cd backend && npm install && npm run dev

# App de escritorio (Electron)
cd electron && npm install && npm run dev
```

### Estado del proyecto

En desarrollo activo. Dirigido y validado por Gessemberg Cardozo (definición
de producto, pruebas de integración, diagnóstico y decisiones técnicas), con
desarrollo asistido por IA (Claude Code).
