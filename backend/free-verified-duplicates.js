#!/usr/bin/env node
// Libera manualmente el archivo de video de entradas puntuales de Biblioteca
// remota que quedaron protegidas por la regla de "fileName ambiguo" del sweep
// automático (ver remote-library-retention.service.ts), pero que ya se
// verificaron a mano como seguras: dos videos con contenido DISTINTO que
// casualmente comparten nombre, cada uno con su propio hardlink correcto al
// archivo local (confirmado por número de inodo).
//
// No es una herramienta genérica de "borrar ambiguos" -- la lista de abajo es
// explícita a propósito. Re-verifica el inodo en el momento (por si algo
// cambió desde la revisión manual) antes de tocar cualquier archivo; si no
// coincide, salta esa entrada y no borra nada.
//
// Uso: node free-verified-duplicates.js           (dry-run, no borra nada)
//      node free-verified-duplicates.js --apply   (borra de verdad)

const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config();

// _id de RemoteLibraryVideoModel + ino esperado (tomado de la verificación
// manual) -- si el ino real no coincide al momento de correr esto, se salta.
const TARGETS = [
  { id: '6a5f323ee4c2c52866c6db74', fileName: 'short - blu.mp4',       expectedIno: 562949953649630 },
  { id: '6a5f323ee4c2c52866c6db75', fileName: 'short - blu.mp4',       expectedIno: 562949953647369 },
  { id: '6a5f323fe4c2c52866c6db87', fileName: 'short - formatos.mp4',  expectedIno: 281474976939138 },
  { id: '6a5f323fe4c2c52866c6db88', fileName: 'short - formatos.mp4',  expectedIno: 11258999068654720 },
];

async function main() {
  const apply = process.argv.includes('--apply');
  const mongoose = require('mongoose');
  const RemoteLibraryVideoModel = mongoose.model(
    'RemoteLibraryVideo',
    new mongoose.Schema({}, { strict: false, timestamps: true }),
    'remote_library_videos',
  );

  await mongoose.connect(process.env.MONGO_URI);
  const remoteLibraryDir = process.env.CENTRAL_REMOTE_LIBRARY_DIR
    || path.join(os.homedir(), '.esse-analytics-central', 'remote-library');

  for (const t of TARGETS) {
    const doc = await RemoteLibraryVideoModel.findById(t.id).lean();
    if (!doc) { console.log(`[SALTEADO] ${t.id} (${t.fileName}) -- ya no existe el documento`); continue; }
    if (doc.fileName !== t.fileName) {
      console.log(`[SALTEADO] ${t.id} -- fileName cambió (esperaba "${t.fileName}", es "${doc.fileName}")`);
      continue;
    }

    const filePath = path.join(remoteLibraryDir, doc.userId, doc.storedFileName);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      console.log(`[SALTEADO] ${t.id} (${t.fileName}) -- ya no está en disco (nada que liberar)`);
      continue;
    }

    if (stat.ino !== t.expectedIno) {
      console.log(`[SALTEADO] ${t.id} (${t.fileName}) -- ino no coincide (esperaba ${t.expectedIno}, es ${stat.ino}) -- algo cambió, no se toca`);
      continue;
    }
    if (stat.nlink <= 1) {
      console.log(`[SALTEADO] ${t.id} (${t.fileName}) -- nlink=${stat.nlink}, ya no hay otro link -- borrar sería perder el video, no se toca`);
      continue;
    }

    if (apply) {
      fs.unlinkSync(filePath);
      console.log(`[LIBERADO] ${t.id} (${t.fileName}) -- storedFileName=${doc.storedFileName} (nlink era ${stat.nlink}, el local queda intacto)`);
    } else {
      console.log(`[DRY-RUN] ${t.id} (${t.fileName}) -- se liberaría storedFileName=${doc.storedFileName} (nlink=${stat.nlink})`);
    }
  }

  await mongoose.disconnect();
  if (!apply) console.log('\nEsto fue un dry-run. Para aplicar de verdad: node free-verified-duplicates.js --apply');
}

main().catch(err => { console.error('Error fatal:', err.message); process.exit(1); });
