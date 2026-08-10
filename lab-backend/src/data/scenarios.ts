// Los 9 escenarios predefinidos pedidos para el Laboratorio. Cada uno describe
// un LabUser completo + qué datos (catálogo/historial/calendario/publish jobs)
// hay que sembrar alrededor para que las pantallas de iOS/Android/Electron
// tengan algo consistente para mostrar. `apply()` es la única función que los
// controllers llaman -- ver lab.controller.ts.

import { getDb, persist } from '../store/db';
import { newId, mockPlatformId, mockPlatformUrl, mockAccessToken, mockThumbnailUrl } from '../lib/ids';
import {
  LabUser, Platform, PlatformConnection, emptyConnections, LabFile,
} from '../store/types';

export interface ScenarioDef {
  key: string;
  label: string;
  description: string;
}

export const SCENARIOS: ScenarioDef[] = [
  { key: 'owner_premium',        label: 'Owner premium',            description: 'Owner, premium, biblioteca remota activa y las 3 plataformas conectadas.' },
  { key: 'editor_free',          label: 'Editor free',              description: 'Editor sin beneficios premium.' },
  { key: 'cloud_user',           label: 'Usuario con nube',         description: 'Premium con almacenamiento remoto activo.' },
  { key: 'expired_connection',   label: 'Conexión vencida',         description: 'Instagram y TikTok requieren reconexión (token vencido).' },
  { key: 'publish_failed',       label: 'Publicación fallida',      description: 'Un publish job en Instagram falló de forma recuperable.' },
  { key: 'publish_slow',         label: 'Publicación lenta',        description: 'Un publish job en YouTube sigue "procesando" con progreso parcial.' },
  { key: 'publish_interrupted',  label: 'Publicación interrumpida', description: 'Un publish job en TikTok quedó interrumpido, pendiente de reintento.' },
  { key: 'empty_account',        label: 'Cuenta vacía',             description: 'Sin videos, calendario ni historial.' },
  { key: 'account_with_data',    label: 'Cuenta con datos',         description: '10+ videos, calendario, historial y estadísticas.' },
];

function connected(accountName: string, platform: Platform = 'youtube'): PlatformConnection {
  return { status: 'connected', accountName, accessToken: mockAccessToken(platform), expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() };
}
function expired(accountName: string): PlatformConnection {
  return { status: 'expired', accountName, expiresAt: new Date(Date.now() - 86_400_000).toISOString() };
}

function baseUser(overrides: Partial<LabUser> & { username: string; password: string; scenario: string }): LabUser {
  return {
    id: newId(),
    role: 'editor',
    tier: 'free',
    isOwner: false,
    hasCloudStorage: false,
    workflowMode: 'simple',
    connections: emptyConnections(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Siembra un catálogo con `count` videos para userId -- usado por
// account_with_data (10+) y por escenarios de publish (necesitan al menos un
// archivo al que "apuntar" el job). Devuelve los archivos creados.
function seedFiles(userId: string, count: number): LabFile[] {
  const db = getDb();
  const files: LabFile[] = [];
  for (let i = 0; i < count; i++) {
    const platforms: Platform[] = i % 3 === 0 ? ['youtube', 'instagram', 'tiktok'] : i % 2 === 0 ? ['youtube'] : [];
    const file: LabFile = {
      id: newId(),
      userId,
      fileName: `laboratorio-video-${i + 1}.mp4`,
      durationSeconds: 30 + (i % 5) * 15,
      createdAt: new Date(Date.now() - (count - i) * 86_400_000).toISOString(),
      platforms,
      platformsDiscarded: [],
    };
    files.push(file);
    db.files.push(file);

    for (const platform of platforms) {
      const platformId = mockPlatformId(platform);
      db.platformVideos.push({
        id: newId(),
        userId,
        platform,
        platformId,
        platformUrl: mockPlatformUrl(platform, platformId),
        title: file.fileName,
        thumbnail: mockThumbnailUrl(file.fileName),
        linkedFileId: file.id,
        views: Math.floor(Math.random() * 5000),
        likes: Math.floor(Math.random() * 400),
        comments: Math.floor(Math.random() * 60),
        publishedAt: file.createdAt,
        lastSyncedAt: new Date().toISOString(),
      });
      db.uploadHistory.push({
        id: newId(),
        userId,
        platform,
        platformId,
        platformUrl: mockPlatformUrl(platform, platformId),
        fileName: file.fileName,
        title: file.fileName,
        deviceId: 'lab-seed',
        source: 'lab',
        operationId: null,
        publishedAt: file.createdAt,
        createdAt: file.createdAt,
      });
    }
  }
  for (const platform of ['youtube', 'instagram', 'tiktok'] as Platform[]) {
    db.calendarConfigs.push({
      userId, platform,
      lastPublishedTitle: files[files.length - 1]?.fileName ?? '',
      lastPublishedDate: new Date().toISOString().slice(0, 10),
      intervalDays: 3,
      lastVideoId: files[files.length - 1]?.id ?? null,
      nextVideoId: files.find(f => !f.platforms.includes(platform))?.id ?? null,
    });
  }
  return files;
}

function seedPublishJob(userId: string, platform: Platform, fileName: string, status: 'failed' | 'processing' | 'interrupted', progress: number, message: string, retryable = true) {
  const db = getDb();
  db.publishJobs.push({
    id: newId(),
    userId,
    platform,
    fileId: null,
    fileName,
    status,
    progress,
    message,
    retryable,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

// Aplica un escenario: crea (o reemplaza, si ya existía ese username) el
// LabUser y siembra los datos que le correspondan. Devuelve el usuario final
// (con password en texto plano, para mostrarlo en el panel admin).
export function applyScenario(key: string, username: string, password: string): LabUser {
  const db = getDb();
  const uname = username.toLowerCase();

  // Si el username ya existía, se reemplaza por completo (mismo criterio que
  // "crear o editar" del panel admin) -- se limpia todo lo que colgaba de su
  // id VIEJO antes de generar uno nuevo.
  const previous = db.users.find(u => u.username === uname);
  if (previous) {
    db.files = db.files.filter(f => f.userId !== previous.id);
    db.platformVideos = db.platformVideos.filter(p => p.userId !== previous.id);
    db.uploadHistory = db.uploadHistory.filter(h => h.userId !== previous.id);
    db.publishingStatus = db.publishingStatus.filter(p => p.userId !== previous.id);
    db.calendarConfigs = db.calendarConfigs.filter(c => c.userId !== previous.id);
    db.publishJobs = db.publishJobs.filter(j => j.userId !== previous.id);
  }
  db.users = db.users.filter(u => u.username !== uname);

  const id = newId();
  let user: LabUser;
  switch (key) {
    case 'owner_premium':
      user = baseUser({
        id, username: uname, password, scenario: key,
        role: 'todopoderoso', tier: 'premium', isOwner: true, hasCloudStorage: true,
        connections: { youtube: connected('Canal Lab', 'youtube'), instagram: connected('@lab.instagram', 'instagram'), tiktok: connected('@lab.tiktok', 'tiktok') },
      });
      seedFiles(id, 6);
      break;

    case 'editor_free':
      user = baseUser({ id, username: uname, password, scenario: key, role: 'editor', tier: 'free' });
      seedFiles(id, 3);
      break;

    case 'cloud_user':
      user = baseUser({
        id, username: uname, password, scenario: key,
        role: 'editor', tier: 'premium', hasCloudStorage: true,
        connections: { youtube: connected('Canal Lab', 'youtube'), instagram: connected('@lab.instagram', 'instagram'), tiktok: connected('@lab.tiktok', 'tiktok') },
      });
      seedFiles(id, 4);
      break;

    case 'expired_connection':
      user = baseUser({
        id, username: uname, password, scenario: key,
        role: 'editor', tier: 'premium',
        connections: { youtube: connected('Canal Lab'), instagram: expired('@lab.instagram'), tiktok: expired('@lab.tiktok') },
      });
      seedFiles(id, 3);
      break;

    case 'publish_failed':
      user = baseUser({
        id, username: uname, password, scenario: key, role: 'editor', tier: 'premium',
        connections: { youtube: connected('Canal Lab', 'youtube'), instagram: connected('@lab.instagram', 'instagram'), tiktok: connected('@lab.tiktok', 'tiktok') },
      });
      seedFiles(id, 3);
      seedPublishJob(id, 'instagram', 'laboratorio-video-1.mp4', 'failed', 0, 'Error recuperable simulado: la plataforma devolvió un 500. Reintentá.', true);
      break;

    case 'publish_slow':
      user = baseUser({
        id, username: uname, password, scenario: key, role: 'editor', tier: 'premium',
        connections: { youtube: connected('Canal Lab', 'youtube'), instagram: connected('@lab.instagram', 'instagram'), tiktok: connected('@lab.tiktok', 'tiktok') },
      });
      seedFiles(id, 3);
      seedPublishJob(id, 'youtube', 'laboratorio-video-1.mp4', 'processing', 55, 'Procesando en el servidor de la plataforma (simulado)...', false);
      break;

    case 'publish_interrupted':
      user = baseUser({
        id, username: uname, password, scenario: key, role: 'editor', tier: 'premium',
        connections: { youtube: connected('Canal Lab', 'youtube'), instagram: connected('@lab.instagram', 'instagram'), tiktok: connected('@lab.tiktok', 'tiktok') },
      });
      seedFiles(id, 3);
      seedPublishJob(id, 'tiktok', 'laboratorio-video-1.mp4', 'interrupted', 30, 'La subida se interrumpió (simulado: conexión perdida). Pendiente de reintento.', true);
      break;

    case 'empty_account':
      user = baseUser({ id, username: uname, password, scenario: key, role: 'editor', tier: 'free' });
      break;

    case 'account_with_data':
      user = baseUser({
        id, username: uname, password, scenario: key,
        role: 'editor', tier: 'premium', hasCloudStorage: true,
        connections: { youtube: connected('Canal Lab', 'youtube'), instagram: connected('@lab.instagram', 'instagram'), tiktok: connected('@lab.tiktok', 'tiktok') },
      });
      seedFiles(id, 12);
      break;

    default:
      throw new Error(`Escenario desconocido: ${key}`);
  }

  db.users.push(user);
  persist();
  return user;
}
