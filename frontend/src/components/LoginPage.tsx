import { useState, useEffect, FormEvent } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useAuth } from "../hooks/useAuth";
import { useBackendType } from "../hooks/useBackendType";
import { API_BASE } from "../config";
import logoImg from "../assets/esseAnalytics.png";

async function setLocalOwner() {
  const token = localStorage.getItem("esse_auth_token");
  if (!token) return;
  await fetch(`${API_BASE}/api/local/owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

export function LoginPage({ onBack }: { onBack?: () => void }) {
  const { login } = useAuth();
  const { isLocal, isReady } = useBackendType();

  const [localOwner, setLocalOwner_] = useState<string | null>(null);
  const [ownerChecked, setOwnerChecked] = useState(false);

  const [mode, setMode]         = useState<"login" | "register" | "reset">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [email,    setEmail]    = useState("");
  const [error,    setError]    = useState<string | null>(null);
  const [success,  setSuccess]  = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [accountDeleted, setAccountDeleted] = useState(false);

  // Cambiar de cuenta: desvincula y limpia datos locales SIN tocar la central.
  // La cuenta sigue activa; solo se libera esta instalación.
  const [switchMode, setSwitchMode] = useState(false);
  const [switching, setSwitching]   = useState(false);

  // Flujo de eliminación total (cuenta + datos locales) desde el login.
  // No pide contraseña (por si la olvidaron); confirma escribiendo el usuario.
  const [wipeMode, setWipeMode]       = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState("");
  const [wiping, setWiping]           = useState(false);
  const [wipeError, setWipeError]     = useState<string | null>(null);

  // En local: ver si esta instancia ya está vinculada a una cuenta
  useEffect(() => {
    if (!isReady) return;
    if (!isLocal) { setOwnerChecked(true); return; }
    fetch(`${API_BASE}/api/local/owner`)
      .then(r => r.json())
      .then(d => {
        if (d.username) { setLocalOwner_(d.username); setUsername(d.username); setMode("login"); }
      })
      .catch(() => {})
      .finally(() => setOwnerChecked(true));
  }, [isReady, isLocal]);

  // El registro solo se permite desde el instalable y si la instancia no tiene dueño aún
  const canRegister = isLocal && !localOwner;

  const reset = (next: "login" | "register" | "reset") => {
    setMode(next); setError(null); setSuccess(null);
    setPassword(""); setConfirm(""); setEmail("");
    if (!localOwner) setUsername("");
  };

  const handleReset = async (e: FormEvent) => {
    e.preventDefault();
    setError(null); setSuccess(null);
    if (password !== confirm) { setError("Las contraseñas no coinciden."); return; }
    if (password.length < 6)  { setError("Mínimo 6 caracteres."); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/local-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: (localOwner || username).trim(), newPassword: password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Error al resetear");
      setSuccess("Contraseña actualizada. Ya puedes iniciar sesión.");
      setPassword(""); setConfirm("");
      setTimeout(() => reset("login"), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null); setAccountDeleted(false); setLoading(true);
    try {
      const entered = username.trim();
      // Si entra un usuario DISTINTO al dueño de esta PC → reiniciar lo local ANTES de
      // cargar la app (evita que las vistas muestren datos del dueño anterior). Sus datos
      // vienen de la nube: calendario siempre; catálogo de videos solo si es premium.
      if (isLocal && localOwner && localOwner.toLowerCase() !== entered.toLowerCase()) {
        await fetch(`${API_BASE}/api/local/reset-all`, { method: "POST" }).catch(() => {});
      }
      await login(entered, password);
      if (isLocal) await setLocalOwner();
    } catch (err: any) {
      const msg: string = err.message || '';
      if (msg.includes('dada de baja') || msg.includes('deactivated')) {
        setAccountDeleted(true);
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleUnlink = async () => {
    setLoading(true);
    try {
      await fetch(`${API_BASE}/api/local/owner/reset`, { method: 'POST' });
      setLocalOwner_(null);
      setAccountDeleted(false);
      setError(null);
      setUsername('');
      setMode('register');
    } catch {
      setError('No se pudo desvincular. Intenta reiniciar la app.');
    } finally {
      setLoading(false);
    }
  };

  // Cambiar de cuenta (NO destructivo): borra datos locales y desvincula esta
  // instalación, pero la cuenta sigue activa en la central y se puede volver a usar.
  const handleSwitchAccount = async () => {
    setSwitching(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/local/reset-all`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.message || `No se pudo cambiar de cuenta (HTTP ${res.status}).`);
      }
      localStorage.removeItem("esse_auth_token");
      window.location.reload();
    } catch (err: any) {
      // Antes el error se tragaba y recargaba igual → quedaba bloqueado sin avisar.
      setError(err?.message || "No se pudo cambiar de cuenta. Reinicia la app.");
      setSwitching(false);
    }
  };

  // Elimina la cuenta en la central (revoca canales) + borra datos locales + desvincula.
  // NO requiere contraseña: pensado para cuando el usuario la olvidó y necesita cortar
  // el acceso a los canales. Se confirma escribiendo el nombre de usuario.
  const handleWipeAccount = async (e: FormEvent) => {
    e.preventDefault();
    setWipeError(null);
    const owner = (localOwner || username).trim();
    if (wipeConfirm.trim().toLowerCase() !== owner.toLowerCase()) {
      setWipeError(`Escribe "${owner}" para confirmar.`);
      return;
    }
    setWiping(true);
    try {
      // 1. Dar de baja la cuenta en la central y revocar tokens OAuth (canales).
      //    Va por el proxy del local-backend, que añade la X-Client-Key.
      await fetch(`${API_BASE}/api/auth/local-deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: owner }),
      }).catch(() => {});

      // 2. Borrar todos los datos locales y desvincular la instalación (localhost).
      await fetch(`${API_BASE}/api/local/reset-all`, { method: "POST" }).catch(() => {});

      // 3. Limpiar sesión y recargar en estado inicial.
      localStorage.removeItem("esse_auth_token");
      window.location.reload();
    } catch (err: any) {
      setWipeError(err.message);
      setWiping(false);
    }
  };

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError("Las contraseñas no coinciden."); return; }
    if (password.length < 6)  { setError("La contraseña debe tener al menos 6 caracteres."); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password, ...(email.trim() ? { email: email.trim() } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Error al registrarse");
      await login(username.trim(), password);
      if (isLocal) await setLocalOwner();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-background px-4"
      style={{ fontFamily: "'Inter', sans-serif" }}
    >
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
        className="w-full max-w-sm"
      >
        {/* Volver al landing */}
        {onBack && (
          <div className="mb-6">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ← Volver al inicio
            </button>
          </div>
        )}

        {/* Logo */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <img src={logoImg} alt="EsseAnalytics" className="w-16 h-16 rounded-2xl" />
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, letterSpacing: "-0.03em", fontSize: "1.5rem" }}>
            <span className="text-foreground">Esse</span><span className="text-primary">Analytics</span>
          </span>
          <p className="text-muted-foreground text-sm text-center max-w-[22ch]">
            Gestión y análisis de contenido audiovisual
          </p>
        </div>

        {/* Toggle — solo si se permite registrar */}
        {canRegister && ownerChecked && (
          <div className="flex bg-secondary/50 rounded-xl p-1 mb-4 border border-border">
            {(["login", "register"] as const).map(m => (
              <button
                key={m}
                onClick={() => reset(m)}
                className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "login" ? "Iniciar sesión" : "Crear cuenta"}
              </button>
            ))}
          </div>
        )}

        <AnimatePresence mode="wait">
          <motion.form
            key={mode}
            initial={{ opacity: 0, x: mode === "login" ? -12 : 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: mode === "login" ? 12 : -12 }}
            transition={{ duration: 0.2 }}
            onSubmit={mode === "login" ? handleLogin : mode === "register" ? handleRegister : handleReset}
            className="bg-card border border-border rounded-2xl p-6 space-y-4 shadow-xl"
          >
            {/* Reset mode header */}
            {mode === "reset" && (
              <div className="text-center -mt-1 mb-1">
                <p className="text-sm font-semibold text-foreground">Restablecer contraseña</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {localOwner
                    ? <>Para la cuenta <span className="text-foreground font-medium">{localOwner}</span></>
                    : "Introduce tu usuario y la nueva contraseña"}
                </p>
              </div>
            )}

            {localOwner && mode !== "reset" && (
              <p className="text-[11px] text-muted-foreground text-center -mt-1 mb-1">
                Vinculada a <span className="text-foreground font-medium">{localOwner}</span>. Si inicias con otra cuenta,
                los datos locales de esta PC se reiniciarán y se cargarán los de esa cuenta desde la nube.
              </p>
            )}

            {/* Username — editable (permite iniciar con otra cuenta); oculto en reset si ya se conoce el dueño */}
            {!(mode === "reset" && localOwner) && (
              <Field label="Usuario" value={username} onChange={setUsername} placeholder="Ej: micanal" autoFocus disabled={false} />
            )}

            {mode === "register" && (
              <Field label="Email (opcional)" value={email} onChange={setEmail} type="email" placeholder="tu@email.com" />
            )}

            {mode !== "register" && (
              <Field
                label={mode === "reset" ? "Nueva contraseña" : "Contraseña"}
                value={password} onChange={setPassword} type="password" placeholder="••••••••"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                autoFocus={mode === "reset"}
              />
            )}

            {mode === "register" && (
              <Field label="Contraseña" value={password} onChange={setPassword} type="password" placeholder="••••••••" autoComplete="new-password" />
            )}

            {(mode === "register" || mode === "reset") && (
              <Field label="Confirmar contraseña" value={confirm} onChange={setConfirm} type="password" placeholder="••••••••" autoComplete="new-password" />
            )}

            {error && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
              >
                {error}
              </motion.p>
            )}

            {success && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2"
              >
                {success}
              </motion.p>
            )}

            {/* Banner cuenta dada de baja — solo en local */}
            {accountDeleted && isLocal && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 space-y-2"
              >
                <p className="text-xs text-amber-400 font-medium">Esta cuenta fue dada de baja.</p>
                <p className="text-[11px] text-muted-foreground">Puedes desvincular esta instalación y crear una cuenta nueva.</p>
                <button
                  type="button"
                  onClick={handleUnlink}
                  disabled={loading}
                  className="w-full text-xs py-1.5 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                >
                  Desvincular instalación y crear cuenta nueva
                </button>
              </motion.div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary text-primary-foreground py-2.5 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mt-2"
            >
              {loading
                ? "..."
                : mode === "login"    ? "Entrar"
                : mode === "register" ? "Crear cuenta y entrar"
                :                       "Cambiar contraseña"}
            </button>

            {/* Olvidé mi contraseña — solo en local y en modo login */}
            {isLocal && mode === "login" && (
              <button
                type="button"
                onClick={() => reset("reset")}
                className="w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors text-center"
              >
                ¿Olvidaste tu contraseña?
              </button>
            )}

            {/* Cambiar de cuenta (no destructivo) — solo en local, vinculada */}
            {isLocal && localOwner && mode === "login" && !wipeMode && !switchMode && (
              <button
                type="button"
                onClick={() => setSwitchMode(true)}
                className="w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors text-center"
              >
                Usar otra cuenta
              </button>
            )}

            {/* Volver desde reset */}
            {mode === "reset" && (
              <button
                type="button"
                onClick={() => reset("login")}
                className="w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors text-center"
              >
                ← Volver al inicio de sesión
              </button>
            )}

            {mode === "register" && (
              <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                Tu cuenta será <span className="text-foreground font-medium">gratuita</span> por defecto.
                Esta instalación quedará vinculada a esta cuenta.
              </p>
            )}

            {!canRegister && !isLocal && ownerChecked && (
              <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                Para crear una cuenta, instala y abre la aplicación de escritorio.
              </p>
            )}
          </motion.form>
        </AnimatePresence>

        {/* Panel "usar otra cuenta" — cambio de usuario no destructivo */}
        {isLocal && localOwner && switchMode && !wipeMode && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 rounded-2xl border border-border bg-card p-5 space-y-3"
          >
            <div>
              <p className="text-sm font-semibold text-foreground">Usar otra cuenta</p>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                Se cerrará la sesión y se liberará esta instalación para vincular otra cuenta.
                La cuenta <span className="text-foreground font-medium">{localOwner}</span> seguirá
                activa y podrás volver a entrar cuando quieras. Se borrarán los datos locales
                (biblioteca, calendario) de esta máquina.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={switching}
                onClick={handleSwitchAccount}
                className="flex-1 bg-primary text-primary-foreground py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60"
              >
                {switching ? "Cambiando..." : "Continuar"}
              </button>
              <button
                type="button"
                disabled={switching}
                onClick={() => setSwitchMode(false)}
                className="px-4 py-2 rounded-lg bg-card border border-border text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-60"
              >
                Cancelar
              </button>
            </div>

            {/* Opción destructiva, secundaria y separada */}
            <div className="pt-2 border-t border-border">
              <button
                type="button"
                onClick={() => { setSwitchMode(false); setWipeMode(true); setWipeError(null); setWipeConfirm(""); }}
                className="w-full text-[11px] text-red-400/70 hover:text-red-400 transition-colors text-center"
              >
                O eliminar la cuenta permanentemente
              </button>
            </div>
          </motion.div>
        )}

        {/* Panel de eliminación total — fuera del form para no disparar el login */}
        {isLocal && localOwner && wipeMode && (
          <motion.form
            onSubmit={handleWipeAccount}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 rounded-2xl border border-red-500/30 bg-red-500/5 p-5 space-y-3"
          >
            <div>
              <p className="text-sm font-semibold text-foreground">Eliminar cuenta y reiniciar app</p>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                Esto dará de baja la cuenta <span className="text-foreground font-medium">{localOwner}</span>,
                <span className="text-red-400 font-medium"> revocará el acceso a tus canales</span> (YouTube,
                Instagram, TikTok) y borrará todos los datos locales (biblioteca, videos, configuración).
                No se puede deshacer.
              </p>
            </div>

            <Field
              label={`Escribe "${localOwner}" para confirmar`}
              value={wipeConfirm}
              onChange={setWipeConfirm}
              type="text"
              placeholder={localOwner ?? ""}
              autoComplete="off"
            />

            {wipeError && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {wipeError}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={wiping}
                className="flex-1 bg-red-500 text-white py-2 rounded-lg text-sm font-semibold hover:bg-red-600 transition-colors disabled:opacity-60"
              >
                {wiping ? "Eliminando..." : "Eliminar todo"}
              </button>
              <button
                type="button"
                disabled={wiping}
                onClick={() => { setWipeMode(false); setWipeConfirm(""); setWipeError(null); }}
                className="px-4 py-2 rounded-lg bg-card border border-border text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-60"
              >
                Cancelar
              </button>
            </div>
          </motion.form>
        )}

        <p className="text-center text-[10px] text-muted-foreground/40 font-mono mt-6">
          v{__APP_VERSION__}
        </p>
      </motion.div>
    </div>
  );
}

function Field({
  label, value, onChange, type = "text", placeholder, autoFocus, autoComplete, disabled,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; autoFocus?: boolean; autoComplete?: string; disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        disabled={disabled}
        required
        className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2.5 text-base text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/60 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      />
    </div>
  );
}
