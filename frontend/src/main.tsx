import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './hooks/useTheme'
import { AuthProvider } from './hooks/useAuth'
// @ts-ignore: CSS import handled by bundler
import "./styles/index.css";

// Modo mock (?mock=1): intercepta /api/* con MSW para probar la app como
// cualquiera de los 4 tipos de usuario, sin backend real -- ver
// src/mocks/README.md. Solo existe en dev; import() dinámico + el chequeo de
// import.meta.env.DEV hacen que ni el código de mocks entre al bundle de
// `npm run build`.
async function bootstrap() {
  const mockMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("mock") === "1";

  let SwitcherComponent: (() => React.ReactElement) | null = null;
  if (mockMode) {
    const [{ worker }, { MockScenarioSwitcher }] = await Promise.all([
      import("./mocks/browser"),
      import("./mocks/MockScenarioSwitcher"),
    ]);
    await worker.start({ onUnhandledRequest: "bypass" });
    SwitcherComponent = MockScenarioSwitcher;
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <AuthProvider>
          <App />
          {SwitcherComponent && <SwitcherComponent />}
        </AuthProvider>
      </ThemeProvider>
    </StrictMode>,
  )
}

bootstrap();
