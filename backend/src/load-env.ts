// Carga las variables de entorno ANTES que cualquier otro módulo.
// Debe ser el PRIMER import de server.ts: varios módulos (ej. auth.controller)
// leen process.env en su nivel superior al importarse, así que dotenv tiene que
// haber corrido antes o se quedan con el fallback.
import dotenv from 'dotenv';
dotenv.config();
