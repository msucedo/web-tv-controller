# hisense-remote

Un control remoto web para televisores **Hisense VIDAA**. Levantas un servidor
en tu Mac y abres una página desde el celular (en la misma red WiFi) que hace de
mando: D-pad, volumen, encender/apagar, cambiar de fuente y abrir apps como
YouTube o Netflix. El volumen se actualiza solo en la página cuando lo cambias
con el control físico.

Está escrito en Node **sin dependencias**: el cliente MQTT, el cifrado y el
servidor web están hechos a mano, para que se entienda cada pieza.

## Cómo funciona

La TV escucha en el puerto `36669` un broker MQTT sobre TLS (el mismo que usa la
app oficial RemoteNOW). El firmware moderno exige tres cosas: un **certificado
de cliente** de la app, **credenciales derivadas** de la hora y la MAC en cada
conexión, y un **emparejamiento por PIN** que te entrega un token de larga
duración. Este proyecto reconstruye todo eso.

| Archivo | Qué hace |
|---|---|
| `discover.js` | Encuentra la TV en la red (escanea el puerto 36669) y guarda su IP y MAC en `tv.json`. |
| `crypto.js` | Calcula el usuario, la contraseña y el clientId que pide el firmware moderno. |
| `mqtt.js` | Cliente MQTT 3.1.1 escrito a mano (CONNECT, SUBSCRIBE, PUBLISH, ping). |
| `tv.js` | Traduce "sube el volumen" o "abre YouTube" a los mensajes MQTT, y al revés. |
| `pair.js` | Emparejamiento por PIN (se corre una vez). |
| `wol.js` | Enciende la TV por Wake-on-LAN. |
| `server.js` + `public/index.html` | El servidor local y la página que usas desde el celular. |

## Puesta en marcha

Necesitas **Node 18+** y que la Mac y la TV estén en la **misma red**.

### 1. El certificado de cliente

El firmware exige el certificado que vive dentro de la app oficial de Hisense
(RemoteNOW / VIDAA). **No se incluye en este repositorio.** Si tienes la app en
formato `.apk`, puedes extraerlo del archivo `client_mobile_android.p12` que
trae dentro y dejarlo en `certs/app_client.pem` (cert + llave juntos). El
comando es, a grandes rasgos:

```bash
openssl pkcs12 -in <ruta-al-p12> -nodes -legacy > certs/app_client.pem
```

### 2. Descubrir y emparejar

```bash
node discover.js      # encuentra la TV y crea tv.json
node pair.js          # muestra un PIN en la TV; escríbelo aquí
```

> Cierra la app oficial RemoteNOW/VIDAA del celular antes de emparejar: la TV
> admite un solo mando a la vez.

### 3. Usarlo

```bash
npm start             # arranca el servidor en el puerto 8091
```

Abre en el celular `http://<ip-de-tu-mac>:8091` (el comando `npm start` te
imprime la dirección exacta).

Para encender la TV estando apagada necesitas activar en ella el encendido por
red (Ajustes → Sistema → algo tipo "Encendido rápido en red") y usar `node wol.js`.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run discover` | Busca la TV en la red. |
| `npm run pair` | Empareja por PIN. |
| `npm run wol` | Enciende la TV por Wake-on-LAN. |
| `npm start` | Arranca el servidor web. |

## Nota

Esto es para interoperar con **tu propia TV en tu propia red**, como uso
personal. El certificado es propiedad de Hisense; ni el certificado ni la app se
incluyen aquí. `tv.json` (con tu token), la carpeta `certs/` y cualquier `apk/`
quedan fuera del control de versiones.

## Licencia

MIT — ver [LICENSE](LICENSE).
