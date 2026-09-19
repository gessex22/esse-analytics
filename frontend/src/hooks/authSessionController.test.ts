// Pruebas de la carrera de sesión (P0): una respuesta tardía de bootstrap
// (/auth/me o /api/local/session) iniciada bajo una credencial vieja nunca
// debe pisar un login/logout más nuevo. Y del manejo global de 401. Regla de
// limpieza: la sesión se cierra solo si /auth/me confirma con 401/403 O si el
// JWT es localmente inservible (vencido/indecodificable, sin necesidad de
// red). Con un token aún vigente, red caída, 5xx, un 200 o un 401 de OAuth de
// plataforma NUNCA la cierran. Deterministas: cada fetch se resuelve/rechaza a
// mano, en el orden que arma cada test -- sin timers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthSessionController, decodeJwtUser, type AuthStorage, type AuthUser } from "./authSessionController";
import { notifyUnauthorized, onUnauthorized } from "../services/sessionSignal";

const STORAGE_KEY = "esse_auth_token";

function makeToken(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

function createFakeStorage(): AuthStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

// fetch falso: cada llamada queda "en espera" hasta que el test la resuelve
// o rechaza explícitamente por URL, en el orden que el test decide.
function createFakeFetch() {
  const pending = new Map<string, { resolve: (r: FakeResponse) => void; reject: (e: unknown) => void }[]>();
  const calls: string[] = [];
  const fetchImpl = ((url: string | URL) => {
    return new Promise<FakeResponse>((resolve, reject) => {
      const key = String(url);
      calls.push(key);
      const arr = pending.get(key) ?? [];
      arr.push({ resolve, reject });
      pending.set(key, arr);
    });
  }) as unknown as typeof fetch;

  function takeNext(urlSubstr: string) {
    for (const [key, arr] of pending) {
      if (key.includes(urlSubstr) && arr.length) {
        const entry = arr.shift()!;
        if (!arr.length) pending.delete(key);
        return entry;
      }
    }
    throw new Error(`No hay fetch pendiente para ${urlSubstr}`);
  }

  return {
    fetchImpl,
    resolveNext(urlSubstr: string, ok: boolean, body: unknown) {
      takeNext(urlSubstr).resolve({ ok, status: ok ? 200 : 500, json: async () => body });
    },
    // Igual que resolveNext pero eligiendo el status exacto: la diferencia
    // entre 401/403 (cierra sesión) y 5xx (la conserva) es justo lo que
    // prueban varios tests de abajo.
    resolveStatus(urlSubstr: string, status: number, body: unknown = {}) {
      takeNext(urlSubstr).resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
    },
    rejectNext(urlSubstr: string, err: unknown) {
      takeNext(urlSubstr).reject(err);
    },
    callsTo(urlSubstr: string): number {
      return calls.filter((url) => url.includes(urlSubstr)).length;
    },
  };
}

function userA(): AuthUser {
  return { username: "a", role: "editor", tier: "free", isOwner: false, hasCloudStorage: false };
}
function userB(): AuthUser {
  return { username: "b", role: "editor", tier: "free", isOwner: false, hasCloudStorage: false };
}

test("login B sobrevive al rechazo tardío de /auth/me de la sesión A", async () => {
  const storage = createFakeStorage();
  const tokenA = makeToken({ username: "a", role: "editor" });
  storage.setItem(STORAGE_KEY, tokenA);
  const { fetchImpl, resolveNext, rejectNext } = createFakeFetch();
  const controller = new AuthSessionController({
    apiBase: "", storageKey: STORAGE_KEY, fetchImpl, storage, decodeJwtUser, applyUserTheme: () => {},
  });

  const bootstrapPromise = controller.bootstrap(); // dispara /api/auth/me para A, queda en vuelo

  const tokenB = makeToken({ username: "b", role: "editor" });
  const loginPromise = controller.login("b", "pw"); // login B arranca mientras A sigue en vuelo
  resolveNext("/api/auth/login", true, { token: tokenB, user: userB() });
  await loginPromise;

  assert.equal(controller.getState().user?.username, "b");
  assert.equal(controller.getState().token, tokenB);

  rejectNext("/api/auth/me", new Error("network tardío de A"));
  await bootstrapPromise;

  assert.equal(controller.getState().user?.username, "b", "el rechazo tardío de A no debe pisar a B");
  assert.equal(controller.getState().token, tokenB);
  assert.equal(storage.getItem(STORAGE_KEY), tokenB, "no debe borrarse la credencial B vigente");
});

test("login B sobrevive a una respuesta tardía de /api/local/session", async () => {
  const storage = createFakeStorage(); // sin token guardado
  const { fetchImpl, resolveNext } = createFakeFetch();
  const controller = new AuthSessionController({
    apiBase: "", storageKey: STORAGE_KEY, fetchImpl, storage, decodeJwtUser, applyUserTheme: () => {},
  });

  const bootstrapPromise = controller.bootstrap(); // dispara /api/local/session, queda en vuelo

  const tokenB = makeToken({ username: "b", role: "editor" });
  const loginPromise = controller.login("b", "pw");
  resolveNext("/api/auth/login", true, { token: tokenB, user: userB() });
  await loginPromise;

  const tokenLocalViejo = makeToken({ username: "viejo-en-lan", role: "editor" });
  resolveNext("/api/local/session", true, { token: tokenLocalViejo });
  await bootstrapPromise;

  assert.equal(controller.getState().user?.username, "b", "la sesión local tardía no debe pisar a B");
  assert.equal(controller.getState().token, tokenB);
  assert.equal(storage.getItem(STORAGE_KEY), tokenB);
});

// Nota: este test antes rechazaba el fetch (error de red) para simular la
// credencial inválida. Con un token aún vigente la red caída ya no confirma
// nada y conserva la sesión (ver "bootstrap con un token vigente conserva la
// sesión..."), así que la invalidación se expresa como lo que realmente la
// confirma: un 401 de la central.
test("un /auth/me fallido para la sesión aún vigente sí la invalida", async () => {
  const storage = createFakeStorage();
  const tokenA = makeToken({ username: "a", role: "editor" });
  storage.setItem(STORAGE_KEY, tokenA);
  const { fetchImpl, resolveStatus } = createFakeFetch();
  const controller = new AuthSessionController({
    apiBase: "", storageKey: STORAGE_KEY, fetchImpl, storage, decodeJwtUser, applyUserTheme: () => {},
  });

  const bootstrapPromise = controller.bootstrap();
  resolveStatus("/api/auth/me", 401, { error: "token inválido" });
  await bootstrapPromise;

  assert.equal(controller.getState().user, null);
  assert.equal(controller.getState().token, null);
  assert.equal(storage.getItem(STORAGE_KEY), null, "sí debe limpiar la credencial cuando nada más cambió");
});

test("un bootstrap vigente exitoso restaura y actualiza el estado", async () => {
  // (d1) /auth/me exitoso actualiza el usuario (ej. tier)
  {
    const storage = createFakeStorage();
    const tokenA = makeToken({ username: "a", role: "editor" });
    storage.setItem(STORAGE_KEY, tokenA);
    const { fetchImpl, resolveNext } = createFakeFetch();
    const controller = new AuthSessionController({
      apiBase: "", storageKey: STORAGE_KEY, fetchImpl, storage, decodeJwtUser, applyUserTheme: () => {},
    });

    const bootstrapPromise = controller.bootstrap();
    resolveNext("/api/auth/me", true, { user: { ...userA(), tier: "premium" } });
    await bootstrapPromise;

    assert.equal(controller.getState().user?.tier, "premium");
    assert.equal(controller.getState().token, tokenA);
  }

  // (d2) /api/local/session exitoso restaura sesión cuando no hay token guardado
  {
    const storage = createFakeStorage();
    const { fetchImpl, resolveNext } = createFakeFetch();
    const controller = new AuthSessionController({
      apiBase: "", storageKey: STORAGE_KEY, fetchImpl, storage, decodeJwtUser, applyUserTheme: () => {},
    });

    const tokenLocal = makeToken({ username: "local-device", role: "editor" });
    const bootstrapPromise = controller.bootstrap();
    resolveNext("/api/local/session", true, { token: tokenLocal });
    await bootstrapPromise;

    assert.equal(controller.getState().user?.username, "local-device");
    assert.equal(controller.getState().token, tokenLocal);
    assert.equal(storage.getItem(STORAGE_KEY), tokenLocal);
  }
});

test("logout invalida un /auth/me exitoso que llega tarde", async () => {
  const storage = createFakeStorage();
  const tokenA = makeToken({ username: "a", role: "editor" });
  storage.setItem(STORAGE_KEY, tokenA);
  const { fetchImpl, resolveNext } = createFakeFetch();
  const controller = new AuthSessionController({
    apiBase: "", storageKey: STORAGE_KEY, fetchImpl, storage, decodeJwtUser, applyUserTheme: () => {},
  });

  const bootstrapPromise = controller.bootstrap(); // dispara /api/auth/me, queda en vuelo
  controller.logout(); // el usuario cierra sesión mientras A sigue en vuelo

  resolveNext("/api/auth/me", true, { user: userA() });
  await bootstrapPromise;

  assert.equal(controller.getState().user, null, "el éxito tardío de A no debe resucitar la sesión cerrada");
  assert.equal(controller.getState().token, null);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

// ==========================================================================
// Manejo global de 401 (JWT central vencido con la app abierta)
// ==========================================================================

// Arma un controlador con una sesión ya guardada, como al abrir Electron.
function withSession(token: string) {
  const storage = createFakeStorage();
  storage.setItem(STORAGE_KEY, token);
  const fetcher = createFakeFetch();
  const controller = new AuthSessionController({
    apiBase: "", storageKey: STORAGE_KEY, fetchImpl: fetcher.fetchImpl, storage, decodeJwtUser, applyUserTheme: () => {},
  });
  return { storage, controller, ...fetcher };
}

test("401 con el token vigente: si /auth/me confirma 401, cierra la sesión", async () => {
  const tokenA = makeToken({ username: "a", role: "editor" });
  const { storage, controller, resolveStatus, callsTo } = withSession(tokenA);

  const handled = controller.handleUnauthorized(tokenA);
  assert.equal(callsTo("/api/auth/me"), 1, "debe revalidar contra la central antes de decidir");
  resolveStatus("/api/auth/me", 401, { error: "jwt expired" });
  await handled;

  assert.equal(controller.getState().user, null);
  assert.equal(controller.getState().token, null);
  assert.equal(storage.getItem(STORAGE_KEY), null, "la credencial vencida debe borrarse");
});

test("401 con el token vigente: un 403 también cierra la sesión", async () => {
  const tokenA = makeToken({ username: "a", role: "editor" });
  const { storage, controller, resolveStatus } = withSession(tokenA);

  const handled = controller.handleUnauthorized(tokenA);
  resolveStatus("/api/auth/me", 403, { error: "forbidden" });
  await handled;

  assert.equal(controller.getState().token, null);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("401 de una credencial vieja tras un login nuevo: ni limpia ni revalida", async () => {
  const tokenA = makeToken({ username: "a", role: "editor" });
  const { storage, controller, resolveNext, callsTo } = withSession(tokenA);

  const tokenB = makeToken({ username: "b", role: "editor" });
  const loginPromise = controller.login("b", "pw");
  resolveNext("/api/auth/login", true, { token: tokenB, user: userB() });
  await loginPromise;

  // El 401 corresponde a una petición que salió con la credencial vieja.
  await controller.handleUnauthorized(tokenA);

  assert.equal(callsTo("/api/auth/me"), 0, "un 401 viejo no debe generar tráfico");
  assert.equal(controller.getState().user?.username, "b");
  assert.equal(storage.getItem(STORAGE_KEY), tokenB, "la sesión nueva no se toca");
});

test("401 con token vencido: limpia de inmediato y sin llamar a /auth/me", async () => {
  const tokenVencido = makeToken({ username: "a", role: "editor", exp: Math.floor(Date.now() / 1000) - 60 });
  const { storage, controller, callsTo } = withSession(tokenVencido);

  await controller.handleUnauthorized(tokenVencido);

  assert.equal(callsTo("/api/auth/me"), 0, "un JWT vencido no necesita revalidación (y la central podría no responder)");
  assert.equal(controller.getState().token, null);
  assert.equal(controller.getState().user, null);
  assert.equal(storage.getItem(STORAGE_KEY), null, "el usuario no debe quedar atrapado con una credencial muerta");
});

test("401 tardío de un token vencido viejo tras un login nuevo: no limpia B ni llama a /auth/me", async () => {
  const tokenVencido = makeToken({ username: "a", role: "editor", exp: Math.floor(Date.now() / 1000) - 60 });
  const { storage, controller, resolveNext, callsTo } = withSession(tokenVencido);

  const tokenB = makeToken({ username: "b", role: "editor" });
  const loginPromise = controller.login("b", "pw");
  resolveNext("/api/auth/login", true, { token: tokenB, user: userB() });
  await loginPromise;

  await controller.handleUnauthorized(tokenVencido); // señal tardía de la petición hecha con A

  assert.equal(callsTo("/api/auth/me"), 0);
  assert.equal(controller.getState().user?.username, "b");
  assert.equal(controller.getState().token, tokenB);
  assert.equal(storage.getItem(STORAGE_KEY), tokenB, "la sesión B vigente no se toca");
});

test("401 de plataforma (OAuth): /auth/me 200 conserva la sesión", async () => {
  const tokenA = makeToken({ username: "a", role: "editor" });
  const { storage, controller, resolveNext } = withSession(tokenA);

  const handled = controller.handleUnauthorized(tokenA);
  resolveNext("/api/auth/me", true, { user: userA() }); // la sesión central sigue viva
  await handled;

  assert.equal(storage.getItem(STORAGE_KEY), tokenA, "un 401 de YouTube/IG/TikTok no debe cerrar la sesión");
  assert.equal(controller.getState().token, tokenA);
});

test("con un token vigente, revalidación ambigua (red caída o 5xx) conserva la sesión", async () => {
  // (a) la red se cae en el medio
  {
    const tokenA = makeToken({ username: "a", role: "editor" });
    const { storage, controller, rejectNext } = withSession(tokenA);

    const handled = controller.handleUnauthorized(tokenA);
    rejectNext("/api/auth/me", new Error("network down"));
    await handled;

    assert.equal(storage.getItem(STORAGE_KEY), tokenA, "sin respuesta no hay confirmación de nada");
    assert.equal(controller.getState().token, tokenA);
  }

  // (b) la central contesta 500
  {
    const tokenA = makeToken({ username: "a", role: "editor" });
    const { storage, controller, resolveStatus } = withSession(tokenA);

    const handled = controller.handleUnauthorized(tokenA);
    resolveStatus("/api/auth/me", 500, { error: "boom" });
    await handled;

    assert.equal(storage.getItem(STORAGE_KEY), tokenA);
    assert.equal(controller.getState().token, tokenA);
  }
});

test("varios 401 simultáneos del mismo token se deduplican en una revalidación", async () => {
  const tokenA = makeToken({ username: "a", role: "editor" });
  const { storage, controller, resolveStatus, callsTo } = withSession(tokenA);

  // Tres peticiones en paralelo reciben 401 a la vez (típico de un dashboard
  // que dispara varios endpoints al montar).
  const handled = [
    controller.handleUnauthorized(tokenA),
    controller.handleUnauthorized(tokenA),
    controller.handleUnauthorized(tokenA),
  ];
  assert.equal(callsTo("/api/auth/me"), 1, "una sola revalidación para el mismo token");

  resolveStatus("/api/auth/me", 401, {});
  await Promise.all(handled);

  assert.equal(storage.getItem(STORAGE_KEY), null);

  // Y una vez terminada, la entrada de dedupe queda liberada: un 401 posterior
  // con esa credencial ya no revalida porque el storage cambió.
  await controller.handleUnauthorized(tokenA);
  assert.equal(callsTo("/api/auth/me"), 1);
});

test("un logout durante la revalidación gana: el 401 confirmado no revive ni pisa nada", async () => {
  const tokenA = makeToken({ username: "a", role: "editor" });
  const { storage, controller, resolveStatus } = withSession(tokenA);

  const handled = controller.handleUnauthorized(tokenA);
  controller.logout(); // el usuario cierra sesión mientras /auth/me está en vuelo

  const tokenB = makeToken({ username: "b", role: "editor" });
  storage.setItem(STORAGE_KEY, tokenB); // y entra otra sesión

  resolveStatus("/api/auth/me", 401, {});
  await handled;

  assert.equal(storage.getItem(STORAGE_KEY), tokenB, "no debe borrar la credencial de otra sesión");
});

test("la señal de 401 del transporte llega al controlador", async () => {
  const tokenA = makeToken({ username: "a", role: "editor" });
  const { storage, controller, resolveStatus, callsTo } = withSession(tokenA);

  // Mismo cableado que hace AuthProvider, sin React ni DOM.
  let inFlight: Promise<void> | undefined;
  const unsubscribe = onUnauthorized((token) => {
    inFlight = controller.handleUnauthorized(token);
  });

  try {
    notifyUnauthorized(tokenA); // lo que publica services/api.ts ante un 401
    assert.equal(callsTo("/api/auth/me"), 1, "la señal debe disparar la revalidación");
    resolveStatus("/api/auth/me", 401, {});
    await inFlight;
    assert.equal(storage.getItem(STORAGE_KEY), null);
  } finally {
    unsubscribe();
  }

  // Desuscripto: una señal posterior ya no toca al controlador.
  notifyUnauthorized(tokenA);
  assert.equal(callsTo("/api/auth/me"), 1);
});

// ==========================================================================
// bootstrap conservador: borra la credencial solo ante 401/403 confirmado o un
// JWT localmente inservible; red caída/5xx con un token vigente la conservan
// ==========================================================================

test("bootstrap con un token vigente conserva la sesión si la central no pudo responder", async () => {
  // (a) red caída
  {
    const tokenA = makeToken({ username: "a", role: "editor" });
    const { storage, controller, rejectNext } = withSession(tokenA);

    const bootstrapPromise = controller.bootstrap();
    rejectNext("/api/auth/me", new Error("offline"));
    await bootstrapPromise;

    assert.equal(storage.getItem(STORAGE_KEY), tokenA, "abrir Electron sin internet no debe desloguear");
    assert.equal(controller.getState().token, tokenA);
  }

  // (b) 5xx de la central
  {
    const tokenA = makeToken({ username: "a", role: "editor" });
    const { storage, controller, resolveStatus } = withSession(tokenA);

    const bootstrapPromise = controller.bootstrap();
    resolveStatus("/api/auth/me", 503, { error: "tunnel down" });
    await bootstrapPromise;

    assert.equal(storage.getItem(STORAGE_KEY), tokenA);
    assert.equal(controller.getState().token, tokenA);
  }
});

test("bootstrap con la red caída sí limpia un token localmente inservible (vencido)", async () => {
  const tokenVencido = makeToken({ username: "a", role: "editor", exp: Math.floor(Date.now() / 1000) - 60 });
  const { storage, controller, rejectNext } = withSession(tokenVencido);

  const bootstrapPromise = controller.bootstrap();
  rejectNext("/api/auth/me", new Error("offline"));
  await bootstrapPromise;

  assert.equal(storage.getItem(STORAGE_KEY), null, "un JWT ya vencido no sirve ni con red");
  assert.equal(controller.getState().token, null);
});

test("bootstrap con 401 confirmado limpia la sesión", async () => {
  const tokenA = makeToken({ username: "a", role: "editor" });
  const { storage, controller, resolveStatus } = withSession(tokenA);

  const bootstrapPromise = controller.bootstrap();
  resolveStatus("/api/auth/me", 401, { error: "jwt expired" });
  await bootstrapPromise;

  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(controller.getState().token, null);
  assert.equal(controller.getState().user, null);
});
