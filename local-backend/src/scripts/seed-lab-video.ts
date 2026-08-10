// Utilidad de diagnóstico para el Laboratorio -- NO parte del servidor que
// corre de verdad (ver exclude en tsconfig.json, mismo criterio que el resto
// de scripts/). Crea un registro de archivo en la SQLite activa (esse_lab.db
// si corrés esto con ESSENALYTICS_LAB_MODE=1) apuntando a un placeholder en
// disco, sin depender de ffprobe/escaneo real -- útil para probar el flujo de
// "Subir" end-to-end contra los uploaders mock sin tener un video real a mano.
//
// Uso:
//   ESSENALYTICS_LAB_MODE=1 npx tsx src/scripts/seed-lab-video.ts "C:/temp/clip-test.mp4" "mi-video.mp4"
import fs from 'fs';
import path from 'path';
import { fileRepo } from '../db/file.repo';

const filePath = process.argv[2];
const fileName = process.argv[3] ?? path.basename(filePath ?? 'clip-test.mp4');

if (!filePath) {
  console.error('Uso: tsx src/scripts/seed-lab-video.ts <ruta-del-archivo> [nombre]');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'placeholder de Laboratorio -- no es un video real, alcanza para probar el flujo de subida mock.');
  console.log(`Placeholder creado en ${filePath}`);
}

const file = fileRepo.create({ file_name: fileName, file_path: filePath, duracion_segundos: 30 });
console.log(JSON.stringify(file, null, 2));
