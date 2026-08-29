# iEM3255 — Dashboard web con históricos

Dashboard en vivo (PC y móvil) para el medidor Schneider Electric iEM3255, leído
por un dispositivo **Walter** (Quickspot/DPTechnics, ESP32-S3 + LTE-M/NB-IoT,
SIM Telcel) vía RS-485/Modbus, que publica por MQTT al mismo broker que ya usas
(`mqtt.ocean53.xyz`). A diferencia del dashboard de WNOLOGY (que solo guarda
histórico en memoria), este sí guarda un histórico persistente en SQLite, así
que sobrevive a reinicios del proceso y soporta rangos de 1h/24h/7d/30d.

## Arquitectura

```
iEM3255 ──RS-485/Modbus──► Walter ──MQTT/TLS (celular)──► mqtt.ocean53.xyz
                                                                  │
                                                                  ▼
                                            server.js (Node, en tu droplet)
                                              │              │
                                    cachea el último    guarda cada lectura
                                    valor en memoria     en SQLite (./data)
                                              │              │
                                REST /api/latest /api/live /api/history
                                          + WebSocket /ws
                                                  │
                                              Nginx (TLS)
                                                  │
                                              Cloudflare
                                                  │
                                          Navegador (PC/móvil)
```

## Por qué no pude desplegarlo yo mismo

Esta sesión de Cowork corre en un contenedor/VM aislado y no puede alcanzar
el puerto 22 de tu droplet (`161.35.58.65`) — solo tráfico HTTP(S) saliente a
través de un proxy con lista blanca. Ni desde el contenedor en la nube ni
desde el shell sandboxeado de tu Mac mini logré una conexión SSH. Por eso te
dejo todo listo en `~/proyectos/walter-iem3255-monitor/` para que lo subas tú
—igual que hiciste con `wnology-dashboard`— desde tu Terminal real o tu Claude
Code nativo, que sí tienen salida completa a internet.

## 1. Preparar el servidor (una sola vez, si aún no lo hiciste para wnology-dashboard)

```bash
ssh root@161.35.58.65

apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs nginx
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

## 2. Subir el proyecto

Desde tu Mac (carpeta `~/proyectos/walter-iem3255-monitor/dashboard`):

```bash
rsync -avz --exclude node_modules --exclude .env --exclude data \
  ~/proyectos/walter-iem3255-monitor/dashboard/ root@161.35.58.65:/opt/iem3255-dashboard/
```

## 3. Instalar dependencias y configurar variables

En el droplet:

```bash
cd /opt/iem3255-dashboard
cp .env.example .env
nano .env       # completa MQTT_PASSWORD (pegs530112, la misma que usa
                 # wnology-dashboard) y revisa MQTT_URL/MQTT_TOPIC

mkdir -p data
npm install --omit=dev
```

`better-sqlite3` compila un binario nativo — normalmente descarga uno
precompilado para Linux x64 sin más, pero si el `npm install` falla
compilando, instala herramientas de build primero:

```bash
apt install -y build-essential python3
npm install --omit=dev
```

Prueba manual antes de automatizar con systemd:

```bash
node server.js
# otra pestaña SSH:
curl http://127.0.0.1:3001/healthz
```

Deberías ver `"mqttConnected":true`. Ctrl+C para detener la prueba.

## 4. Dejarlo corriendo con systemd

```bash
chown -R www-data:www-data /opt/iem3255-dashboard

cp deploy/iem3255-dashboard.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now iem3255-dashboard
systemctl status iem3255-dashboard   # debe decir "active (running)"

journalctl -u iem3255-dashboard -f   # logs en vivo
```

## 5. Nginx + certificado (DNS sin proxy — distinto a wnology-dashboard)

El registro DNS de `iem3255.istecnomed.com` ya está creado apuntando a
`161.35.58.65`, pero **sin el proxy de Cloudflare** (nube gris, "DNS only").
Eso cambia cómo se maneja el HTTPS respecto a wnology-dashboard:

- wnology-dashboard usa Cloudflare de por medio → el certificado de origen
  de Cloudflare es válido ahí (solo lo valida el propio Cloudflare).
- Este subdominio conecta directo del navegador al droplet → necesita un
  certificado público de verdad. Usamos **Let's Encrypt** (gratis) con
  `certbot`.

```bash
cp deploy/nginx.conf /etc/nginx/sites-available/iem3255-dashboard
# ya trae server_name iem3255.istecnomed.com, no hace falta editarlo

ln -s /etc/nginx/sites-available/iem3255-dashboard /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

# Certificado público con certbot (necesita el puerto 80 abierto y el DNS
# ya resuelto hacia esta IP — el registro "DNS only" cumple esto perfecto)
apt install -y certbot python3-certbot-nginx
certbot --nginx -d iem3255.istecnomed.com
```

`certbot --nginx` valida el dominio, obtiene el certificado y **reescribe
`/etc/nginx/sites-available/iem3255-dashboard` solo**, agregando el bloque
`listen 443 ssl` con las rutas al certificado y el redirect 80→443. No hace
falta tocar nada a mano después. Los certificados de Let's Encrypt duran 90
días — `certbot` instala un timer systemd (`certbot.timer`) que los renueva
solo; confírmalo con `systemctl list-timers | grep certbot`.

Si más adelante decides activar el proxy de Cloudflare (nube naranja) para
este subdominio, no pasa nada — Cloudflare simplemente pasa el tráfico HTTPS
tal cual (modo "Full", no hace falta "Full (strict)" con certificado de
origen especial, porque el certificado de Let's Encrypt ya es público).

## 6. Probar

```
https://iem3255.istecnomed.com
```

Con el firmware del Walter ya publicando, deberías ver el punto en verde
("En vivo") y las tarjetas/gráficas actualizándose cada ~30s (o el intervalo
que configures en `INTERVALO_LECTURA_MS` del .ino).

Antes de tener el Walter en campo, puedes probar el pipeline completo
publicando un mensaje de prueba a mano:

```bash
mosquitto_pub -h mqtt.ocean53.xyz -p 8883 --capath /etc/ssl/certs \
  -u sergio -P pegs530112 \
  -t "iem3255/walter01/state" \
  -m '{"voltaje1":127.3,"voltaje2":126.9,"voltaje3":127.8,"corriente1":4.2,"corriente2":3.9,"corriente3":4.5,"potencia1":530,"potencia2":495,"potencia3":572,"potenciaTotal":1597,"potenciaReacTotal":210,"potenciaApTotal":1611,"factorPotencia":0.991,"frecuencia":60.01}'
```

Deberías verlo aparecer al instante en el dashboard.

## 7. Actualizar más adelante

```bash
rsync -avz --exclude node_modules --exclude .env --exclude data \
  ~/proyectos/walter-iem3255-monitor/dashboard/ root@161.35.58.65:/opt/iem3255-dashboard/

ssh root@161.35.58.65 "cd /opt/iem3255-dashboard && npm install --omit=dev && systemctl restart iem3255-dashboard"
```

## Notas

- El histórico persiste en `/opt/iem3255-dashboard/data/iem3255.db` (SQLite).
  Por defecto se conserva 180 días (`HISTORY_RETENTION_DAYS` en `.env`); las
  filas más viejas se purgan solas cada 6h. A 1 lectura/30s son ~35MB en 180
  días — sin problema en un droplet de 1GB.
- `/api/history?horas=N` agrega los datos en hasta 500 "buckets" (promedios)
  para no mandar de más al navegador en rangos largos (7d/30d).
- El puerto 3001 de Node solo escucha en `127.0.0.1` — todo el tráfico
  externo pasa por Nginx, igual que con wnology-dashboard (puerto 3000).
- Corrige el topic MQTT en `.ino` y en `.env` si decides usar otro nombre de
  dispositivo que no sea `walter01`.
