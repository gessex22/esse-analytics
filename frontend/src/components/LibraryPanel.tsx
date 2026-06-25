import { useEffect, useState } from "react";
import { Folder, Search, Loader2, CheckCircle2, AlertCircle, Save, Trash2 } from "lucide-react";
import { API_BASE as API } from "../config";
import { useAuth } from "../hooks/useAuth";

interface ScanResult {
  scanned: number;
  added: number;
  restored: number;
  missing: number;
}

type WipeResult = Record<string, number>;

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("esse_auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function isRemote(): boolean {
  const h = window.location.hostname;
  return h !== "localhost" && h !== "127.0.0.1" && !h.startsWith("192.168.");
}

export function LibraryPanel() {
  const { user } = useAuth();
  const [folder,    setFolder]    = useState("");
  const [savedDir,  setSavedDir]  = useState<string | null>(null);
  const [dirExists, setDirExists] = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [scanning,  setScanning]  = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [result,    setResult]    = useState<ScanResult | null>(null);

  const [wiping,      setWiping]      = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [wipeResult,  setWipeResult]  = useState<WipeResult | null>(null);
  const [wipeError,   setWipeError]   = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/api/videos/scan/config`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => { setSavedDir(d.folder ?? null); setDirExists(!!d.exists); if (d.folder) setFolder(d.folder); })
      .catch(() => {});
  }, []);

  const saveFolder = async () => {
    setError(null); setSaving(true); setResult(null);
    try {
      const res = await fetch(`${API}/api/videos/scan/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ folder: folder.trim() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Error al guardar la carpeta");
      setSavedDir(d.folder); setDirExists(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const scan = async () => {
    setError(null); setScanning(true); setResult(null);
    try {
      const res = await fetch(`${API}/api/videos/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({}),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Error al escanear");
      setResult({ scanned: d.scanned, added: d.added, restored: d.restored, missing: d.missing });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setScanning(false);
    }
  };

  const wipe = async () => {
    setWipeError(null); setWiping(true); setWipeResult(null);
    try {
      const res = await fetch(`${API}/api/local/wipe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.message || "Error al limpiar");
      setWipeResult(d.cleared);
      setWipeConfirm(false);
    } catch (e: any) {
      setWipeError(e.message);
    } finally {
      setWiping(false);
    }
  };

  const showWipeZone = !isRemote() && user?.role === "todopoderoso";

  return (
    <div className="space-y-5 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Carpeta de videos</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Indica la carpeta de tu equipo donde están tus videos. La app los detecta y los agrega a tu biblioteca.
        </p>
      </div>

      {/* Input de carpeta */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Folder className="w-3.5 h-3.5" /> Ruta de la carpeta
        </label>
        <div className="flex gap-2">
          <input
            value={folder}
            onChange={e => setFolder(e.target.value)}
            placeholder="C:\Users\TuUsuario\Videos\publicados"
            className="flex-1 px-3 py-2.5 bg-secondary/40 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors font-mono"
          />
          <button
            onClick={saveFolder}
            disabled={saving || !folder.trim()}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Guardar
          </button>
        </div>
        {savedDir && (
          <p className="text-[11px] flex items-center gap-1.5 mt-1">
            {dirExists
              ? <><CheckCircle2 className="w-3 h-3 text-emerald-400" /> <span className="text-muted-foreground">Carpeta configurada</span></>
              : <><AlertCircle className="w-3 h-3 text-amber-400" /> <span className="text-amber-300">La carpeta guardada no existe en este equipo</span></>}
          </p>
        )}
      </div>

      {/* Botón escanear */}
      <button
        onClick={scan}
        disabled={scanning || !savedDir}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border border-border bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
        {scanning ? "Escaneando…" : "Escanear ahora"}
      </button>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      {result && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-2">
          <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Escaneo completado
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Stat label="Videos encontrados" value={result.scanned} />
            <Stat label="Nuevos agregados" value={result.added} accent="emerald" />
            <Stat label="Restaurados" value={result.restored} />
            <Stat label="Ya no en disco" value={result.missing} accent={result.missing ? "amber" : undefined} />
          </div>
        </div>
      )}

      {/* Zona de peligro: wipe (solo local + admin) */}
      {showWipeZone && (
        <div className="border border-red-500/30 rounded-xl p-4 space-y-3 mt-6">
          <div>
            <h4 className="text-sm font-semibold text-red-400 flex items-center gap-1.5">
              <Trash2 className="w-4 h-4" /> Zona de peligro
            </h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              Elimina todos los datos locales (videos, estados, plataformas, configuración). Los archivos en disco no se borran.
            </p>
          </div>

          {!wipeConfirm ? (
            <button
              onClick={() => { setWipeConfirm(true); setWipeResult(null); setWipeError(null); }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="w-4 h-4" /> Limpiar app local
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-medium text-red-300">
                ¿Seguro? Esta acción no se puede deshacer.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={wipe}
                  disabled={wiping}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {wiping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  {wiping ? "Limpiando…" : "Sí, limpiar todo"}
                </button>
                <button
                  onClick={() => setWipeConfirm(false)}
                  disabled={wiping}
                  className="px-4 py-2 rounded-lg text-sm border border-border text-muted-foreground hover:bg-secondary/50 transition-colors disabled:opacity-50"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {wipeError && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">{wipeError}</p>
            </div>
          )}

          {wipeResult && (
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2 space-y-1">
              <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Base de datos local limpiada
              </p>
              <div className="flex flex-wrap gap-2 mt-1">
                {Object.entries(wipeResult).map(([col, count]) => (
                  <span key={col} className="text-[11px] bg-secondary/50 rounded px-2 py-0.5 text-muted-foreground">
                    {col}: <span className="text-foreground font-medium">{count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: "emerald" | "amber" }) {
  const color = accent === "emerald" ? "text-emerald-400" : accent === "amber" ? "text-amber-400" : "text-foreground";
  return (
    <div className="bg-secondary/40 rounded-lg px-3 py-2">
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      <p className="text-muted-foreground">{label}</p>
    </div>
  );
}
