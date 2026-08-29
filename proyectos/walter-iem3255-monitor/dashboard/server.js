require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;
const MQTT_URL = process.env.MQTT_URL || 'mqtts://mqtt.ocean53.xyz:8883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'iem3255/walter01/state';
const LIVE_BUFFER_LENGTH = parseInt(process.env.LIVE_BUFFER_LENGTH || '120', 10);
const HISTORY_RETENTION_DAYS = parseInt(process.env.HISTORY_RETENTION_DAYS || '180', 10);
const DB_PATH = process.env.DB_PATH || './data/iem3255.db';

// Campos numéricos del medidor que guardamos/graficamos.
const CAMPOS = [
  'voltaje1', 'voltaje2', 'voltaje3',
  'corriente1', 'corriente2', 'corriente3',
  'potencia1', 'potencia2', 'potencia3',
  'potenciaTotal', 'potenciaReacTotal', 'potenciaApTotal',
  'factorPotencia', 'frecuencia',
];

// ---- SQLite: histórico persistente ----
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS lecturas (
    ts INTEGER NOT NULL,
    voltaje1 REAL, voltaje2 REAL, voltaje3 REAL,
    corriente1 REAL, corriente2 REAL, corriente3 REAL,
    potencia1 REAL, potencia2 REAL, potencia3 REAL,
    potenciaTotal REAL, potenciaReacTotal REAL, potenciaApTotal REAL,
    factorPotencia REAL, frecuencia REAL
  );
  CREATE INDEX IF NOT EXISTS idx_lecturas_ts ON lecturas(ts);
`);

const insertStmt = db.prepare(`
  INSERT INTO lecturas (ts, ${CAMPOS.join(', ')})
  VALUES (@ts, ${CAMPOS.map((c) => '@' + c).join(', ')})
`);

function guardarEnHistorico(ts, fields) {
  const row = { ts };
  for (const c of CAMPOS) row[c] = typeof fields[c] === 'number' ? fields[c] : null;
  insertStmt.run(row);
}

function limpiarHistoricoViejo() {
  const limite = Math.floor(Date.now() / 1000) - HISTORY_RETENTION_DAYS * 86400;
  const info = db.prepare('DELETE FROM lecturas WHERE ts < ?').run(limite);
  if (info.changes > 0) console.log(`[db] purgadas ${info.changes} filas viejas (> ${HISTORY_RETENTION_DAYS} días)`);
}
setInterval(limpiarHistoricoViejo, 6 * 3600 * 1000); // cada 6h

// Trae el histórico agrupado en "buckets" para no mandar de más al navegador
// (ej: 30 días a 1 lectura/30s serían ~86,000 filas — las agregamos por
// promedio en como mucho `maxPuntos` intervalos).
function consultarHistorico(horas, maxPuntos) {
  const desde = Math.floor(Date.now() / 1000) - horas * 3600;
  const rangoSeg = horas * 3600;
  const bucketSeg = Math.max(1, Math.ceil(rangoSeg / maxPuntos));

  const promedios = CAMPOS.map((c) => `AVG(${c}) AS ${c}`).join(', ');
  // OJO: better-sqlite3 no siempre liga los parámetros como INTEGER (a
  // veces los liga como REAL aunque el número JS sea entero), y eso rompe
  // la división entera de SQLite (ts/@bucket) — hace división real y ya
  // no agrupa nada. Forzamos con CAST(...AS INTEGER) para garantizar
  // división entera sin importar cómo se ligó el parámetro.
  const filas = db.prepare(`
    SELECT (CAST(ts AS INTEGER) / CAST(@bucket AS INTEGER)) * CAST(@bucket AS INTEGER) AS bucketTs,
           ${promedios}, COUNT(*) AS n
    FROM lecturas
    WHERE ts >= @desde
    GROUP BY bucketTs
    ORDER BY bucketTs ASC
  `).all({ bucket: bucketSeg, desde });

  return filas.map((f) => ({ ts: f.bucketTs * 1000, fields: pickCampos(f) }));
}

function pickCampos(row) {
  const out = {};
  for (const c of CAMPOS) out[c] = row[c] !== null && row[c] !== undefined ? Number(row[c]) : null;
  return out;
}

// ---- Estado en memoria (para /api/latest y el buffer "en vivo") ----
let latest = null; // { fields, ts, receivedAt }
const liveBuffer = [];

function pushReading(fields, deviceTs) {
  const reading = { fields, deviceTs: deviceTs ?? null, receivedAt: Date.now() };
  latest = reading;
  liveBuffer.push(reading);
  if (liveBuffer.length > LIVE_BUFFER_LENGTH) liveBuffer.shift();

  guardarEnHistorico(Math.floor(reading.receivedAt / 1000), fields);

  return reading;
}

// ---- Cliente MQTT ----
const mqttClient = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME || undefined,
  password: MQTT_PASSWORD || undefined,
  reconnectPeriod: 2000,
  connectTimeout: 10000,
  clientId: 'iem3255-dashboard-' + Math.random().toString(16).slice(2, 10),
});

mqttClient.on('connect', () => {
  console.log(`[mqtt] conectado a ${MQTT_URL}, suscribiendo a "${MQTT_TOPIC}"`);
  mqttClient.subscribe(MQTT_TOPIC, { qos: 0 }, (err) => {
    if (err) console.error('[mqtt] error al suscribir:', err.message);
  });
});
mqttClient.on('reconnect', () => console.log('[mqtt] reconectando...'));
mqttClient.on('close', () => console.log('[mqtt] conexión cerrada'));
mqttClient.on('error', (err) => console.error('[mqtt] error:', err.message));

mqttClient.on('message', (topic, payloadBuf) => {
  try {
    const fields = JSON.parse(payloadBuf.toString());
    const reading = pushReading(fields, fields.ts);
    broadcast(reading);
  } catch (err) {
    console.error('[mqtt] no se pudo parsear el payload:', err.message);
  }
});

// ---- Servidor HTTP + estáticos + API ----
const app = express();
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.get('/healthz', (req, res) => {
  const totalFilas = db.prepare('SELECT COUNT(*) AS n FROM lecturas').get().n;
  res.json({
    ok: true,
    mqttConnected: mqttClient.connected,
    hasData: latest !== null,
    filasHistorico: totalFilas,
  });
});

app.get('/api/latest', (req, res) => {
  if (!latest) return res.status(204).end();
  res.json(latest);
});

// Buffer corto en memoria (para las gráficas "en vivo")
app.get('/api/live', (req, res) => {
  res.json(liveBuffer);
});

// Histórico persistente desde SQLite, agregado por buckets
// /api/history?horas=24&maxPuntos=500
app.get('/api/history', (req, res) => {
  const horas = Math.max(0.1, Math.min(24 * 365, parseFloat(req.query.horas) || 24));
  const maxPuntos = Math.max(10, Math.min(2000, parseInt(req.query.maxPuntos, 10) || 500));
  try {
    res.json(consultarHistorico(horas, maxPuntos));
  } catch (err) {
    console.error('[db] error consultando histórico:', err.message);
    res.status(500).json({ error: 'error consultando histórico' });
  }
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[http] escuchando en http://127.0.0.1:${PORT}`);
});

// ---- WebSocket: push en vivo a los navegadores conectados ----
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(reading) {
  const msg = JSON.stringify({ type: 'reading', payload: reading });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', payload: { latest, liveBuffer } }));
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
