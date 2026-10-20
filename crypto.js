// Credenciales del firmware VIDAA moderno (2024+).
//
// El firmware nuevo NO acepta el usuario/clave fijos. En su lugar, la app los
// calcula en cada conexión a partir de la hora actual y la MAC, con unos "salts"
// y una máscara que vienen incrustados en la app. Esto lo reconstruyó la
// comunidad (repo stevene1919/hisense_vidaa, crypto.py); aquí lo portamos a JS.
//
// Todas las piezas (salts, patrón, máscara) son constantes públicas de la app.

import { createHash, randomBytes } from 'node:crypto';

const MODERN_SALT = 'h!i@s#$v%i^d&a*a';
const CLIENT_ID_PATTERN = '38D65DC30F45109A369A86FCE866A85B';
// La máscara es un número de 63 bits: para el XOR hay que usar BigInt, porque
// el operador ^ normal de JS trabaja solo con 32 bits y daría un resultado mal.
const XOR_TIMESTAMP_MASK = 6239759785777146216n;

const md5 = (s) => createHash('md5').update(s).digest('hex').toUpperCase();

// Normaliza la MAC a "aa:bb:cc:dd:ee:ff" conservando mayúsculas/minúsculas (el
// hash es sensible a eso). Sin MAC, inventa una aleatoria.
export function cleanMac(mac) {
  if (mac) {
    const s = mac.replace(/[:\-.]/g, '').trim();
    if (s.length === 12) return s.match(/../g).join(':');
  }
  return [...randomBytes(6)].map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
}

// Devuelve { clientId, username, password } para el handshake inicial.
// timestamp en segundos; por defecto, ahora.
export function initialCredentials(mac, timestamp = Math.floor(Date.now() / 1000)) {
  const cleanedMac = cleanMac(mac);
  const secondHash = md5(`${CLIENT_ID_PATTERN}$${cleanedMac}`);
  const clientId = `${cleanedMac}$his$${secondHash.slice(0, 6)}_vidaacommon_001`;

  // Último dígito de la suma de los dígitos del timestamp.
  const crossSum = String(timestamp).split('').reduce((a, d) => a + Number(d), 0) % 10;

  // Perfil "modern": usuario con la hora enmascarada por XOR, clave con salt.
  const username = `his$${BigInt(timestamp) ^ XOR_TIMESTAMP_MASK}`;
  const thirdHash = md5(`his${crossSum}${MODERN_SALT}`);
  const password = md5(`${timestamp}$${thirdHash.slice(0, 6)}`);

  return { clientId, username, password };
}
