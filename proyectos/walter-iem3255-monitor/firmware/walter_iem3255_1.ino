/*
  Walter (Quickspot/DPTechnics, ESP32-S3 + LTE-M/NB-IoT) — Maestro Modbus
  RTU sobre RS-485 para medidor Schneider Electric iEM3255.
  Envía lecturas por celular (SIM Telcel) vía MQTT al broker.
  Sergio Pérez — Tuxtla Gutiérrez, Chiapas

  PINOUT RS-485 (módulo XY-485, auto-dirección):
    IO17 TX → TXD módulo   IO18 RX ← RXD módulo
    3V3 → VCC módulo       GND → GND módulo → GND iEM3255
    A del módulo → txA+ iEM3255    B del módulo → rxB- iEM3255
    Si no hay respuesta del medidor: invierte A↔B.

  LIBRERÍAS: WalterModem (DPTechnics), ModbusMaster (Doc Walker), ArduinoJson
  PLACA: "DPTechnics Walter" — Partition: 2MB APP / 12.5MB FATFS

  REGISTROS CONFIRMADOS (FC03, Float32, orden CDAB):
    I1=3000  I2=3002  I3=3008
    V1=3026  V2=3028  V3=3030
    P1=3052  P2=3054  P3=3056  Ptotal=3058   (unidades: kW)

  REGISTROS PROVISIONALES — confirmar con el scan periódico (ver loop):
    potenciaApTotal   ADDR_S    = 3190   (buscar valor ≈ Ptotal en scan)
    factorPotencia    ADDR_FP   = 3192   (buscar ≈ 1.0 en scan)
    potenciaReacTotal ADDR_Q    = 3194   (buscar ≈ 0.0 en scan)
    frecuencia        ADDR_FREQ = 0      (0 = pendiente; buscar ≈ 60.0)

  NOTA SOBRE EL BUFFER: ModbusMaster tiene buffer de 64 registros.
  El bloque principal cubre 3000–3063. Para valores fuera de ese rango
  se hace un segundo bloque de lectura (3188–3207).

  ─────────────────────────────────────────────────────────────────────────
  ESTABILIDAD DEL ENLACE MQTT (por qué el dashboard se ponía en café):
    Toda llamada a WalterModem puede BLOQUEAR hasta 300 s
    (WALTER_MODEM_CMD_TIMEOUT_MS, no configurable en Arduino). Si el enlace
    LTE-M de Telcel tiene un hueco, modem.mqttPublish() se queda bloqueado,
    el loop se congela (ni lecturas ni publish) y el dashboard cruza su
    umbral de "sin datos". Mitigaciones aquí:
      1. Handlers async (mqttSetEventHandler / setRegistrationEventHandler)
         que marcan la sesión como caída SIN bloquear ni llamar al módem.
      2. Pre-chequeo BARATO (estado cacheado, sin AT) antes de cada publish:
         si la red o la sesión MQTT ya están caídas, no se entra al
         mqttPublish que bloquea 300 s.
      3. Recuperación rápida: reconexión MQTT ligera (config+connect) si el
         módem sigue registrado; init completo sólo si se perdió la red;
         ESP.restart() sólo como último recurso.
      4. Diagnóstico por serial cada ciclo (IP PDP, RSRP/RSRQ/RSSI, estado
         de red y MQTT, segundos desde el último publish OK) para saber si
         el problema es APN, cobertura o NAT/sesión.
*/

#include <WalterModem.h>
#include <ModbusMaster.h>
#include <ArduinoJson.h>

// ═══ CONFIGURA AQUÍ ════════════════════════════════════════════════════════
#define MODBUS_SLAVE_ID      1
#define MODBUS_BAUD          9600
#define APN_TELCEL           "m2m.itelcel.com"

#define MQTT_HOST            "mqtt.ocean53.xyz"
#define MQTT_PORT            1883
#define MQTT_USER            "sergio"
#define MQTT_PASS            "pegs530112"
#define MQTT_TOPIC           "iem3255/walter01/state"
#define MQTT_CLIENT_ID       "walter-iem3255-01"
// keepAlive corto: publicamos cada 30 s, así el PINGREQ del módem cae dentro
// de ese ritmo y una sesión muerta se detecta rápido (URC de desconexión).
#define MQTT_KEEPALIVE_S     60

#define INTERVALO_LECTURA_MS 30000
#define RECONEXION_MS        15000   // reintento de enlace tras caída (rápido)
#define MAX_RECONEXIONES     4       // tras N reintentos fallidos → ESP.restart()
// ═══════════════════════════════════════════════════════════════════════════

#define RS485_TX  17
#define RS485_RX  18

// Bloque 1: valores confirmados (≤ 64 registros)
#define REG_BASE   3000
#define REG_COUNT  64    // cubre 3000–3063

// Bloque 2: FP y Q (confirmados en scan, base 3180 que es la que funcionó)
#define REG2_BASE  3180
#define REG2_COUNT 20    // cubre 3180–3199

// Confirmados: FP=3192, Q=3194, FREQ=3108
// Pendiente: S — buscar valor ≈ Ptotal (≈0.30) en scan
#define ADDR_FP   3192
#define ADDR_Q    3194
#define ADDR_S    0      // 0 = pendiente
#define ADDR_FREQ 3108   // confirmado: 60.0 Hz

// ── Energía (consumo acumulado) ─────────────────────────────────────────────
// Mapa Modbus oficial iEM3000 series (FC03, Int64 = 4 registros, unidad Wh):
//   3204  Energía Activa TOTAL entregada (import / consumo)  ← el que quieres
//   3208  Energía Activa total recibida (export)
//   3220  Energía Reactiva total entregada        (varh)
//   3232  Energía Aparente total                  (VAh)
//   3256  Energía Activa PARCIAL (reseteable)
// kWh = valor / 1000.
// ORDEN DE PALABRA (confirmado contra display = 5.467 kWh):
//   64 bits = [palabra 32b ALTA][palabra 32b BAJA], y cada palabra de 32 bits
//   viene con el word bajo primero (CDAB), igual que los float de V/I/P.
//   → hi32 = reg[1]<<16 | reg[0]      lo32 = reg[3]<<16 | reg[2]
//     valor = hi32 * 2^32 + lo32
#define ADDR_ENERGIA_ACT_TOT  3204

HardwareSerial RS485Serial(1);
ModbusMaster   node;
WalterModem    modem;
WalterModemRsp modemRsp = {};

unsigned long ultimaLectura      = 0;
unsigned long ultimoIntentoModem = 0;
unsigned long ultimoPublishOK    = 0;   // millis del último publish exitoso
bool     mqttListo           = false;
uint8_t  fallosMQTT          = 0;       // publish fallidos consecutivos
uint8_t  reconexionesFallidas = 0;      // intentos de re-enlace consecutivos fallidos

// Flags puestos por los handlers async del módem. Los handlers NO pueden
// llamar funciones de WalterModem ni bloquear: sólo marcan bandera.
volatile bool evtMqttDesconectado = false;
volatile bool evtRedPerdida       = false;

struct LecturaIEM3255 {
  float corriente1, corriente2, corriente3;
  float voltaje1, voltaje2, voltaje3;
  float potencia1, potencia2, potencia3;
  float potenciaTotal, potenciaReacTotal, potenciaApTotal;
  float factorPotencia, frecuencia;
  double energiaActivaTotal;   // kWh acumulados (consumo)
  bool  energiaValida;
  bool  valida;
} lectura;

// ─── Float32 CDAB desde el buffer activo ─────────────────────────────────
float leerFloatCDAB(uint16_t base, uint16_t addr) {
  uint16_t off = addr - base;
  uint32_t raw = ((uint32_t)node.getResponseBuffer(off + 1) << 16)
                           | node.getResponseBuffer(off);
  float v; memcpy(&v, &raw, 4);
  return v;
}

// ─── Int64 desde el buffer activo (4 registros de 16 bits) ────────────────
// Este medidor: dos palabras de 32 bits (alta, baja), cada una CDAB
// (word bajo primero), igual que los float. Confirmado contra el display.
uint64_t leerU64(uint16_t base, uint16_t addr) {
  uint16_t o = addr - base;
  uint32_t hi = ((uint32_t)node.getResponseBuffer(o + 1) << 16) | node.getResponseBuffer(o);
  uint32_t lo = ((uint32_t)node.getResponseBuffer(o + 3) << 16) | node.getResponseBuffer(o + 2);
  return ((uint64_t)hi << 32) | lo;
}

// ─── Valida que un float del medidor sea publicable ───────────────────────
bool esValido(float v) {
  return !isnan(v) && !isinf(v);
}

// ─── Lee todas las medidas ────────────────────────────────────────────────
bool leerIEM3255() {
  // — Bloque 1: I, V, P (3000–3063) ——————————————————————————————————————
  if (node.readHoldingRegisters(REG_BASE, REG_COUNT) != node.ku8MBSuccess) {
    Serial.println("[Modbus] Error bloque 1");
    lectura.valida = false;
    return false;
  }
  lectura.corriente1    = leerFloatCDAB(REG_BASE, 3000);
  lectura.corriente2    = leerFloatCDAB(REG_BASE, 3002);
  lectura.corriente3    = leerFloatCDAB(REG_BASE, 3008);
  lectura.voltaje1      = leerFloatCDAB(REG_BASE, 3026);
  lectura.voltaje2      = leerFloatCDAB(REG_BASE, 3028);
  lectura.voltaje3      = leerFloatCDAB(REG_BASE, 3030);
  lectura.potencia1     = leerFloatCDAB(REG_BASE, 3052);
  lectura.potencia2     = leerFloatCDAB(REG_BASE, 3054);
  lectura.potencia3     = leerFloatCDAB(REG_BASE, 3056);
  lectura.potenciaTotal = leerFloatCDAB(REG_BASE, 3058);

  // — Bloque 2: S, FP, Q (provisionales en 3188–3197) ————————————————————
  delay(100);
  lectura.potenciaApTotal   = NAN;
  lectura.factorPotencia    = NAN;
  lectura.potenciaReacTotal = NAN;
  lectura.frecuencia        = NAN;

  if (node.readHoldingRegisters(REG2_BASE, REG2_COUNT) == node.ku8MBSuccess) {
    lectura.factorPotencia    = leerFloatCDAB(REG2_BASE, ADDR_FP);
    lectura.potenciaReacTotal = leerFloatCDAB(REG2_BASE, ADDR_Q);
    if (ADDR_S > 0) {
      lectura.potenciaApTotal = leerFloatCDAB(REG2_BASE, ADDR_S);
    } else {
      // S = sqrt(P² + Q²) — equivalente al valor del registro para cualquier carga
      lectura.potenciaApTotal = sqrtf(
        lectura.potenciaTotal     * lectura.potenciaTotal +
        lectura.potenciaReacTotal * lectura.potenciaReacTotal);
    }
  } else {
    Serial.println("[Modbus] Error bloque 2 (FP/Q)");
  }

  // — Frecuencia: bloque 3106-3109 (4 regs, cubre ADDR_FREQ=3108) ————————
  delay(100);
  if (node.readHoldingRegisters(3106, 4) == node.ku8MBSuccess) {
    lectura.frecuencia = leerFloatCDAB(3106, ADDR_FREQ);
  } else {
    Serial.println("[Modbus] Error bloque frecuencia");
  }

  // — Energía Activa Total (consumo): Int64 en 3204-3207, unidad Wh ————————
  delay(100);
  lectura.energiaValida = false;
  if (node.readHoldingRegisters(ADDR_ENERGIA_ACT_TOT, 4) == node.ku8MBSuccess) {
    uint64_t wh = leerU64(ADDR_ENERGIA_ACT_TOT, ADDR_ENERGIA_ACT_TOT);
    lectura.energiaActivaTotal = wh / 1000.0;
    lectura.energiaValida = true;
    Serial.printf("[Energía] raw: %04X %04X %04X %04X  => %.3f kWh\n",
      node.getResponseBuffer(0), node.getResponseBuffer(1),
      node.getResponseBuffer(2), node.getResponseBuffer(3),
      lectura.energiaActivaTotal);
  } else {
    Serial.println("[Modbus] Error bloque energía (3204)");
  }

  lectura.valida = true;

  Serial.println("─────────────────────────────────────");
  Serial.printf("V1=%.2fV  V2=%.2fV  V3=%.2fV\n",
    lectura.voltaje1, lectura.voltaje2, lectura.voltaje3);
  Serial.printf("I1=%.3fA  I2=%.3fA  I3=%.3fA\n",
    lectura.corriente1, lectura.corriente2, lectura.corriente3);
  Serial.printf("Ptotal=%.4fkW  Q=%.4f  S=%.4f  FP=%.4f  f=%.2fHz\n",
    lectura.potenciaTotal, lectura.potenciaReacTotal,
    lectura.potenciaApTotal, lectura.factorPotencia, lectura.frecuencia);
  if (lectura.energiaValida)
    Serial.printf("Energía activa total = %.3f kWh\n", lectura.energiaActivaTotal);
  Serial.println("─────────────────────────────────────");
  return true;
}

// ─── JSON ─────────────────────────────────────────────────────────────────
String armarPayloadJSON() {
  JsonDocument doc;
  doc["dispositivo"]   = MQTT_CLIENT_ID;
  doc["ts"]            = millis();
  doc["voltaje1"]      = lectura.voltaje1;
  doc["voltaje2"]      = lectura.voltaje2;
  doc["voltaje3"]      = lectura.voltaje3;
  doc["corriente1"]    = lectura.corriente1;
  doc["corriente2"]    = lectura.corriente2;
  doc["corriente3"]    = lectura.corriente3;
  doc["potencia1"]     = lectura.potencia1;
  doc["potencia2"]     = lectura.potencia2;
  doc["potencia3"]     = lectura.potencia3;
  doc["potenciaTotal"] = lectura.potenciaTotal;
  if (esValido(lectura.potenciaReacTotal)) doc["potenciaReacTotal"] = lectura.potenciaReacTotal;
  if (esValido(lectura.potenciaApTotal))   doc["potenciaApTotal"]   = lectura.potenciaApTotal;
  if (esValido(lectura.factorPotencia))    doc["factorPotencia"]    = lectura.factorPotencia;
  if (esValido(lectura.frecuencia))        doc["frecuencia"]        = lectura.frecuencia;
  if (lectura.energiaValida)               doc["energiaActivaTotalKwh"] = lectura.energiaActivaTotal;
  String s; serializeJson(doc, s); return s;
}

// ─── Scan periódico (cada 60 s) para identificar registros faltantes ──────
// Buscar en la salida: ≈60.0 Hz (frecuencia), ≈Ptotal (S), ≈1.0 (FP), ≈0 (Q)
// Una vez identificados, actualiza ADDR_S/FP/Q/FREQ arriba y quita el scan.
void escanearBloque(uint16_t desde, uint16_t n) {
  delay(80);
  Serial.printf("  [%u-%u]", desde, desde + n - 1);
  if (node.readHoldingRegisters(desde, n) != node.ku8MBSuccess) {
    Serial.println(" ERR");
    return;
  }
  Serial.println();
  for (uint16_t i = 0; i + 1 < n; i += 2) {
    uint16_t lo = node.getResponseBuffer(i);
    uint16_t hi = node.getResponseBuffer(i + 1);
    if (lo == 0xFFFF && hi == 0xFFFF) continue;
    uint32_t raw = ((uint32_t)hi << 16) | lo;
    float v; memcpy(&v, &raw, 4);
    Serial.printf("    @%u: %04X %04X => %.4f\n", desde + i, lo, hi, v);
  }
}

// Vuelca un bloque interpretando cada 4 registros como Int64 (energía),
// en los dos órdenes de palabra, en kWh (÷1000). Comparar con el display.
void escanearEnergia(uint16_t desde, uint16_t n) {
  delay(80);
  Serial.printf("  [%u-%u] Int64/kWh\n", desde, desde + n - 1);
  if (node.readHoldingRegisters(desde, n) != node.ku8MBSuccess) {
    Serial.println("   ERR");
    return;
  }
  for (uint16_t i = 0; i + 3 < n; i += 2) {
    uint16_t w0 = node.getResponseBuffer(i),     w1 = node.getResponseBuffer(i + 1);
    uint16_t w2 = node.getResponseBuffer(i + 2), w3 = node.getResponseBuffer(i + 3);
    if (!(w0 | w1 | w2 | w3)) continue;
    // orden de este medidor: hi32 = w1:w0 (CDAB), lo32 = w3:w2 (CDAB)
    uint64_t hi = ((uint32_t)w1 << 16) | w0;
    uint64_t lo = ((uint32_t)w3 << 16) | w2;
    uint64_t v  = (hi << 32) | lo;
    Serial.printf("    @%u: %04X %04X %04X %04X  => %.3f kWh\n",
      desde + i, w0, w1, w2, w3, v / 1000.0);
  }
}

void ejecutarScan() {
  // Ptotal actual (referencia para reconocer S en el scan)
  float ptotal = lectura.valida ? lectura.potenciaTotal : 0;
  Serial.printf("\n>>>>> SCAN — Ptotal=%.4f  buscar: S≈%.4f  f≈60.0 <<<<<\n",
                ptotal, ptotal);
  // Gaps dentro del bloque principal (pueden tener S)
  Serial.println("-- gaps 3004-3025 y 3032-3051 --");
  escanearBloque(3004, 22);
  escanearBloque(3032, 20);
  // Energía acumulada — comparar con el total kWh del display del medidor
  Serial.println("-- energía 3204-3243 (Int64) --");
  escanearEnergia(3204, 40);
  // 0-59 AL FINAL para que siempre sea visible
  Serial.println("-- 0-59 --");
  escanearBloque(0,  30);
  escanearBloque(30, 30);
  Serial.println(">>>>> FIN SCAN <<<<<\n");
}

// ─── Handlers async del módem ─────────────────────────────────────────────
// OJO: no llamar funciones de WalterModem aquí ni hacer nada bloqueante.
// Sólo marcan bandera; el loop actúa sobre ellas.
void onMqttEvent(WalterModemMQTTEvent ev, WalterModemMqttStatus status, void* args) {
  if (ev == WALTER_MODEM_MQTT_EVENT_DISCONNECTED) evtMqttDesconectado = true;
}

void onRegEvent(WalterModemNetworkRegState st, void* args) {
  bool ok = (st == WALTER_MODEM_NETWORK_REG_REGISTERED_HOME ||
             st == WALTER_MODEM_NETWORK_REG_REGISTERED_ROAMING);
  if (!ok) evtRedPerdida = true;
}

// ─── Módem ────────────────────────────────────────────────────────────────
bool redRegistrada() {
  WalterModemNetworkRegState s = modem.getNetworkRegState();
  return (s == WALTER_MODEM_NETWORK_REG_REGISTERED_HOME ||
          s == WALTER_MODEM_NETWORK_REG_REGISTERED_ROAMING);
}

// Diagnóstico por serial: distingue si el problema es APN, cobertura o
// NAT/sesión. Los estados cacheados (regState, mqttStatus) son gratis; las
// consultas AT (IP, celda) sólo se hacen si el módem está registrado, para
// no encolar comandos sobre un módem ya atascado.
void logDiagnostico() {
  unsigned long ahora = millis();
  Serial.printf("\n[%lu] ── DIAG ─────────────────────────────\n", ahora);
  Serial.printf("  uptime %lus  mqttListo=%s  fallosPub=%u  reconFail=%u\n",
    ahora / 1000, mqttListo ? "si" : "no", fallosMQTT, reconexionesFallidas);
  if (ultimoPublishOK)
    Serial.printf("  último publish OK: hace %lus\n", (ahora - ultimoPublishOK) / 1000);
  else
    Serial.println("  último publish OK: nunca");

  WalterModemNetworkRegState rs = modem.getNetworkRegState();
  Serial.printf("  regState=%d (%s)   mqttStatus=%d\n",
    (int)rs, redRegistrada() ? "registrado" : "NO registrado",
    (int)modem.getMqttStatus());

  if (redRegistrada()) {
    static WalterModemRsp rsp = {};
    const char* ip = NULL;
    if (modem.getPDPAddress(&rsp)) ip = rsp.data.pdpAddressList.pdpAddress;
    Serial.printf("  IP PDP: %s\n", (ip && ip[0]) ? ip : "(SIN IP — revisar APN/plan)");

    if (modem.getCellInformation(WALTER_MODEM_SQNMONI_REPORTS_SERVING_CELL, &rsp)) {
      Serial.printf("  celda: banda %u  op %s  RSRP %.1fdBm  RSRQ %.1fdB  RSSI %.1f  CINR %.1f\n",
        rsp.data.cellInformation.band, rsp.data.cellInformation.netName,
        rsp.data.cellInformation.rsrp, rsp.data.cellInformation.rsrq,
        rsp.data.cellInformation.rssi, rsp.data.cellInformation.cinr);
    } else {
      Serial.println("  celda: (sin datos)");
    }
  } else {
    Serial.println("  (módem no registrado — se omiten consultas AT)");
  }
  Serial.println("  ─────────────────────────────────────");
}

// Secuencia EXACTA de los ejemplos oficiales de WalterModem.
// El orden importa: sin setOpState(NO_RF) antes de definePDPContext y sin
// setNetworkSelectionMode(AUTOMATIC) después de FULL, el módem se registra
// en la celda pero NUNCA completa el attach de datos → mqttConnect/mqttPublish
// se quedan bloqueados hasta 5-15 min esperando un URC que jamás llega.
bool inicializarModem() {
  mqttListo = false;

  // watchdogTimeout=30 → la librería lo sube a ~305 s; si una llamada del
  // módem se bloquea más que eso, el ESP reinicia en vez de congelarse.
  if (!WalterModem::begin(&Serial2, 30))
    { Serial.println("[Modem] No inicializa"); return false; }

  // Handlers async (idempotente: sólo fija punteros). Detectan caídas de
  // red / MQTT sin que el loop tenga que sondear al módem.
  modem.mqttSetEventHandler(onMqttEvent);
  modem.setRegistrationEventHandler(onRegEvent);
  evtMqttDesconectado = false;
  evtRedPerdida       = false;

  if (!modem.setOpState(WALTER_MODEM_OPSTATE_NO_RF))
    { Serial.println("[Modem] Error NO_RF"); return false; }

  if (!modem.definePDPContext(1, APN_TELCEL, &modemRsp))
    { Serial.println("[Modem] Error PDP"); return false; }

  if (!modem.setOpState(WALTER_MODEM_OPSTATE_FULL))
    { Serial.println("[Modem] Error FULL"); return false; }

  if (!modem.setNetworkSelectionMode(WALTER_MODEM_NETWORK_SEL_MODE_AUTOMATIC))
    { Serial.println("[Modem] Error selección de red"); return false; }

  Serial.println("[Modem] Esperando registro en red Telcel...");
  unsigned long t0 = millis();
  while (!redRegistrada()) {
    delay(1000); Serial.print(".");
    modem.tickleWatchdog();
    if (millis() - t0 > 300000UL)
      { Serial.println("\n[Modem] Timeout registro"); return false; }
  }
  Serial.println("\n[Modem] Registrado");

  // Confirmar que hay IP (PDP activo) antes de tocar MQTT
  const char* ip = NULL;
  if (modem.getPDPAddress(&modemRsp)) ip = modemRsp.data.pdpAddressList.pdpAddress;
  if (ip && ip[0]) {
    Serial.printf("[Modem] IP: %s\n", ip);
  } else {
    Serial.println("[Modem] Sin IP — activando PDP...");
    modem.setPDPContextActive(true);
  }

  if (!modem.mqttConfig(MQTT_CLIENT_ID, MQTT_USER, MQTT_PASS))
    { Serial.println("[MQTT] Error config"); return false; }
  if (!modem.mqttConnect(MQTT_HOST, MQTT_PORT, MQTT_KEEPALIVE_S))
    { Serial.println("[MQTT] Error conectando"); return false; }

  Serial.println("[MQTT] Conectado");
  mqttListo            = true;
  fallosMQTT           = 0;
  reconexionesFallidas = 0;
  ultimoPublishOK      = millis();
  return true;
}

// Reconexión MQTT ligera: sólo config + connect, SIN reinicializar el módem
// ni ciclar la radio. Vale la pena sólo si el módem sigue registrado (si no,
// mqttConnect se bloquearía los 300 s esperando la red).
bool reconectarMQTT() {
  if (!redRegistrada()) return false;
  Serial.println("[MQTT] Reconexión ligera (módem sigue en red)...");
  modem.mqttDisconnect();
  if (!modem.mqttConfig(MQTT_CLIENT_ID, MQTT_USER, MQTT_PASS)) return false;
  if (!modem.mqttConnect(MQTT_HOST, MQTT_PORT, MQTT_KEEPALIVE_S)) return false;
  Serial.println("[MQTT] Reconectado");
  mqttListo            = true;
  fallosMQTT           = 0;
  reconexionesFallidas = 0;
  ultimoPublishOK      = millis();
  return true;
}

// Marca la sesión como caída para que el loop dispare la recuperación.
void marcarEnlaceCaido(const char* motivo) {
  Serial.printf("[MQTT] Enlace caído: %s → recuperación\n", motivo);
  mqttListo = false;
  ultimoIntentoModem = millis() - RECONEXION_MS;  // que reintente ya en el próximo loop
}

bool publicarMQTT() {
  if (!mqttListo) return false;

  // Pre-chequeo BARATO (estado cacheado, sin AT): si ya sabemos que el
  // enlace está caído, NO entrar al mqttPublish que bloquea hasta 300 s.
  if (evtMqttDesconectado) { evtMqttDesconectado = false; marcarEnlaceCaido("URC desconexión MQTT"); return false; }
  if (evtRedPerdida)       { evtRedPerdida = false;       marcarEnlaceCaido("URC pérdida de red");   return false; }
  if (!redRegistrada())    { marcarEnlaceCaido("red no registrada"); return false; }
  WalterModemMqttStatus st = modem.getMqttStatus();
  if (st == WALTER_MODEM_MQTT_NO_CONN || st == WALTER_MODEM_MQTT_CONN_LOST) {
    marcarEnlaceCaido("mqttStatus sin conexión"); return false;
  }

  String p = armarPayloadJSON();
  Serial.printf("[%lu] [MQTT] %s\n", millis(), p.c_str());

  if (modem.mqttPublish(MQTT_TOPIC, (uint8_t*)p.c_str(), p.length(), 1)) {
    fallosMQTT      = 0;
    ultimoPublishOK = millis();
    return true;
  }

  fallosMQTT++;
  Serial.printf("[MQTT] Publish falló (%u/2)\n", fallosMQTT);
  // A los 2 fallos seguidos damos la sesión por muerta y pasamos a
  // recuperación (reconexión ligera → init completo → restart).
  if (fallosMQTT >= 2) {
    marcarEnlaceCaido("2 publish fallidos");
    fallosMQTT = 0;
  }
  return false;
}

// ─── Setup / Loop ─────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("\n=== Walter iEM3255 arrancando ===");

  RS485Serial.begin(MODBUS_BAUD, SERIAL_8N1, RS485_RX, RS485_TX);
  node.begin(MODBUS_SLAVE_ID, RS485Serial);

  leerIEM3255();

  if (!inicializarModem())
    Serial.println("[Modem] Fallo — reintentará en el loop.");
}

void loop() {
  modem.tickleWatchdog();
  unsigned long ahora = millis();

  // Reaccionar a los eventos async aunque no toque publicar todavía.
  if (mqttListo && evtMqttDesconectado) { evtMqttDesconectado = false; marcarEnlaceCaido("URC desconexión MQTT"); }
  if (mqttListo && evtRedPerdida)       { evtRedPerdida = false;       marcarEnlaceCaido("URC pérdida de red");   }

  // Recuperación del enlace (sin bloquear el ritmo de lecturas).
  if (!mqttListo && ahora - ultimoIntentoModem >= RECONEXION_MS) {
    ultimoIntentoModem = ahora;

    if (reconexionesFallidas >= MAX_RECONEXIONES) {
      Serial.println("[Modem] Demasiados reintentos — reiniciando...");
      delay(200);
      ESP.restart();
    }

    Serial.printf("[Modem] Recuperando enlace (intento %u/%u)...\n",
      reconexionesFallidas + 1, MAX_RECONEXIONES);
    bool ok = redRegistrada() ? reconectarMQTT() : false;
    if (!ok) ok = inicializarModem();      // camino completo si la ligera falla
    if (!ok) reconexionesFallidas++;
  }

  if (ahora - ultimaLectura >= INTERVALO_LECTURA_MS) {
    ultimaLectura = ahora;
    logDiagnostico();
    if (leerIEM3255()) publicarMQTT();
  }
}
