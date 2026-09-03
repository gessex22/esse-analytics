// Carga las variables de entorno ANTES que cualquier otro módulo.
// Debe ser el PRIMER import de server.ts: varios módulos (ej. config.ts,
// que exporta JWT_SECRET) leen process.env en su nivel superior al
// importarse, así que dotenv tiene que haber corrido antes o se quedan con
// el fallback -- mismo patrón que backend/src/load-env.ts.
import dotenv from 'dotenv';
dotenv.config();
