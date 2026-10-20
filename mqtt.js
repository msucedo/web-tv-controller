// Paso 2: un cliente MQTT 3.1.1 escrito a mano, sin librerías.
//
// MQTT es un protocolo de "temas": un cliente PUBLICA un mensaje en un tema
// (una ruta como /remoteapp/tv/...) y todos los SUSCRITOS a ese tema lo
// reciben. El "broker" es quien reparte; en VIDAA el broker vive en la TV.
//
// Todo paquete MQTT tiene la misma forma:
//
//   byte 0      tipo (4 bits altos) + banderas (4 bits bajos)
//   bytes 1..4  "remaining length": cuántos bytes siguen (entero variable)
//   resto       cabecera variable + payload, según el tipo
//
// Los strings van como [largo en 2 bytes big-endian][bytes UTF-8].

import tls from 'node:tls';
import { EventEmitter } from 'node:events';

export const TYPE = {
  CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4,
  SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14,
};
const TYPE_NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));

// Respuestas posibles del CONNACK (byte 2 del paquete).
export const CONNACK_CODES = {
  0: 'aceptado',
  1: 'versión de protocolo no soportada',
  2: 'client id rechazado',
  3: 'servidor no disponible',
  4: 'usuario o contraseña incorrectos',
  5: 'no autorizado',
};

// "Remaining length": 7 bits por byte; el bit alto dice "sigue otro byte".
// 321 → 0xC1 0x02 (65 | 0x80, luego 2), porque 321 = 65 + 2*128.
function encodeLength(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

function str(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);
}

export function connectPacket({ clientId, username, password, keepalive = 45, cleanSession = true }) {
  // El firmware VIDAA moderno habla MQTT 3.1.1 (nombre "MQTT", nivel 4) con
  // sesión limpia. Lo que rechazaba con CONNACK 5 no era el protocolo sino las
  // credenciales: el firmware nuevo no acepta las estáticas, sino unas derivadas
  // de la hora y la MAC (ver crypto.js).
  let flags = cleanSession ? 0x02 : 0x00;
  if (username != null) flags |= 0x80;
  if (password != null) flags |= 0x40;
  const ka = Buffer.alloc(2);
  ka.writeUInt16BE(keepalive);
  const parts = [
    str('MQTT'), Buffer.from([4]), // MQTT 3.1.1
    Buffer.from([flags]), ka,
    str(clientId),
  ];
  if (username != null) parts.push(str(username));
  if (password != null) parts.push(str(password));
  return packet(TYPE.CONNECT, 0, Buffer.concat(parts));
}

// QoS 0: "dispara y olvida", sin id ni confirmación. Es lo que usa RemoteNOW.
export function publishPacket(topic, payload = '') {
  return packet(TYPE.PUBLISH, 0, Buffer.concat([str(topic), Buffer.from(payload)]));
}

export function subscribePacket(id, topics) {
  const pid = Buffer.alloc(2);
  pid.writeUInt16BE(id);
  const list = topics.map((t) => Buffer.concat([str(t), Buffer.from([0])])); // QoS 0
  return packet(TYPE.SUBSCRIBE, 0x02, Buffer.concat([pid, ...list])); // flags 0010 obligatorios
}

export const pingPacket = () => packet(TYPE.PINGREQ, 0, Buffer.alloc(0));
export const disconnectPacket = () => packet(TYPE.DISCONNECT, 0, Buffer.alloc(0));

// TCP no respeta los bordes de los paquetes: un 'data' puede traer medio
// paquete o tres juntos. Este parser acumula bytes y saca paquetes completos.
export class Parser {
  buf = Buffer.alloc(0);

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const packets = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0, mult = 1, i = 1, byte;
      do {
        if (i >= this.buf.length) return packets; // falta el resto del largo
        byte = this.buf[i++];
        len += (byte & 0x7f) * mult;
        mult *= 128;
      } while (byte & 0x80);
      if (this.buf.length < i + len) break; // falta el resto del cuerpo
      const raw = this.buf.subarray(0, i + len);
      packets.push(decode(raw, this.buf[0], this.buf.subarray(i, i + len)));
      this.buf = this.buf.subarray(i + len);
    }
    return packets;
  }
}

function decode(raw, first, body) {
  const type = first >> 4;
  const p = { type, name: TYPE_NAME[type] ?? `TIPO_${type}`, raw };
  if (type === TYPE.CONNACK) {
    p.sessionPresent = !!(body[0] & 1);
    p.code = body[1];
  } else if (type === TYPE.PUBLISH) {
    const qos = (first >> 1) & 3;
    const tlen = body.readUInt16BE(0);
    p.topic = body.subarray(2, 2 + tlen).toString('utf8');
    const start = 2 + tlen + (qos > 0 ? 2 : 0); // QoS>0 trae id de paquete
    p.payload = body.subarray(start).toString('utf8');
  } else if (type === TYPE.SUBACK) {
    p.id = body.readUInt16BE(0);
    p.granted = [...body.subarray(2)];
  }
  return p;
}

// Bytes en hex agrupados, para ver el protocolo "a mano".
export const hex = (b) => b.toString('hex').match(/../g)?.join(' ') ?? '';

// Cliente: TLS + parser + keepalive. Emite 'connack', 'message', 'packet',
// 'sent', 'close' y 'error'.
export class Client extends EventEmitter {
  #sock;
  #ping;
  #nextId = 1;

  connect({ host, port, clientId, username, password, keepalive = 45, cert, key, tlsOptions = {} }) {
    const parser = new Parser();
    // El certificado de la TV es autofirmado por Hisense ("RemoteCA"), así que
    // no lo podemos validar contra las autoridades normales (rejectUnauthorized
    // false). Además, el firmware nuevo exige "mutual TLS": que NOSOTROS también
    // presentemos un certificado de cliente (cert + key). Sin él, la TV corta la
    // conexión con el error "certificate required" antes de leer usuario/clave.
    this.#sock = tls.connect({ host, port, rejectUnauthorized: false, cert, key, ...tlsOptions });
    this.#sock.once('secureConnect', () => {
      this.emit('tls', this.#sock.getProtocol(), this.#sock.getCipher().name);
      this.#send(connectPacket({ clientId, username, password, keepalive }));
    });
    this.#sock.on('data', (chunk) => {
      for (const p of parser.push(chunk)) {
        this.emit('packet', p);
        if (p.type === TYPE.CONNACK) {
          if (p.code === 0) this.#ping = setInterval(() => this.#send(pingPacket()), keepalive * 500);
          this.emit('connack', p.code);
        } else if (p.type === TYPE.PUBLISH) {
          this.emit('message', p.topic, p.payload);
        }
      }
    });
    this.#sock.on('error', (e) => this.emit('error', e));
    this.#sock.on('close', () => { clearInterval(this.#ping); this.emit('close'); });
    return this;
  }

  #send(buf) {
    this.emit('sent', buf);
    this.#sock.write(buf);
  }

  publish(topic, payload = '') { this.#send(publishPacket(topic, payload)); }
  subscribe(...topics) { this.#send(subscribePacket(this.#nextId++, topics)); }

  end() {
    clearInterval(this.#ping);
    if (this.#sock.writable) this.#send(disconnectPacket());
    this.#sock.end();
  }
}
