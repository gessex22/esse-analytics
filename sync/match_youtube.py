"""
Sincronización retroactiva: vincula YouTube Shorts con archivos locales.

Algoritmo:
  1. Para cada video YT sin linkedFileId:
     a. Calcula fecha esperada del archivo: publishedAt - DATE_OFFSET_DAYS
     b. Busca locales con:
        - duracion ±DURATION_SLACK segundos
        - fecha_creacion dentro de ±DATE_WINDOW_DAYS días del offset
     c. Si match único → vincula como auto_duration
     d. Si múltiples → Jaccard(titulo YT, transcript local)
     e. Si ninguno por fecha → reintenta solo por duración (marcar revisar)
     f. Si ninguno → sin_match

Calibración (2 matches confirmados):
  final - mac neo.mp4       → publicado 96 días después de creación
  final - ram unificada.mp4 → publicado 95 días después de creación

Uso:
  python match_youtube.py              # modo normal
  python match_youtube.py --dry-run    # muestra resultados sin guardar
  python match_youtube.py --verbose    # detalle de cada decisión
"""

import os
import sys
import re
import argparse
from datetime import datetime, timedelta, timezone
from pymongo import MongoClient
from dotenv import load_dotenv

# Forzar UTF-8 en stdout para manejar emojis en títulos de YouTube
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

def safe(text: str, length: int = 55) -> str:
    """Trunca y elimina caracteres no imprimibles para el log."""
    return text[:length].encode('ascii', errors='replace').decode('ascii')

try:
    from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled
    TRANSCRIPT_AVAILABLE = True
except ImportError:
    TRANSCRIPT_AVAILABLE = False

# ── Configuración ──────────────────────────────────────────────────────────────

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', 'backend', '.env'))

MONGO_URI           = os.getenv('MONGO_URI', '')
DURATION_SLACK      = 2    # ±segundos de tolerancia en duración
DATE_OFFSET_DAYS    = 96   # días entre creación local y publicación en YT (calibrado)
DATE_WINDOW_DAYS    = 60   # ±días de tolerancia alrededor del offset (±2 meses)
TEXT_THRESHOLD      = 0.15 # Jaccard mínimo para vincular por texto

# ── MongoDB ────────────────────────────────────────────────────────────────────

def get_db():
    client = MongoClient(MONGO_URI)
    return client['renders_manager']

# ── Similitud de texto (Jaccard sobre palabras) ────────────────────────────────

def normalize(text: str) -> set:
    text = text.lower()
    text = re.sub(r'[^\w\s]', '', text)
    words = set(text.split())
    # Quitar stopwords comunes en español
    stop = {'de','la','el','en','un','una','los','las','y','a','que','es','para','por','con','del'}
    return words - stop

def jaccard(a: str, b: str) -> float:
    sa, sb = normalize(a), normalize(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)

# ── Lógica principal ───────────────────────────────────────────────────────────

def find_candidates(files_col, yt_dur: float, date_from: datetime, date_to: datetime) -> list:
    """Busca candidatos por duración Y fecha de creación."""
    return list(files_col.find({
        'duracion_segundos': {'$gte': yt_dur - DURATION_SLACK, '$lte': yt_dur + DURATION_SLACK},
        'fecha_creacion':    {'$gte': date_from, '$lte': date_to},
        'status':            {'$ne': 'ELIMINADO_DISCO'},
    }))

def find_candidates_duration_only(files_col, yt_dur: float) -> list:
    """Fallback: busca solo por duración (sin filtro de fecha)."""
    return list(files_col.find({
        'duracion_segundos': {'$gte': yt_dur - DURATION_SLACK, '$lte': yt_dur + DURATION_SLACK},
        'status':            {'$ne': 'ELIMINADO_DISCO'},
    }))

def best_text_match(candidates: list, yt_title: str, transcripts_col, verbose: bool):
    best_score = -1.0
    best_local = None
    for local in candidates:
        tr = transcripts_col.find_one({'file_id': local['_id']})
        if not tr or not tr.get('transcript_text'):
            continue
        score = jaccard(yt_title, tr['transcript_text'])
        if verbose:
            print(f"    {local['file_name'][:40]:40s}  score={score:.3f}")
        if score > best_score:
            best_score = score
            best_local = local
    return best_local, best_score

def run(dry_run: bool, verbose: bool):
    db = get_db()
    platform_videos = db['platformvideos']
    files_col       = db['files']
    transcripts_col = db['transcripts']

    unlinked = list(platform_videos.find({
        'platform': 'youtube',
        'linkedFileId': None,
    }))

    print(f"\n{'='*60}")
    print(f"  YouTube Match - {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"  Videos sin vincular : {len(unlinked)}")
    print(f"  Offset calibrado    : {DATE_OFFSET_DAYS} dias (+/-{DATE_WINDOW_DAYS})")
    print(f"  Modo                : {'DRY RUN (sin guardar)' if dry_run else 'REAL'}")
    print(f"{'='*60}\n")

    stats = {'vinculados': 0, 'texto': 0, 'sin_match': 0, 'revisar': 0}

    for short in unlinked:
        yt_id    = short['platformId']
        yt_dur   = short.get('durationSeconds', 0)
        yt_title = short.get('title', '')
        yt_pub   = short.get('publishedAt')

        if verbose:
            print(f">> [{yt_id}] \"{safe(yt_title)}\" ({yt_dur}s | pub:{yt_pub.strftime('%Y-%m-%d') if yt_pub else '?'})")

        # Calcular ventana de fecha esperada
        if yt_pub:
            expected = yt_pub - timedelta(days=DATE_OFFSET_DAYS)
            date_from = expected - timedelta(days=DATE_WINDOW_DAYS)
            date_to   = expected + timedelta(days=DATE_WINDOW_DAYS)
            candidates = find_candidates(files_col, yt_dur, date_from, date_to)
        else:
            candidates = []

        if verbose and yt_pub:
            print(f"   fecha esperada: {expected.strftime('%Y-%m-%d')} (+/-{DATE_WINDOW_DAYS}d) → {len(candidates)} candidatos")

        # Match único por duración + fecha → vincular directo
        if len(candidates) == 1:
            winner = candidates[0]
            if verbose:
                print(f"  -> MATCH DIRECTO: {winner['file_name']}\n")
            if not dry_run:
                platform_videos.update_one(
                    {'_id': short['_id']},
                    {'$set': {'linkedFileId': winner['_id'], 'matchStatus': 'auto_duration'}}
                )
            stats['vinculados'] += 1
            continue

        # Múltiples candidatos → desempatar por texto
        if len(candidates) > 1:
            if verbose:
                print(f"  -> {len(candidates)} candidatos. Comparando titulo vs transcripts...")
            best_local, best_score = best_text_match(candidates, yt_title, transcripts_col, verbose)

            if best_local and best_score >= TEXT_THRESHOLD:
                if verbose:
                    print(f"  -> MATCH TEXTO ({best_score:.3f}): {best_local['file_name']}\n")
                if not dry_run:
                    platform_videos.update_one(
                        {'_id': short['_id']},
                        {'$set': {
                            'linkedFileId': best_local['_id'],
                            'matchStatus': 'auto_text',
                            'matchScore': best_score,
                        }}
                    )
                stats['texto'] += 1
            else:
                if verbose:
                    print(f"  -> SCORE BAJO ({best_score:.3f}). Marcando para revision.\n")
                if not dry_run:
                    platform_videos.update_one(
                        {'_id': short['_id']},
                        {'$set': {
                            'matchStatus': 'revisar_manual',
                            'matchCandidates': [str(c['_id']) for c in candidates],
                            'matchScore': best_score,
                        }}
                    )
                stats['revisar'] += 1
            continue

        # Sin candidatos por fecha: fallback solo duración
        fallback = find_candidates_duration_only(files_col, yt_dur)
        if not fallback:
            if verbose:
                print(f"  -> SIN MATCH\n")
            if not dry_run:
                platform_videos.update_one(
                    {'_id': short['_id']},
                    {'$set': {'matchStatus': 'sin_match'}}
                )
            stats['sin_match'] += 1
        else:
            if verbose:
                print(f"  -> Sin candidatos en ventana de fecha. {len(fallback)} por duracion → revisar.\n")
            if not dry_run:
                platform_videos.update_one(
                    {'_id': short['_id']},
                    {'$set': {
                        'matchStatus': 'revisar_manual',
                        'matchCandidates': [str(c['_id']) for c in fallback],
                    }}
                )
            stats['revisar'] += 1

    print(f"\n{'='*60}")
    print(f"  RESULTADO {'(DRY RUN)' if dry_run else ''}")
    print(f"  [OK] Vinculados por duracion+fecha : {stats['vinculados']}")
    print(f"  [OK] Vinculados por texto          : {stats['texto']}")
    print(f"  [??] Requieren revision manual     : {stats['revisar']}")
    print(f"  [--] Sin match                     : {stats['sin_match']}")
    print(f"  Total procesados                   : {sum(stats.values())}")
    print(f"{'='*60}\n")

# ── Entrada ────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run',  action='store_true')
    parser.add_argument('--verbose',  action='store_true')
    args = parser.parse_args()

    if not MONGO_URI:
        print("ERROR: MONGO_URI no encontrado en .env")
        sys.exit(1)

    run(dry_run=args.dry_run, verbose=args.verbose)
