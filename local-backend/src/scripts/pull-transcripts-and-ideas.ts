/**
 * Migra transcripciones e ideas centrales ya existentes en la central (Mongo, legado
 * de transcripIA) hacia el SQLite local, matcheando por file_name — mismo criterio
 * que pull-to-sqlite.ts. Es idempotente: una idea ya migrada (o ya agrupada por
 * Maiden) no se vuelve a tocar.
 *
 * Uso: JWT=<token> npx tsx src/scripts/pull-transcripts-and-ideas.ts
 *      (JWT se puede generar en backend/ con: npx tsx src/scripts/_gen-jwt.ts)
 */
import dotenv from 'dotenv';
dotenv.config();

import { fileRepo } from '../db/file.repo';
import { transcriptRepo } from '../db/transcript.repo';
import { ideaRepo, IdeaRol } from '../db/idea.repo';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';
const JWT     = process.env.JWT || '';

if (!JWT) { console.error('Falta JWT. Uso: JWT=<token> npx tsx src/scripts/pull-transcripts-and-ideas.ts'); process.exit(1); }

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${CENTRAL}${path}`, { headers: { Authorization: `Bearer ${JWT}` } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface RemoteTranscript {
  file_name: string;
  transcript_text: string;
  language: string;
  tipo_contenido: string | null;
}

interface RemoteIdeaVideo {
  file_name: string;
  similitud_guion: number;
  rol: IdeaRol;
}

interface RemoteIdea {
  idea_nucleo: string;
  resumen_visual: string;
  status: string;
  video_principal_name: string | null;
  videos: RemoteIdeaVideo[];
}

async function pullTranscripts() {
  const { transcripts } = await fetchJson<{ transcripts: RemoteTranscript[] }>('/api/backup/transcripts');
  console.log(`Transcripciones en la central: ${transcripts.length}`);

  let updated = 0, notFound = 0;
  for (const t of transcripts) {
    const file = fileRepo.findByName(t.file_name);
    if (!file) { notFound++; continue; }

    transcriptRepo.upsert(file.id, t.transcript_text, t.language ?? 'es');
    if (t.tipo_contenido) fileRepo.update(file.id, { tipo_contenido: t.tipo_contenido });
    updated++;
  }
  console.log(`✓ Transcripciones migradas: ${updated}  Sin match local: ${notFound}`);
}

async function pullIdeas() {
  const { ideas } = await fetchJson<{ ideas: RemoteIdea[] }>('/api/backup/ideas-centrales');
  console.log(`Ideas centrales en la central: ${ideas.length}`);

  const yaAgrupados = ideaRepo.clusteredFileIds();
  let creadas = 0, saltadas = 0, sinVideosLocales = 0;

  for (const idea of ideas) {
    const resueltos = idea.videos
      .map(v => ({ file: fileRepo.findByName(v.file_name), similitud_guion: v.similitud_guion, rol: v.rol }))
      .filter((v): v is { file: NonNullable<typeof v.file>; similitud_guion: number; rol: IdeaRol } => !!v.file);

    if (resueltos.length === 0) { sinVideosLocales++; continue; }

    // Si CUALQUIERA de estos videos ya pertenece a una idea local (migrada antes o
    // agrupada por Maiden), no tocamos nada — nunca pisamos ideas existentes.
    if (resueltos.some(r => yaAgrupados.has(r.file.id))) { saltadas++; continue; }

    const principal = resueltos.find(r => r.file.file_name === idea.video_principal_name) ?? resueltos[0];

    ideaRepo.create({
      idea_nucleo: idea.idea_nucleo,
      resumen_visual: idea.resumen_visual || idea.idea_nucleo,
      video_principal_id: principal.file.id,
      videos: resueltos.map(r => ({
        file_id: r.file.id,
        similitud_guion: r.similitud_guion,
        rol: r.file.id === principal.file.id ? 'POR_DEFECTO' : (r.rol === 'POR_DEFECTO' ? 'RELACIONADO' : r.rol),
      })),
    });
    for (const r of resueltos) yaAgrupados.add(r.file.id);
    creadas++;
  }

  console.log(`✓ Ideas migradas: ${creadas}  Ya existían localmente: ${saltadas}  Sin ningún video en este equipo: ${sinVideosLocales}`);
}

async function main() {
  await pullTranscripts();
  await pullIdeas();
}

main().catch(err => { console.error(err); process.exit(1); });
