# EsseAnalytics — Content Automation Dashboard

App de escritorio (Electron) + web para gestionar y automatizar la publicación
de contenido de video corto en YouTube, Instagram y TikTok. Es el "hub"
central de **EsseAnalytics**, un producto multiplataforma que también incluye
apps nativas para [iOS](https://github.com/gessex22/esse-analytics-ios) y
[Android](https://github.com/gessex22/esse-analytics-android).

## Modelo

Freemium con núcleo local: los videos y la biblioteca del usuario viven en su
propia PC (SQLite + archivos físicos, sin costo de almacenamiento en la nube),
mientras que una **central** en la nube maneja autenticación, dominio y
tokens OAuth de las plataformas de publicación.

## Arquitectura (monorepo, 6 paquetes)

| Carpeta          | Qué es                                                        | Stack                                            |
|-------------------|----------------------------------------------------------------|---------------------------------------------------|
| `frontend/`       | SPA única (sirve tanto al modo local como al modo remoto/web) | React 19, Vite, Tailwind, Radix UI                 |
| `local-backend/`  | Backend que corre en la PC del usuario                        | Express 5, better-sqlite3                          |
| `backend/`        | Backend central en la nube                                    | Express 5, MongoDB (Mongoose), googleapis          |
| `electron/`       | Empaqueta frontend + local-backend como app de escritorio     | Electron, electron-builder                         |
| `lab-backend/`    | Backend de "Laboratorio": mock end-to-end compartido con las apps móviles, para QA sin tocar servicios reales | Express 5, store JSON propio |
| `sync/`           | Scripts auxiliares de sincronización/transcripción            | Python                                             |

## Funcionalidad principal

- Biblioteca de videos con escaneo/organización local.
- Cola de publicación con calendario, subida a YouTube/Instagram/TikTok con
  progreso en tiempo real.
- Analítica de contenido publicado.
- Gestión de usuarios y roles (`todopoderoso`/admin, `editor`, etc.), con
  niveles free/premium.
- Sincronización y backup entre PC y central.

## Cómo correrlo

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

## Estado del proyecto

En desarrollo activo. Dirigido y validado por Gessemberg Cardozo (definición
de producto, pruebas de integración, diagnóstico y decisiones técnicas), con
desarrollo asistido por IA (Claude Code).
