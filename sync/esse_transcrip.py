"""
esse-Transcrip — Plugin de transcripción para EsseAnalytics.

Detecta automáticamente el hardware disponible (CUDA / Apple Silicon MPS / CPU),
elige el modelo Whisper apropiado y transcribe los videos escaneados que aún no
tienen transcripción, enviando los resultados a la API local.

Uso:
    python esse_transcrip.py [opciones]

Opciones:
    --api    URL de la API local (default: http://localhost:4000)
    --model  Modelo Whisper a forzar: tiny, base, small, medium, large-v2, large-v3
    --lang   Idioma a forzar (default: detección automática; ej: es, en)
    --limit  Máximo de videos a procesar en esta ejecución (default: sin límite)
    --dry    Muestra qué procesaría, sin transcribir ni enviar nada

Dependencias:
    pip install faster-whisper requests
    # Para GPU NVIDIA (CUDA):
    pip install torch --index-url https://download.pytorch.org/whl/cu121
"""

import argparse
import platform
import subprocess
import sys
import os
import requests
import time

# ── Detección de hardware ─────────────────────────────────────────────────────

def detect_device() -> dict:
    """
    Retorna info del dispositivo de cómputo disponible.
    {
      "device":   "cuda" | "mps" | "cpu",
      "compute":  "float16" | "int8",
      "vram_gb":  float | None,
      "name":     str,
    }
    """
    info = {"device": "cpu", "compute": "int8", "vram_gb": None, "name": "CPU"}

    # ── NVIDIA CUDA ──
    try:
        import torch
        if torch.cuda.is_available():
            vram = torch.cuda.get_device_properties(0).total_memory / 1e9
            info.update({
                "device":  "cuda",
                "compute": "float16",
                "vram_gb": round(vram, 1),
                "name":    torch.cuda.get_device_name(0),
            })
            return info
    except ImportError:
        pass

    # ── Apple Silicon MPS ──
    system = platform.system()
    if system == "Darwin":
        machine = platform.machine()
        if machine == "arm64":
            try:
                import torch
                if torch.backends.mps.is_available():
                    # Obtiene VRAM aproximada via system_profiler
                    vram = _get_apple_vram_gb()
                    info.update({
                        "device":  "mps",
                        "compute": "float16",
                        "vram_gb": vram,
                        "name":    f"Apple Silicon ({machine})",
                    })
                    return info
            except (ImportError, Exception):
                # Sin torch pero sí en Mac arm64: usar CPU con int8
                info["name"] = f"Apple Silicon ({machine}) — CPU fallback"
                return info

    return info


def _get_apple_vram_gb() -> float | None:
    """Extrae la VRAM del chip Apple vía system_profiler."""
    try:
        out = subprocess.check_output(
            ["system_profiler", "SPDisplaysDataType"],
            text=True, timeout=5
        )
        for line in out.splitlines():
            if "VRAM" in line or "Metal" in line:
                parts = line.split(":")
                if len(parts) > 1:
                    val = parts[1].strip().split()[0]
                    if val.isdigit():
                        return float(val) / 1024 if int(val) > 32 else float(val)
    except Exception:
        pass
    return None


# ── Selección automática de modelo ────────────────────────────────────────────

def choose_model(device_info: dict) -> str:
    """
    Elige el modelo más capaz que el hardware puede manejar de forma cómoda.

    Referencia de VRAM aproximada:
      tiny    ~1 GB   — CPU rápido, baja precisión
      base    ~1 GB   — buen balance para CPU
      small   ~2 GB   — recomendado para GPU baja
      medium  ~5 GB   — buena precisión
      large-v2 ~10 GB — alta precisión
      large-v3 ~10 GB — máxima precisión (más lento que v2 en algunos casos)
    """
    device = device_info["device"]
    vram   = device_info.get("vram_gb")

    if device == "cuda":
        if vram and vram >= 10:
            return "large-v3"
        if vram and vram >= 5:
            return "medium"
        return "small"

    if device == "mps":
        if vram and vram >= 8:
            return "medium"
        return "small"

    # CPU
    return "base"


# ── API helpers ───────────────────────────────────────────────────────────────

def fetch_slim(api: str) -> list[dict]:
    """Retorna todos los videos escaneados: [{fileId, title, filePath, duration}]"""
    resp = requests.get(f"{api}/api/videos/slim", timeout=10)
    resp.raise_for_status()
    return resp.json()


def has_transcript(api: str, file_id: str) -> bool:
    """Devuelve True si el video ya tiene transcripción en la API."""
    try:
        resp = requests.get(f"{api}/api/videos/{file_id}/transcript", timeout=5)
        return resp.status_code == 200
    except Exception:
        return False


def post_transcript(api: str, file_id: str, text: str, language: str) -> bool:
    """Envía la transcripción a la API local. Retorna True si fue exitoso."""
    try:
        resp = requests.post(
            f"{api}/api/videos/{file_id}/transcript",
            json={"text": text, "language": language},
            timeout=10,
        )
        return resp.status_code in (200, 201)
    except Exception as e:
        print(f"  [ERROR] POST transcript: {e}")
        return False


# ── Transcripción ─────────────────────────────────────────────────────────────

def transcribe(file_path: str, model_name: str, device_info: dict, lang: str | None) -> tuple[str, str]:
    """
    Transcribe el audio/video en file_path con faster-whisper.
    Retorna (text, detected_language).
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("[ERROR] faster-whisper no está instalado.")
        print("  Instala con: pip install faster-whisper")
        sys.exit(1)

    device  = device_info["device"]
    compute = device_info["compute"]

    # MPS aún no está oficialmente soportado por faster-whisper (usa CTranslate2).
    # Usamos CPU si device es mps.
    ct2_device = "cuda" if device == "cuda" else "cpu"
    ct2_compute = compute if ct2_device == "cuda" else "int8"

    model = WhisperModel(model_name, device=ct2_device, compute_type=ct2_compute)

    segments, info = model.transcribe(
        file_path,
        language=lang or None,
        beam_size=5,
    )

    text = " ".join(seg.text.strip() for seg in segments)
    return text.strip(), info.language


# ── Punto de entrada ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="esse-Transcrip: transcripción automática de videos locales")
    parser.add_argument("--api",   default="http://localhost:4000", help="URL de la API local")
    parser.add_argument("--model", default=None, help="Modelo Whisper a forzar (tiny/base/small/medium/large-v2/large-v3)")
    parser.add_argument("--lang",  default=None, help="Idioma a forzar (ej: es, en). Por defecto: auto-detección")
    parser.add_argument("--limit", type=int, default=None, help="Máximo de videos a procesar")
    parser.add_argument("--dry",   action="store_true", help="Solo muestra qué procesaría, sin transcribir")
    args = parser.parse_args()

    print("=" * 60)
    print("  esse-Transcrip")
    print("=" * 60)

    # Detectar hardware
    dev = detect_device()
    print(f"\nDispositivo : {dev['device'].upper()} — {dev['name']}")
    if dev["vram_gb"]:
        print(f"VRAM        : {dev['vram_gb']} GB")

    # Elegir modelo
    model_name = args.model or choose_model(dev)
    print(f"Modelo      : {model_name}")
    print(f"Idioma      : {args.lang or 'auto-detección'}")
    print(f"API         : {args.api}")
    print()

    # Obtener lista de videos
    try:
        videos = fetch_slim(args.api)
    except Exception as e:
        print(f"[ERROR] No se pudo conectar a la API en {args.api}: {e}")
        print("  ¿Está corriendo EsseAnalytics?")
        sys.exit(1)

    if not videos:
        print("No hay videos escaneados.")
        return

    print(f"Videos escaneados: {len(videos)}")

    # Filtrar los que ya tienen transcripción
    pendientes = []
    print("Verificando transcripciones existentes...")
    for v in videos:
        if not v.get("filePath"):
            continue
        if not os.path.isfile(v["filePath"]):
            continue  # el archivo ya no existe en disco
        if not has_transcript(args.api, v["fileId"]):
            pendientes.append(v)

    print(f"Pendientes de transcribir: {len(pendientes)}")

    if args.limit:
        pendientes = pendientes[: args.limit]
        print(f"(limitado a {args.limit} en esta ejecución)")

    if not pendientes:
        print("\nTodos los videos ya tienen transcripción.")
        return

    if args.dry:
        print("\n[DRY RUN] Se procesarían:")
        for v in pendientes:
            print(f"  {v['fileId']} — {v['title']} — {v['filePath']}")
        return

    # Transcribir
    print()
    ok = 0
    err = 0
    for i, v in enumerate(pendientes, 1):
        file_id   = v["fileId"]
        title     = v["title"]
        file_path = v["filePath"]

        print(f"[{i}/{len(pendientes)}] {title}")
        print(f"  Archivo : {file_path}")
        t0 = time.time()

        try:
            text, lang_detected = transcribe(file_path, model_name, dev, args.lang)
            elapsed = time.time() - t0
            words   = len(text.split())
            print(f"  Idioma  : {lang_detected} | Palabras: {words} | Tiempo: {elapsed:.1f}s")

            if post_transcript(args.api, file_id, text, lang_detected):
                print(f"  ✓ Guardado")
                ok += 1
            else:
                print(f"  ✗ Error al guardar")
                err += 1

        except Exception as e:
            print(f"  [ERROR] {e}")
            err += 1

        print()

    print("=" * 60)
    print(f"Completado: {ok} transcritos, {err} errores")
    print("=" * 60)


if __name__ == "__main__":
    main()
