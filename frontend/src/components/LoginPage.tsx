import { useState, FormEvent } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useAuth } from "../hooks/useAuth";
import { API_BASE } from "../config";
import logoImg from "../assets/esseAnalytics.png";

export function LoginPage() {
  const { login } = useAuth();
  const [mode, setMode]         = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [email,    setEmail]    = useState("");
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [done,     setDone]     = useState(false);

  const reset = (next: "login" | "register") => {
    setMode(next); setError(null); setDone(false);
    setUsername(""); setPassword(""); setConfirm(""); setEmail("");
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null); setLoading(true);
    try {
      await login(username.trim(), password);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
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
      // Auto-login after register
      await login(username.trim(), password);
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

        {/* Toggle */}
        <div className="flex bg-secondary/50 rounded-xl p-1 mb-4 border border-border">
          {(["login", "register"] as const).map(m => (
            <button
              key={m}
              onClick={() => reset(m)}
              className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                mode === m
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {m === "login" ? "Iniciar sesión" : "Crear cuenta"}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.form
            key={mode}
            initial={{ opacity: 0, x: mode === "login" ? -12 : 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: mode === "login" ? 12 : -12 }}
            transition={{ duration: 0.2 }}
            onSubmit={mode === "login" ? handleLogin : handleRegister}
            className="bg-card border border-border rounded-2xl p-6 space-y-4 shadow-xl"
          >
            <Field label="Usuario" value={username} onChange={setUsername} placeholder="Ej: micanal" autoFocus />

            {mode === "register" && (
              <Field label="Email (opcional)" value={email} onChange={setEmail} type="email" placeholder="tu@email.com" />
            )}

            <Field label="Contraseña" value={password} onChange={setPassword} type="password" placeholder="••••••••" autoComplete={mode === "login" ? "current-password" : "new-password"} />

            {mode === "register" && (
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

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary text-primary-foreground py-2.5 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed mt-2"
            >
              {loading
                ? (mode === "login" ? "Verificando..." : "Creando cuenta...")
                : (mode === "login" ? "Entrar" : "Crear cuenta y entrar")}
            </button>

            {mode === "register" && (
              <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                Al registrarte aceptas usar este servicio para gestionar tu propio contenido.
                Tu cuenta será <span className="text-foreground font-medium">gratuita</span> por defecto.
              </p>
            )}
          </motion.form>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

function Field({
  label, value, onChange, type = "text", placeholder, autoFocus, autoComplete,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; autoFocus?: boolean; autoComplete?: string;
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
        required
        className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2.5 text-base text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/60 transition-colors"
      />
    </div>
  );
}
