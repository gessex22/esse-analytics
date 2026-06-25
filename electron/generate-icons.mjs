// Genera icon.ico (Windows, 256×256) e icon.png (Mac/Linux, 512×512)
// desde el logo fuente de la app.
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pngToIco from 'png-to-ico';
import { Jimp } from 'jimp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src  = path.join(__dirname, '../frontend/src/assets/esseAnalytics.png');
const dest = path.join(__dirname, 'assets');

// Redimensiona a 512×512 (base para ambos formatos)
const img512 = await Jimp.read(src);
img512.resize({ w: 512, h: 512 });
const png512 = await img512.getBuffer('image/png');

// icon.png — para Mac/Linux
writeFileSync(path.join(dest, 'icon.png'), png512);
console.log('✓ icon.png (512×512)');

// Redimensiona a 256×256 para el ICO de Windows
const img256 = await Jimp.read(src);
img256.resize({ w: 256, h: 256 });
const png256 = await img256.getBuffer('image/png');

// icon.ico — para Windows (incluye varias resoluciones)
const icoBuffer = await pngToIco([png256]);
writeFileSync(path.join(dest, 'icon.ico'), icoBuffer);
console.log('✓ icon.ico (256×256)');
