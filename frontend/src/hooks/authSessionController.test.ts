// Pruebas de la carrera de sesión (P0): una respuesta tardía de bootstrap
// (/auth/me o /api/local/session) iniciada bajo una credencial vieja nunca
// debe pisar un login/logout más nuevo. Deterministas: cada fetch se
// resuelve/rechaza a mano, en el orden que arma cada test -- sin timers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthSessionController, decodeJwtUser, type AuthStorage, type AuthUser } from "./authSessionController";

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

type FakeResponse = { ok: boolean; json: () => Promise<unknown> };

// fetch falso: cada llamada queda "en espera" hasta que el test la resuelve
// o rechaza explícitamente por URL, en el orden que el test decide.
function createFakeFetch() {
  const pending = new Map<string, { resolve: (r: FakeResponse) => void; reject: (e: unknown) => void }[]>();
  const fetchImpl = ((url: string | URL) => {
    return new Promise<FakeResponse>((resolve, reject) => {
      const key = String(url);
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
      takeNext(urlSubstr).resolve({ ok, json: async () => body });
    },
    rejectNext(urlSubstr: string, err: unknown) {
      takeNext(urlSubstr).reject(err);
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

test("un /auth/me fallido para la sesión aún vigente sí la invalida", async () => {
  const storage = createFakeStorage();
  const tokenA = makeToken({ username: "a", role: "editor" });
  storage.setItem(STORAGE_KEY, tokenA);
  const { fetchImpl, rejectNext } = createFakeFetch();
  const controller = new AuthSessionController({
    apiBase: "", storageKey: STORAGE_KEY, fetchImpl, storage, decodeJwtUser, applyUserTheme: () => {},
  });

  const bootstrapPromise = controller.bootstrap();
  rejectNext("/api/auth/me", new Error("token inválido"));
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
