"""
Maiden — Plugin de agrupación de ideas para EsseAnalytics.

Analiza las transcripciones de tipo GUION_ESTRUCTURADO que todavía no pertenecen
a ninguna "idea central" y las agrupa por similitud semántica (mismo guion grabado
varias veces = misma idea). Nunca toca ideas ya existentes: si un video nuevo
matchea con una idea que el usuario ya armó/editó en el Taller, solo se suma como
versión alternativa. Si no matchea nada, arma una idea nueva.

Uso:
    python maiden.py [opciones]

Opciones:
    --api        URL de la API local (default: http://localhost:4000)
    --threshold  Umbral de similitud semántica para agrupar, 0-100 (default: 75)
    --dry        Muestra qué agruparía, sin escribir nada en la API

Dependencias:
    pip install sentence-transformers numpy requests
"""

import argparse
import sys

import numpy as np
import requests

# La consola de Windows por defecto usa cp1252 y no puede imprimir los
# emojis/flechas de este script — forzamos UTF-8 para evitar un crash.
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")


# ── API helpers ───────────────────────────────────────────────────────────────

def fetch_idea_cores(api: str) -> list[dict]:
    """Ideas ya existentes: [{id, idea_nucleo}]."""
    resp = requests.get(f"{api}/api/maiden/idea-cores", timeout=10)
    resp.raise_for_status()
    return resp.json()


def fetch_candidates(api: str) -> list[dict]:
    """Guiones transcritos que aún no pertenecen a ninguna idea."""
    resp = requests.get(f"{api}/api/maiden/candidates", timeout=10)
    resp.raise_for_status()
    return resp.json()


def post_add_video(api: str, idea_id: int, file_id: int, similitud: float, rol: str) -> bool:
    """Suma un video a una idea EXISTENTE, sin tocar su video principal ni su estado."""
    try:
        resp = requests.post(
            f"{api}/api/ideas-centrales/{idea_id}/videos",
            json={"file_id": file_id, "similitud_guion": similitud, "rol": rol},
            timeout=10,
        )
        return resp.status_code in (200, 201)
    except Exception as e:
        print(f"  [ERROR] POST videos: {e}")
        return False


def post_new_idea(api: str, idea_nucleo: str, resumen_visual: str, videos: list[dict], video_principal_id: int) -> bool:
    """Crea una idea nueva a partir de un pool de videos sin agrupar."""
    try:
        resp = requests.post(
            f"{api}/api/ideas-centrales",
            json={
                "idea_nucleo": idea_nucleo,
                "resumen_visual": resumen_visual,
                "video_principal_id": video_principal_id,
                "videos": videos,
            },
            timeout=10,
        )
        return resp.status_code in (200, 201)
    except Exception as e:
        print(f"  [ERROR] POST ideas-centrales: {e}")
        return False


# ── Similitud ─────────────────────────────────────────────────────────────────

def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Similitud semántica (0-1) entre dos embeddings."""
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def word_overlap(text_a: str, text_b: str) -> float:
    """Coincidencia de palabras (0-100), simula la fidelidad textual del guion."""
    palabras_a = set(text_a.lower().split())
    palabras_b = set(text_b.lower().split())
    if not palabras_a or not palabras_b:
        return 0.0
    return round(len(palabras_a & palabras_b) / max(len(palabras_a), len(palabras_b)) * 100, 1)


# ── Punto de entrada ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Maiden: agrupa transcripciones parecidas en ideas centrales")
    parser.add_argument("--api",       default="http://localhost:4000", help="URL de la API local")
    parser.add_argument("--threshold", type=float, default=75.0, help="Umbral de similitud semántica (0-100)")
    parser.add_argument("--dry",       action="store_true", help="Solo muestra qué agruparía, sin escribir nada")
    args = parser.parse_args()

    print("=" * 60)
    print("  Maiden")
    print("=" * 60)
    print(f"API       : {args.api}")
    print(f"Umbral    : {args.threshold}%")
    print()

    try:
        idea_cores = fetch_idea_cores(args.api)
        candidatos = fetch_candidates(args.api)
    except Exception as e:
        print(f"[ERROR] No se pudo conectar a la API en {args.api}: {e}")
        print("  ¿Está corriendo EsseAnalytics?")
        sys.exit(1)

    print(f"Ideas existentes      : {len(idea_cores)}")
    print(f"Candidatos sin agrupar: {len(candidatos)}")

    if not candidatos:
        print("\nNada para agrupar. Todos los guiones ya pertenecen a una idea.")
        return

    print("\n[IA] Cargando modelo de similitud semántica...")
    from sentence_transformers import SentenceTransformer
    modelo = SentenceTransformer("all-MiniLM-L6-v2")

    textos = [c["idea_nucleo"] for c in idea_cores] + [c["text"] for c in candidatos]
    embeddings = modelo.encode(textos)
    n_cores = len(idea_cores)
    core_embeddings = embeddings[:n_cores]
    cand_embeddings = embeddings[n_cores:]

    asignados: set[int] = set()
    sumados_a_existentes = 0
    nuevas_ideas = 0

    # ── Paso 1: matchear candidatos contra ideas YA existentes ──────────────
    print("\nComparando contra ideas existentes...")
    for i, cand in enumerate(candidatos):
        if n_cores == 0:
            break
        sims = [cosine_similarity(cand_embeddings[i], core_embeddings[j]) for j in range(n_cores)]
        best_j = max(range(n_cores), key=lambda j: sims[j])
        best_pct = sims[best_j] * 100

        if best_pct >= args.threshold:
            idea = idea_cores[best_j]
            overlap = word_overlap(cand["text"], idea["idea_nucleo"])
            print(f"  + '{cand['file_name']}' → idea existente #{idea['id']} ({best_pct:.1f}% semántico, {overlap}% texto)")
            if not args.dry:
                post_add_video(args.api, idea["id"], cand["file_id"], overlap, "RELACIONADO")
            asignados.add(i)
            sumados_a_existentes += 1

    # ── Paso 2: agrupar los candidatos restantes entre sí (ideas nuevas) ────
    restantes = [i for i in range(len(candidatos)) if i not in asignados]
    if restantes:
        print(f"\nAgrupando {len(restantes)} candidatos restantes en ideas nuevas...")

    for pos, i in enumerate(restantes):
        if i in asignados:
            continue
        base = candidatos[i]

        pool = [{
            "file_id":         base["file_id"],
            "file_name":       base["file_name"],
            "fecha":           base["fecha_creacion"] or base["created_at"],
            "formato":         base["formato"] or "DESCONOCIDO",
            "similitud_guion": 100.0,
        }]
        asignados.add(i)

        for j in restantes[pos + 1:]:
            if j in asignados:
                continue
            sim = cosine_similarity(cand_embeddings[i], cand_embeddings[j]) * 100
            if sim >= args.threshold:
                comp = candidatos[j]
                pool.append({
                    "file_id":         comp["file_id"],
                    "file_name":       comp["file_name"],
                    "fecha":           comp["fecha_creacion"] or comp["created_at"],
                    "formato":         comp["formato"] or "DESCONOCIDO",
                    "similitud_guion": word_overlap(base["text"], comp["text"]),
                })
                asignados.add(j)

        # 👑 Regla de oro: mayor similitud de guion y más reciente gana el rol POR_DEFECTO.
        pool.sort(key=lambda v: (v["similitud_guion"], v["fecha"]), reverse=True)
        pool[0]["rol"] = "POR_DEFECTO"
        for v in pool[1:]:
            if v["formato"] == pool[0]["formato"] and v["similitud_guion"] >= 85.0:
                v["rol"] = "SUGERENCIA_BORRAR"
            else:
                v["rol"] = "RELACIONADO"

        resumen = base["text"][:90] + "..." if len(base["text"]) > 90 else base["text"]
        if not args.dry:
            post_new_idea(
                args.api,
                idea_nucleo=base["text"],
                resumen_visual=resumen,
                videos=[{"file_id": v["file_id"], "similitud_guion": v["similitud_guion"], "rol": v["rol"]} for v in pool],
                video_principal_id=pool[0]["file_id"],
            )
        nuevas_ideas += 1
        if len(pool) > 1:
            print(f"  💡 Idea nueva: '{resumen}' → {len(pool)} videos (rey: {pool[0]['file_name']})")

    print()
    print("=" * 60)
    if args.dry:
        print(f"[DRY RUN] Se sumarían {sumados_a_existentes} videos a ideas existentes y se crearían {nuevas_ideas} ideas nuevas.")
    else:
        print(f"Completado: {sumados_a_existentes} videos sumados a ideas existentes, {nuevas_ideas} ideas nuevas creadas.")
    print("=" * 60)


if __name__ == "__main__":
    main()
