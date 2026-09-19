// Pruebas del pub/sub de "sesión no autorizada". Sin DOM ni React: el módulo
// es deliberadamente un Set de listeners, así se puede probar suelto.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyUnauthorized, onUnauthorized } from "./sessionSignal";

test("entrega el token exacto a cada suscriptor y respeta la desuscripción", () => {
  const primero: string[] = [];
  const segundo: string[] = [];
  const unsubPrimero = onUnauthorized((token) => primero.push(token));
  const unsubSegundo = onUnauthorized((token) => segundo.push(token));

  try {
    notifyUnauthorized("tok-1");
    assert.deepEqual(primero, ["tok-1"]);
    assert.deepEqual(segundo, ["tok-1"]);

    unsubPrimero();
    notifyUnauthorized("tok-2");
    assert.deepEqual(primero, ["tok-1"], "un listener desuscripto no debe recibir más señales");
    assert.deepEqual(segundo, ["tok-1", "tok-2"]);
  } finally {
    unsubPrimero();
    unsubSegundo();
  }
});

test("un 401 sin credencial no dispara nada", () => {
  const recibidos: string[] = [];
  const unsub = onUnauthorized((token) => recibidos.push(token));

  try {
    notifyUnauthorized(null);
    notifyUnauthorized(undefined);
    notifyUnauthorized("");
    assert.deepEqual(recibidos, [], "sin token no hay sesión que revalidar");
  } finally {
    unsub();
  }
});

test("un suscriptor que tira no corta a los demás ni propaga el error", () => {
  const recibidos: string[] = [];
  const unsubRoto = onUnauthorized(() => {
    throw new Error("listener roto");
  });
  const unsubSano = onUnauthorized((token) => recibidos.push(token));

  try {
    assert.doesNotThrow(() => notifyUnauthorized("tok-1"));
    assert.deepEqual(recibidos, ["tok-1"]);
  } finally {
    unsubRoto();
    unsubSano();
  }
});

test("un suscriptor puede desuscribirse durante la propia notificación", () => {
  const recibidos: string[] = [];
  let unsubPrimero = () => {};
  unsubPrimero = onUnauthorized(() => unsubPrimero());
  const unsubSegundo = onUnauthorized((token) => recibidos.push(token));

  try {
    assert.doesNotThrow(() => notifyUnauthorized("tok-1"));
    assert.deepEqual(recibidos, ["tok-1"], "la iteración no debe romperse a mitad de camino");
  } finally {
    unsubPrimero();
    unsubSegundo();
  }
});
