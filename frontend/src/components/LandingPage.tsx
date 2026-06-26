import { useState } from "react";
import { motion } from "motion/react";
import {
  Film, BarChart2, Wrench, LogIn, CalendarClock, Share2,
  LineChart, Languages, ArrowRight, ShieldCheck, Download, Monitor, Apple,
} from "lucide-react";
import logoImg from "../assets/esseAnalytics.png";

// ── URLs de descarga — actualiza estas constantes cuando subas los archivos ──
const DOWNLOADS = {
  windows: "https://github.com/gessex22/esse-analytics/releases/download/v1.0.19/EsseAnalytics.Setup.1.0.19.exe",
  macArm:  "https://github.com/gessex22/esse-analytics/releases/download/v1.0.19/EsseAnalytics-1.0.19-arm64.dmg",
  macX64:  "https://github.com/gessex22/esse-analytics/releases/download/v1.0.19/EsseAnalytics-1.0.19.dmg",
};

// ── Iconos de plataforma ──────────────────────────────────────────────────────
function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
    </svg>
  );
}
function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/>
    </svg>
  );
}
function TiktokIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.32 6.32 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.76a4.85 4.85 0 0 1-1.01-.07z"/>
    </svg>
  );
}

// ── Textos ES / EN ────────────────────────────────────────────────────────────
type Lang = "es" | "en";

const T = {
  es: {
    login: "Iniciar sesión",
    heroTitle1: "Publica tu contenido en",
    heroTitle2: "todas tus redes",
    heroSub: "Conecta tus cuentas, organiza tus videos y publícalos en TikTok, YouTube e Instagram desde un solo panel. Después compara cómo rinde el mismo contenido en cada plataforma.",
    heroCta: "Comenzar",
    platformsTitle: "Una plataforma, todas tus redes",
    featuresTitle: "Todo lo que necesitas para crecer",
    features: [
      { icon: Film, title: "Biblioteca de contenido", desc: "Organiza, previsualiza y gestiona todos tus videos en un solo lugar, con transcripciones automáticas." },
      { icon: Share2, title: "Publicación multiplataforma", desc: "Sube tus videos a TikTok, YouTube e Instagram directamente, con título, privacidad y miniatura personalizada." },
      { icon: CalendarClock, title: "Calendario editorial", desc: "Planifica y programa tus publicaciones para mantener una presencia constante en cada red." },
      { icon: BarChart2, title: "Analíticas unificadas", desc: "Compara vistas, likes y comentarios del mismo video en cada plataforma desde un único tablero." },
      { icon: Wrench, title: "Taller de versiones", desc: "Gestiona borradores, guiones y distintas versiones de cada pieza antes de publicar." },
      { icon: ShieldCheck, title: "Tus cuentas, bajo tu control", desc: "Conectas tus propias cuentas vía login oficial y revocas el acceso cuando quieras." },
    ],
    howTitle: "Cómo funciona",
    steps: [
      { n: "1", title: "Conecta tus cuentas", desc: "Vincula tus perfiles de TikTok, YouTube e Instagram de forma segura con el login oficial de cada plataforma." },
      { n: "2", title: "Elige y prepara tu video", desc: "Selecciona un video de tu biblioteca, escribe el título, define la privacidad y elige la portada." },
      { n: "3", title: "Publica y mide", desc: "Publica con un clic y sigue el rendimiento de tu contenido en todas las redes desde un solo lugar." },
    ],
    dlTitle: "Descarga la app de escritorio",
    dlSub: "Gestiona tus videos localmente, sin subir nada a la nube. Gratis.",
    dlWin: "Windows",
    dlWinSub: "Windows 10 / 11 — x64",
    dlMac: "macOS",
    dlMacArm: "Apple Silicon (M1/M2/M3)",
    dlMacX64: "Mac Intel (x64)",
    dlFree: "Gratis · Sin cuenta requerida",
    ctaTitle: "Lleva tu contenido más lejos",
    ctaSub: "Empieza a gestionar y publicar en todas tus redes desde un solo panel.",
    ctaBtn: "Acceder a la plataforma",
    footerTagline: "La plataforma para creadores que publican en todas partes.",
    terms: "Términos de servicio",
    privacy: "Política de privacidad",
    contact: "Contacto",
    rights: "Todos los derechos reservados.",
  },
  en: {
    login: "Log in",
    heroTitle1: "Publish your content to",
    heroTitle2: "all your platforms",
    heroSub: "Connect your accounts, organize your videos and publish them to TikTok, YouTube and Instagram from a single dashboard. Then compare how the same content performs on each platform.",
    heroCta: "Get started",
    platformsTitle: "One platform, all your networks",
    featuresTitle: "Everything you need to grow",
    features: [
      { icon: Film, title: "Content library", desc: "Organize, preview and manage all your videos in one place, with automatic transcriptions." },
      { icon: Share2, title: "Cross-platform publishing", desc: "Publish your videos to TikTok, YouTube and Instagram directly, with title, privacy and custom cover." },
      { icon: CalendarClock, title: "Editorial calendar", desc: "Plan and schedule your posts to keep a consistent presence across every network." },
      { icon: BarChart2, title: "Unified analytics", desc: "Compare views, likes and comments of the same video across platforms from a single dashboard." },
      { icon: Wrench, title: "Version workshop", desc: "Manage drafts, scripts and different versions of each piece before publishing." },
      { icon: ShieldCheck, title: "Your accounts, your control", desc: "Connect your own accounts via official login and revoke access whenever you want." },
    ],
    howTitle: "How it works",
    steps: [
      { n: "1", title: "Connect your accounts", desc: "Securely link your TikTok, YouTube and Instagram profiles using each platform's official login." },
      { n: "2", title: "Pick and prepare your video", desc: "Choose a video from your library, write the title, set the privacy and pick the cover frame." },
      { n: "3", title: "Publish and measure", desc: "Publish with one click and track your content's performance across networks from one place." },
    ],
    dlTitle: "Download the desktop app",
    dlSub: "Manage your videos locally, without uploading anything to the cloud. Free.",
    dlWin: "Windows",
    dlWinSub: "Windows 10 / 11 — x64",
    dlMac: "macOS",
    dlMacArm: "Apple Silicon (M1/M2/M3)",
    dlMacX64: "Mac Intel (x64)",
    dlFree: "Free · No account required",
    ctaTitle: "Take your content further",
    ctaSub: "Start managing and publishing across all your networks from a single dashboard.",
    ctaBtn: "Enter the platform",
    footerTagline: "The platform for creators who publish everywhere.",
    terms: "Terms of Service",
    privacy: "Privacy Policy",
    contact: "Contact",
    rights: "All rights reserved.",
  },
} satisfies Record<Lang, any>;

const PLATFORMS = [
  { Icon: TiktokIcon,    label: "TikTok",    color: "text-foreground" },
  { Icon: YoutubeIcon,   label: "YouTube",   color: "text-red-500" },
  { Icon: InstagramIcon, label: "Instagram", color: "text-pink-500" },
];

interface LandingPageProps {
  onLogin: () => void;
}

export function LandingPage({ onLogin }: LandingPageProps) {
  const [lang, setLang] = useState<Lang>(
    typeof navigator !== "undefined" && navigator.language.startsWith("en") ? "en" : "es"
  );
  const t = T[lang];

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground" style={{ fontFamily: "'Inter', sans-serif" }}>

      {/* Header */}
      <header className="flex items-center justify-between px-5 sm:px-8 py-4 border-b border-border sticky top-0 bg-background/90 backdrop-blur z-20">
        <div className="flex items-center gap-2.5">
          <img src={logoImg} alt="EsseAnalytics" className="w-8 h-8 rounded-lg" />
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, letterSpacing: "-0.02em", fontSize: "1rem" }}>
            <span className="text-foreground">Esse</span><span className="text-primary">Analytics</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLang(lang === "es" ? "en" : "es")}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title={lang === "es" ? "Switch to English" : "Cambiar a Español"}
          >
            <Languages className="w-4 h-4" />
            <span className="font-medium uppercase">{lang === "es" ? "EN" : "ES"}</span>
          </button>
          <a
            href="#download"
            className="hidden sm:flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <Download className="w-4 h-4" />
            {lang === "es" ? "Descargar" : "Download"}
          </a>
          <button
            onClick={onLogin}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            <LogIn className="w-4 h-4" />
            <span className="hidden sm:inline">{t.login}</span>
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="flex flex-col items-center justify-center px-6 pt-20 pb-16 text-center">
        <motion.div
          initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
          className="max-w-3xl"
        >
          <img src={logoImg} alt="EsseAnalytics" className="w-20 h-20 rounded-2xl mx-auto mb-8 shadow-2xl" />
          <h1 className="text-4xl sm:text-6xl font-bold mb-5 leading-[1.05]" style={{ fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "-0.03em" }}>
            {t.heroTitle1}{" "}<span className="text-primary">{t.heroTitle2}</span>
          </h1>
          <p className="text-muted-foreground text-lg sm:text-xl leading-relaxed mb-10 max-w-2xl mx-auto">
            {t.heroSub}
          </p>
          <button
            onClick={onLogin}
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-8 py-3.5 rounded-xl text-base font-semibold hover:bg-primary/90 transition-colors shadow-lg"
          >
            {t.heroCta} <ArrowRight className="w-5 h-5" />
          </button>
        </motion.div>

        {/* Plataformas */}
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3, duration: 0.5 }}
          className="mt-16 w-full max-w-2xl"
        >
          <p className="text-xs uppercase tracking-widest text-muted-foreground/60 mb-5">{t.platformsTitle}</p>
          <div className="flex items-center justify-center gap-8 sm:gap-14">
            {PLATFORMS.map(({ Icon, label, color }) => (
              <div key={label} className="flex flex-col items-center gap-2">
                <Icon className={`w-9 h-9 ${color}`} />
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </motion.div>
      </section>

      {/* Features */}
      <section className="px-6 py-16 border-t border-border">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-center mb-12" style={{ fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "-0.02em" }}>
            {t.featuresTitle}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {t.features.map(({ icon: Icon, title, desc }: any) => (
              <div key={title} className="bg-card border border-border rounded-xl p-6 text-left hover:border-primary/30 transition-colors">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                  <Icon className="w-5 h-5 text-primary" />
                </div>
                <h3 className="text-base font-semibold text-foreground mb-1.5">{title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Cómo funciona */}
      <section className="px-6 py-16 border-t border-border bg-card/30">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-center mb-12" style={{ fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "-0.02em" }}>
            {t.howTitle}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {t.steps.map(({ n, title, desc }: any) => (
              <div key={n} className="text-center">
                <div className="w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center mx-auto mb-4 text-lg font-bold" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                  {n}
                </div>
                <h3 className="text-base font-semibold text-foreground mb-2">{title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Descarga */}
      <section id="download" className="px-6 py-20 border-t border-border bg-card/30">
        <div className="max-w-3xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.45 }}
          >
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-5">
              <Download className="w-6 h-6 text-primary" />
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold mb-3" style={{ fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "-0.02em" }}>
              {t.dlTitle}
            </h2>
            <p className="text-muted-foreground text-base mb-10">{t.dlSub}</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-left">

              {/* Windows */}
              <a
                href={DOWNLOADS.windows}
                className="group flex flex-col gap-4 rounded-xl border border-border bg-card p-6 hover:border-primary/40 hover:bg-card/80 transition-all"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-sky-500/10 flex items-center justify-center flex-shrink-0">
                    <Monitor className="w-5 h-5 text-sky-400" />
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">{t.dlWin}</p>
                    <p className="text-xs text-muted-foreground">{t.dlWinSub}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-auto">
                  <span className="text-xs text-muted-foreground font-mono">.exe · ~85 MB</span>
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary group-hover:gap-2.5 transition-all">
                    <Download className="w-3.5 h-3.5" />
                    Descargar
                  </span>
                </div>
              </a>

              {/* macOS */}
              <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-6">
                <div className="flex items-center gap-3 mb-1">
                  <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center flex-shrink-0">
                    <Apple className="w-5 h-5 text-purple-400" />
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">{t.dlMac}</p>
                    <p className="text-xs text-muted-foreground">.dmg · ~110 MB</p>
                  </div>
                </div>
                <a
                  href={DOWNLOADS.macArm}
                  className="group flex items-center justify-between rounded-lg border border-border bg-secondary/50 px-4 py-2.5 hover:border-primary/30 hover:bg-secondary transition-colors"
                >
                  <span className="text-sm text-foreground">{t.dlMacArm}</span>
                  <span className="inline-flex items-center gap-1 text-xs text-primary font-semibold group-hover:gap-1.5 transition-all">
                    <Download className="w-3.5 h-3.5" /> arm64
                  </span>
                </a>
                <a
                  href={DOWNLOADS.macX64}
                  className="group flex items-center justify-between rounded-lg border border-border bg-secondary/50 px-4 py-2.5 hover:border-primary/30 hover:bg-secondary transition-colors"
                >
                  <span className="text-sm text-foreground">{t.dlMacX64}</span>
                  <span className="inline-flex items-center gap-1 text-xs text-primary font-semibold group-hover:gap-1.5 transition-all">
                    <Download className="w-3.5 h-3.5" /> x64
                  </span>
                </a>
              </div>

            </div>

            <p className="text-xs text-muted-foreground mt-6">{t.dlFree}</p>
          </motion.div>
        </div>
      </section>

      {/* Analíticas highlight */}
      <section className="px-6 py-16 border-t border-border">
        <div className="max-w-3xl mx-auto text-center">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-5">
            <LineChart className="w-6 h-6 text-primary" />
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold mb-4" style={{ fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "-0.02em" }}>
            {lang === "es" ? "Un mismo video, todas sus métricas" : "One video, all its metrics"}
          </h2>
          <p className="text-muted-foreground text-base sm:text-lg leading-relaxed">
            {lang === "es"
              ? "Cuando publicas el mismo video en varias plataformas, EsseAnalytics lo vincula automáticamente para que puedas comparar su rendimiento lado a lado y entender qué red funciona mejor para cada tipo de contenido."
              : "When you publish the same video across platforms, EsseAnalytics links it automatically so you can compare performance side by side and understand which network works best for each type of content."}
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 py-20 border-t border-border bg-card/30">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4" style={{ fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "-0.02em" }}>
            {t.ctaTitle}
          </h2>
          <p className="text-muted-foreground text-lg mb-8">{t.ctaSub}</p>
          <button
            onClick={onLogin}
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-8 py-3.5 rounded-xl text-base font-semibold hover:bg-primary/90 transition-colors shadow-lg"
          >
            <LogIn className="w-5 h-5" /> {t.ctaBtn}
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-6 py-10 border-t border-border">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex flex-col items-center sm:items-start gap-2">
            <div className="flex items-center gap-2.5">
              <img src={logoImg} alt="EsseAnalytics" className="w-7 h-7 rounded-md" />
              <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, letterSpacing: "-0.02em" }}>
                <span className="text-foreground">Esse</span><span className="text-primary">Analytics</span>
              </span>
            </div>
            <p className="text-xs text-muted-foreground max-w-xs text-center sm:text-left">{t.footerTagline}</p>
          </div>
          <div className="flex items-center gap-5 text-sm">
            <a href="/terms/" className="text-muted-foreground hover:text-foreground transition-colors">{t.terms}</a>
            <a href="/privacy/" className="text-muted-foreground hover:text-foreground transition-colors">{t.privacy}</a>
            <a href="mailto:gesse.socialmedia@gmail.com" className="text-muted-foreground hover:text-foreground transition-colors">{t.contact}</a>
          </div>
        </div>
        <p className="text-center text-xs text-muted-foreground/60 mt-8">
          © 2026 EsseAnalytics. {t.rights} &nbsp;·&nbsp; <span className="font-mono">v{__APP_VERSION__}</span>
        </p>
      </footer>
    </div>
  );
}
