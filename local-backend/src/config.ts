// Punto único de "a qué central le hablo". Antes cada controller/service
// declaraba su propio `const CENTRAL = process.env.CENTRAL_API || 'https://
// api.esse-analytics.com'` -- funcionaba porque siempre había una sola
// central real. El modo Laboratorio necesita que TODOS esos puntos apunten al
// mismo lugar (el lab-backend compartido) sin tener que auditar archivo por
// archivo si alguno se olvidó el cambio -- por eso se centraliza acá una sola
// vez, y cada archivo importa `CENTRAL_API` en vez de leer el env var directo.
//
// Ver lab-backend/README.md para el contrato completo que expone el
// Laboratorio (mismos paths que la central real).
export const LAB_MODE = process.env.ESSENALYTICS_LAB_MODE === '1';

// 127.0.0.1 y NO 'localhost': en Windows, el fetch nativo de Node (undici)
// resuelve 'localhost' a ::1 primero -- si el otro servidor solo escucha en
// 0.0.0.0 (IPv4, como este mismo local-backend y lab-backend), la conexión
// da ECONNREFUSED aunque el server esté corriendo y curl/el navegador sí
// conecten bien (ellos prueban IPv4 también, fetch de Node no). Confirmado en
// este entorno -- ver lab-backend/README.md.
// Único punto de verdad para el secreto de JWT que este proceso confía --
// ver auth.middleware.ts y local-admin.routes.ts (ambos verifican tokens
// fuera de los endpoints que son simple proxy a CENTRAL_API). En Laboratorio
// el token lo emitió el lab-backend, nunca la central real -- por eso el
// secreto también tiene que ser el suyo.
export const JWT_SECRET = LAB_MODE
  ? (process.env.LAB_JWT_SECRET || 'esse_lab_secret_never_use_in_prod')
  : (process.env.JWT_SECRET || 'esse_secret_key_2024');

export const CENTRAL_API = LAB_MODE
  ? (process.env.LAB_API || 'http://127.0.0.1:5055')
  : (process.env.CENTRAL_API || 'https://api.esse-analytics.com');

if (LAB_MODE) {
  console.log(`[local-backend] ESSENALYTICS_LAB_MODE=1 -- hablando con el Laboratorio en ${CENTRAL_API}, uploaders mock activos, SQLite aislada (esse_lab.db).`);
}
