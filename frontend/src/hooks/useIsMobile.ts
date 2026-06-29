import { useEffect, useState } from "react";

// Detecta viewport de teléfono (coincide con el breakpoint `sm` de Tailwind: 640px).
// Reactivo a rotación / resize. SSR-safe (asume desktop si no hay window).
const MOBILE_QUERY = "(max-width: 639px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia(MOBILE_QUERY).matches : false
  );

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    setIsMobile(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
