"""
restore_to_local.py — Restaura metadatos desde Mongo (central) al SQLite local.

Copia la "biblioteca en la nube" (lista de videos, estado de publicación y
videos de plataforma con su matching) a la base local de la app, para que la app
de escritorio muestre lo mismo que ves en el dominio. NO copia los archivos de
video en sí: esos siguen en tu disco; al re-escanear la carpeta se re-vinculan.

Base de la futura gema "Backup en línea".

Uso:
    python restore_to_local.py              # dry-run: muestra qué traería
    python restore_to_local.py --apply      # ejecuta la restauración
    python restore_to_local.py --db RUTA    # SQLite destino (default: ~/.esse-analytics/esse_local.db)

IMPORTANTE: cierra la app de escritorio antes de usar --apply (el SQLite no debe
estar en uso por otro proceso).
"""

import os
import sys
import json
import argparse
import sqlite3
from datetime import datetime, date

from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', 'backend', '.env'))
MONGO_URI = os.getenv('MONGO_URI', '')

DEFAULT_DB = os.path.join(os.path.expanduser('~'), '.esse-analytics', 'esse_local.db')


def iso(v):
    """Convierte fechas de Mongo a texto ISO; deja strings/None tal cual."""
    if v is None:
        return None
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return str(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='Ejecuta la restauración (sin esto, solo muestra).')
    ap.add_argument('--db', default=DEFAULT_DB, help='Ruta del SQLite local destino.')
    args = ap.parse_args()

    if not MONGO_URI:
        print('ERROR: MONGO_URI no encontrado en backend/.env')
        sys.exit(1)
    if not os.path.exists(args.db):
        print(f'ERROR: no existe el SQLite local en: {args.db}')
        print('Abre la app al menos una vez, o pasa la ruta con --db.')
        sys.exit(1)

    db = MongoClient(MONGO_URI)['renders_manager']
    files       = list(db['files'].find())
    pub_status  = list(db['publishing_status'].find())
    plat_videos = list(db['platformvideos'].find())

    print(f'En Mongo:  files={len(files)}  publishing_status={len(pub_status)}  platform_videos={len(plat_videos)}')

    if not args.apply:
        print('\n[DRY-RUN] No se escribió nada. Repite con --apply para restaurar.')
        print('Recuerda cerrar la app de escritorio antes de --apply.')
        return

    conn = sqlite3.connect(args.db)
    conn.execute('PRAGMA foreign_keys = OFF')  # insertamos en orden controlado
    cur = conn.cursor()

    # Limpieza de las tablas a restaurar (orden por dependencias)
    for t in ('publishing_status', 'platform_videos', 'files'):
        cur.execute(f'DELETE FROM {t}')

    # 1. files — guardando el mapeo Mongo _id -> SQLite id
    id_map = {}
    for f in files:
        cur.execute(
            """INSERT INTO files
               (file_name, file_path, status, content_status, platforms,
                duracion_segundos, resolucion, formato, fecha_creacion, scheduled_date)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                f.get('file_name', ''),
                f.get('file_path', ''),
                f.get('status', 'PENDIENTE'),
                f.get('content_status', 'borrador'),
                json.dumps(f.get('platforms', []) or []),
                f.get('duracion_segundos'),
                f.get('resolucion'),
                f.get('formato'),
                iso(f.get('fecha_creacion')),
                iso(f.get('scheduled_date')),
            ),
        )
        id_map[str(f['_id'])] = cur.lastrowid

    # 2. publishing_status — remapeando fileId
    ps_ok = 0
    for p in pub_status:
        local_id = id_map.get(str(p.get('fileId')))
        if not local_id:
            continue
        cur.execute(
            """INSERT OR IGNORE INTO publishing_status
               (file_id, title, tiktok_published, instagram_published, youtube_published)
               VALUES (?,?,?,?,?)""",
            (
                local_id,
                p.get('title', ''),
                1 if p.get('tiktok_published') else 0,
                1 if p.get('instagram_published') else 0,
                1 if p.get('youtube_published') else 0,
            ),
        )
        ps_ok += 1

    # 3. platform_videos — remapeando linkedFileId
    pv_ok = 0
    for v in plat_videos:
        linked = id_map.get(str(v.get('linkedFileId'))) if v.get('linkedFileId') else None
        cur.execute(
            """INSERT OR IGNORE INTO platform_videos
               (platform, platform_id, platform_url, published_at, linked_file_id, match_status)
               VALUES (?,?,?,?,?,?)""",
            (
                v.get('platform', ''),
                str(v.get('platformId', '')),
                v.get('platformUrl'),
                iso(v.get('publishedAt')),
                linked,
                v.get('matchStatus', 'sin_match'),
            ),
        )
        pv_ok += 1

    conn.commit()
    conn.close()

    print('\n✓ Restauración completa:')
    print(f'  files restaurados:            {len(id_map)}')
    print(f'  publishing_status restaurados: {ps_ok}')
    print(f'  platform_videos restaurados:   {pv_ok}')
    print('\nAbre la app y re-escanea tu carpeta de videos para re-vincular los archivos en disco.')


if __name__ == '__main__':
    main()
