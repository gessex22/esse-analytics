// Import de solo efecto lateral, PRIMERO en cada archivo de test -- antes de
// cualquier otro import que transitivamente cargue config/env.ts.
//
// env.ts exige MONGO_URI en todos los ambientes (sin fallback, ver
// content-automation-dashboard/CLAUDE.md: "La central no arranca sin
// MONGO_URI") -- correcto para el servidor real, pero estos tests nunca
// llaman mongoose.connect() de verdad (mockean mongoose.connection.db
// directo), así que un placeholder que nunca se disca alcanza y sobra.
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/backend-tests-placeholder-never-connected';
