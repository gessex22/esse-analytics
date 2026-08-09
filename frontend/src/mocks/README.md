# Modo mock (MSW) — probar la app como los 4 tipos de usuario

Intercepta toda la red `/api/*` en el navegador con [MSW](https://mswjs.io/)
sin tocar `services/api.ts` ni ningún componente. Sirve para ver la UI real
como la vería cada tipo de usuario, sin `local-backend` ni central corriendo.

## Cómo usarlo

```bash
cd frontend
npm run dev
```

Abrí `http://localhost:5173/?mock=1`. Aparece un panel flotante 🎭 abajo a la
derecha con los 4 escenarios — tocar uno te loguea directo como ese perfil
(sin pasar por el form de login) y recarga. Solo funciona en dev
(`import.meta.env.DEV`); nunca se activa ni se bundlea en `npm run build`.

## Escenarios (`scenarios.ts`)

| Escenario | Rol | Tier | isOwner | Cloud | Local |
|---|---|---|---|---|---|
| `owner` | todopoderoso | premium | sí | sí | sí |
| `editor_free` | editor | free | no | no | sí |
| `editor_premium_cloud` | editor | premium | no | sí | sí |
| `remote_free` | editor | free | no | no | **no** (dispara el paywall de `RemoteGate`) |

## Cómo funciona por dentro

- `scenarios.ts` — define los 4 perfiles + `buildMockToken()` (arma un JWT
  con 3 partes válidas en base64 pero SIN firma real — alcanza porque
  `decodeJwtUser()` en `useAuth.tsx` nunca la verifica, solo hace `atob()`).
- `scenarioStore.ts` — persiste cuál está activo en `localStorage`
  (`esse_mock_scenario`), lo leen los handlers.
- `fixtures.ts` — datos de contenido (videos, stats, calendario, usuarios)
  compartidos entre escenarios — el contenido no cambia, solo el acceso.
- `handlers.ts` — un handler MSW por endpoint real que la app llama (ver
  `services/api.ts`); los 4 primeros (`auth/login`, `auth/me`,
  `local/session`, `local/health`) son los que de verdad deciden qué ve cada
  escenario. Al final hay un catch-all que devuelve `{}`/`{ok:true}` para
  cualquier endpoint que no se haya mockeado explícitamente, así nada rompe
  aunque falte cubrir algo nuevo.
- `browser.ts` — `setupWorker(...handlers)`, arrancado desde `main.tsx`.
- `MockScenarioSwitcher.tsx` — el panel flotante.

## Agregar un escenario nuevo

Sumalo a `SCENARIOS` en `scenarios.ts` — no hace falta tocar nada más, el
switcher y los handlers ya lo levantan solos.

## Si agregás un endpoint nuevo a `services/api.ts`

El catch-all de `handlers.ts` evita que rompa, pero va a devolver `{}` (o
`{ok:true}` en mutaciones) — si la vista nueva necesita datos con forma
específica para verse bien, agregale un handler explícito arriba del
catch-all + su fixture en `fixtures.ts`.
