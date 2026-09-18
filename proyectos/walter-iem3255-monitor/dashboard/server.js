require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const ExcelJS = require('exceljs');

const PORT = process.env.PORT || 3001;
const MQTT_URL = process.env.MQTT_URL || 'mqtts://mqtt.ocean53.xyz:8883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'iem3255/walter01/state';
// Segundo topic del firmware con la salud del pipeline (Modbus/red/MQTT) —
// se publica cada ciclo, incluso cuando la lectura del medidor falla.
const MQTT_TOPIC_DIAG = process.env.MQTT_TOPIC_DIAG || MQTT_TOPIC.replace(/\/state$/, '/diag');
const LIVE_BUFFER_LENGTH = parseInt(process.env.LIVE_BUFFER_LENGTH || '120', 10);
const HISTORY_RETENTION_DAYS = parseInt(process.env.HISTORY_RETENTION_DAYS || '180', 10);
const DB_PATH = process.env.DB_PATH || './data/iem3255.db';
// Offset horario para agrupar el consumo por día (default: -6h, CDMX/Chiapas).
const CONSUMO_TZ = process.env.CONSUMO_TZ || '-6 hours';

// Campos numéricos del medidor que guardamos/graficamos.
const CAMPOS = [
  'voltaje1', 'voltaje2', 'voltaje3',
  'corriente1', 'corriente2', 'corriente3',
  'potencia1', 'potencia2', 'potencia3',
  'potenciaTotal', 'potenciaReacTotal', 'potenciaApTotal',
  'factorPotencia', 'frecuencia',
  'energiaActivaTotalKwh',   // contador acumulado de energía activa (kWh)
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
    factorPotencia REAL, frecuencia REAL,
    energiaActivaTotalKwh REAL
  );
  CREATE INDEX IF NOT EXISTS idx_lecturas_ts ON lecturas(ts);
`);

// Migración para bases de datos creadas antes de agregar la energía.
const columnasExistentes = db.prepare('PRAGMA table_info(lecturas)').all().map((c) => c.name);
for (const c of CAMPOS) {
  if (!columnasExistentes.includes(c)) {
    db.exec(`ALTER TABLE lecturas ADD COLUMN ${c} REAL`);
    console.log(`[db] columna agregada: ${c}`);
  }
}

const insertStmt = db.prepare(`
  INSERT INTO lecturas (ts, ${CAMPOS.join(', ')})
  VALUES (@ts, ${CAMPOS.map((c) => '@' + c).join(', ')})
`);

function guardarEnHistorico(ts, fields) {
  const row = { ts };
  for (const c of CAMPOS) row[c] = typeof fields[c] === 'number' ? fields[c] : null;
  insertStmt.run(row);
}

// ---- SQLite: histórico de diagnóstico (topic MQTT_TOPIC_DIAG) ----
// Se guarda cada ciclo, igual que las lecturas, para poder exportar el
// historial completo (no sólo el último mensaje, que es lo único que se
// mantenía en memoria hasta ahora).
const DIAG_CAMPOS = [
  'fwVersion', 'uptimeS', 'bootCount', 'motivoReinicio',
  'modbusOK', 'modbusErroresSeguidos', 'modbusBloque2OK', 'modbusFrecuenciaOK',
  'modbusEnergiaOK', 'redRegistrada', 'fallosMQTTSeguidos', 'segSinPublishOK',
];

db.exec(`
  CREATE TABLE IF NOT EXISTS diagnosticos (
    ts INTEGER NOT NULL,
    fwVersion TEXT,
    uptimeS INTEGER,
    bootCount INTEGER,
    motivoReinicio TEXT,
    modbusOK INTEGER,
    modbusErroresSeguidos INTEGER,
    modbusBloque2OK INTEGER,
    modbusFrecuenciaOK INTEGER,
    modbusEnergiaOK INTEGER,
    redRegistrada INTEGER,
    fallosMQTTSeguidos INTEGER,
    segSinPublishOK INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_diag_ts ON diagnosticos(ts);
`);

const insertDiagStmt = db.prepare(`
  INSERT INTO diagnosticos (ts, ${DIAG_CAMPOS.join(', ')})
  VALUES (@ts, ${DIAG_CAMPOS.map((c) => '@' + c).join(', ')})
`);

// better-sqlite3 no liga booleans de JS directamente — los mensajes del
// firmware traen true/false, hay que pasarlos a 0/1 antes del INSERT.
function boolAInt(v) {
  return v === true ? 1 : v === false ? 0 : null;
}

function guardarDiagEnHistorico(ts, fields) {
  insertDiagStmt.run({
    ts,
    fwVersion: fields.fwVersion ?? null,
    uptimeS: typeof fields.uptimeS === 'number' ? fields.uptimeS : null,
    bootCount: typeof fields.bootCount === 'number' ? fields.bootCount : null,
    motivoReinicio: fields.motivoReinicio ?? null,
    modbusOK: boolAInt(fields.modbusOK),
    modbusErroresSeguidos: typeof fields.modbusErroresSeguidos === 'number' ? fields.modbusErroresSeguidos : null,
    modbusBloque2OK: boolAInt(fields.modbusBloque2OK),
    modbusFrecuenciaOK: boolAInt(fields.modbusFrecuenciaOK),
    modbusEnergiaOK: boolAInt(fields.modbusEnergiaOK),
    redRegistrada: boolAInt(fields.redRegistrada),
    fallosMQTTSeguidos: typeof fields.fallosMQTTSeguidos === 'number' ? fields.fallosMQTTSeguidos : null,
    segSinPublishOK: typeof fields.segSinPublishOK === 'number' ? fields.segSinPublishOK : null,
  });
}

function limpiarHistoricoViejo() {
  const limite = Math.floor(Date.now() / 1000) - HISTORY_RETENTION_DAYS * 86400;
  const infoLecturas = db.prepare('DELETE FROM lecturas WHERE ts < ?').run(limite);
  const infoDiag = db.prepare('DELETE FROM diagnosticos WHERE ts < ?').run(limite);
  if (infoLecturas.changes > 0 || infoDiag.changes > 0) {
    console.log(`[db] purgadas ${infoLecturas.changes} lecturas + ${infoDiag.changes} diagnósticos viejos (> ${HISTORY_RETENTION_DAYS} días)`);
  }
}
setInterval(limpiarHistoricoViejo, 6 * 3600 * 1000); // cada 6h

// Trae lecturas/diagnósticos crudos (sin agregar) en un rango de tiempo —
// usado por el export a Excel/CSV. desdeSeg/hastaSeg en epoch segundos.
function consultarLecturasRango(desdeSeg, hastaSeg) {
  return db.prepare(`
    SELECT ts, ${CAMPOS.join(', ')} FROM lecturas
    WHERE ts >= @desde AND ts <= @hasta
    ORDER BY ts ASC
  `).all({ desde: desdeSeg, hasta: hastaSeg });
}

function consultarDiagRango(desdeSeg, hastaSeg) {
  return db.prepare(`
    SELECT ts, ${DIAG_CAMPOS.join(', ')} FROM diagnosticos
    WHERE ts >= @desde AND ts <= @hasta
    ORDER BY ts ASC
  `).all({ desde: desdeSeg, hasta: hastaSeg });
}

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

// Consumo de energía activa por día. energiaActivaTotalKwh es un contador
// acumulado: el consumo del día = máximo - mínimo dentro de ese día (local).
// Se descartan deltas negativos (reset del medidor / valores basura).
function consultarConsumoDiario(dias) {
  const desde = Math.floor(Date.now() / 1000) - (dias + 1) * 86400;
  // Filtro anti-basura: descarta lecturas de energía absurdas (p.ej. las que
  // publicó el firmware antes de corregir el orden de palabra del Int64).
  const filas = db.prepare(`
    SELECT date(ts, 'unixepoch', @tz) AS dia,
           MIN(energiaActivaTotalKwh) AS lo,
           MAX(energiaActivaTotalKwh) AS hi,
           COUNT(energiaActivaTotalKwh) AS n
    FROM lecturas
    WHERE ts >= @desde
      AND energiaActivaTotalKwh IS NOT NULL
      AND energiaActivaTotalKwh >= 0
      AND energiaActivaTotalKwh < 100000000
    GROUP BY dia
    ORDER BY dia ASC
  `).all({ tz: CONSUMO_TZ, desde });

  return filas
    .map((f) => ({
      dia: f.dia,
      consumoKwh: f.hi != null && f.lo != null ? Math.max(0, f.hi - f.lo) : null,
      kwhInicioDia: f.lo,
      lecturas: f.n,
    }))
    .filter((f) => f.consumoKwh !== null)
    .slice(-dias);
}

// ---- Estado en memoria (para /api/latest y el buffer "en vivo") ----
let latest = null; // { fields, ts, receivedAt }
let latestDiag = null; // { fields, receivedAt } — último mensaje de MQTT_TOPIC_DIAG
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
  console.log(`[mqtt] conectado a ${MQTT_URL}, suscribiendo a "${MQTT_TOPIC}" y "${MQTT_TOPIC_DIAG}"`);
  mqttClient.subscribe(MQTT_TOPIC, { qos: 0 }, (err) => {
    if (err) console.error('[mqtt] error al suscribir:', err.message);
  });
  mqttClient.subscribe(MQTT_TOPIC_DIAG, { qos: 0 }, (err) => {
    if (err) console.error('[mqtt] error al suscribir (diag):', err.message);
  });
});
mqttClient.on('reconnect', () => console.log('[mqtt] reconectando...'));
mqttClient.on('close', () => console.log('[mqtt] conexión cerrada'));
mqttClient.on('error', (err) => console.error('[mqtt] error:', err.message));

mqttClient.on('message', (topic, payloadBuf) => {
  let fields;
  try {
    fields = JSON.parse(payloadBuf.toString());
  } catch (err) {
    console.error('[mqtt] no se pudo parsear el payload:', err.message);
    return;
  }

  if (topic === MQTT_TOPIC_DIAG) {
    latestDiag = { fields, receivedAt: Date.now() };
    guardarDiagEnHistorico(Math.floor(latestDiag.receivedAt / 1000), fields);
    broadcastDiag(latestDiag);
    return;
  }

  const reading = pushReading(fields, fields.ts);
  broadcast(reading);
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
    diag: latestDiag ? { ...latestDiag.fields, receivedAt: latestDiag.receivedAt } : null,
  });
});

app.get('/api/latest', (req, res) => {
  if (!latest) return res.status(204).end();
  res.json(latest);
});

// Salud del pipeline reportada por el firmware (Modbus/red/MQTT), topic aparte.
app.get('/api/diag', (req, res) => {
  if (!latestDiag) return res.status(204).end();
  res.json(latestDiag);
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

// Consumo por día (kWh). /api/consumo-diario?dias=14
app.get('/api/consumo-diario', (req, res) => {
  const dias = Math.max(1, Math.min(90, parseInt(req.query.dias, 10) || 14));
  try {
    res.json(consultarConsumoDiario(dias));
  } catch (err) {
    console.error('[db] error consultando consumo diario:', err.message);
    res.status(500).json({ error: 'error consultando consumo diario' });
  }
});

// Exporta el histórico crudo para que el cliente lo baje a su computadora.
// /api/export?formato=xlsx|csv&desde=<epoch_ms>&hasta=<epoch_ms>
// - xlsx: dos hojas, "Lecturas" (voltaje/corriente/potencia/etc.) y
//   "Diagnóstico" (salud del pipeline Modbus/red/MQTT).
// - csv: sólo las lecturas (CSV no soporta varias hojas).
function fechaCorta(tsSeg) {
  return new Date(tsSeg * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

const MAX_RANGO_EXPORT_DIAS = 366;

app.get('/api/export', async (req, res) => {
  const formato = req.query.formato === 'csv' ? 'csv' : 'xlsx';
  const desdeMs = parseInt(req.query.desde, 10);
  const hastaMs = parseInt(req.query.hasta, 10);
  if (!Number.isFinite(desdeMs) || !Number.isFinite(hastaMs) || hastaMs < desdeMs) {
    return res.status(400).json({ error: 'parámetros desde/hasta inválidos (epoch ms)' });
  }
  if (hastaMs - desdeMs > MAX_RANGO_EXPORT_DIAS * 86400 * 1000) {
    return res.status(400).json({ error: `rango máximo: ${MAX_RANGO_EXPORT_DIAS} días` });
  }

  const desde = Math.floor(desdeMs / 1000);
  const hasta = Math.floor(hastaMs / 1000);
  const sufijo = `${fechaCorta(desde)}-${fechaCorta(hasta)}`;

  if (formato === 'csv') {
    const filas = consultarLecturasRango(desde, hasta);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="iem3255_walter01_${sufijo}.csv"`);
    res.write(['fechaHoraUTC', ...CAMPOS].join(',') + '\n');
    for (const f of filas) {
      const linea = [new Date(f.ts * 1000).toISOString(), ...CAMPOS.map((c) => (f[c] ?? ''))];
      res.write(linea.join(',') + '\n');
    }
    return res.end();
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="iem3255_walter01_${sufijo}.xlsx"`);

  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });

    const hojaLecturas = workbook.addWorksheet('Lecturas');
    hojaLecturas.columns = [
      { header: 'Fecha/hora (UTC)', key: 'fechaHora', width: 22 },
      ...CAMPOS.map((c) => ({ header: c, key: c, width: 16 })),
    ];
    for (const f of consultarLecturasRango(desde, hasta)) {
      hojaLecturas.addRow({ fechaHora: new Date(f.ts * 1000).toISOString(), ...pickCampos(f) }).commit();
    }
    hojaLecturas.commit();

    const hojaDiag = workbook.addWorksheet('Diagnóstico');
    hojaDiag.columns = [
      { header: 'Fecha/hora (UTC)', key: 'fechaHora', width: 22 },
      ...DIAG_CAMPOS.map((c) => ({ header: c, key: c, width: 20 })),
    ];
    for (const f of consultarDiagRango(desde, hasta)) {
      const row = { fechaHora: new Date(f.ts * 1000).toISOString() };
      for (const c of DIAG_CAMPOS) row[c] = f[c];
      hojaDiag.addRow(row).commit();
    }
    hojaDiag.commit();

    await workbook.commit();
  } catch (err) {
    console.error('[export] error generando xlsx:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'error generando el archivo' });
    else res.end();
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

function broadcastDiag(diag) {
  const msg = JSON.stringify({ type: 'diag', payload: diag });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', payload: { latest, latestDiag, liveBuffer } }));
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
