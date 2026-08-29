/*
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║  Walter (Quickspot/DPTechnics, ESP32-S3 + LTE-M/NB-IoT) — Maestro Modbus  ║
  ║  RTU sobre RS-485 para medidor Schneider Electric iEM3255                ║
  ║  Envía lecturas por celular (SIM Telcel) vía MQTT/TLS al droplet         ║
  ║  Sergio Pérez — Tuxtla Gutiérrez, Chiapas                                 ║
  ╚══════════════════════════════════════════════════════════════════════════╝

  ─────────────────────────────────────────────────────────────────────────
  📌 PINOUT RS-485 — referencia rápida
     Módulo: "Convertidor TTL a RS485 XY-485" (4 hilos: VCC, TXD, RXD, GND).
     CONFIRMADO por ficha técnica: conversión bidireccional automática
     (transparente, sin DE/RE que controlar) y compatible con lógica de
     3.3V y 5V — por eso se conecta directo al Walter sin level shifter.
     Modo: RS-485 semidúplex/half-duplex (un solo par A/B, un sentido de
     transmisión a la vez). Conexión directa Walter ↔ iEM3255, punto a
     punto, sin otros esclavos en el bus.
  ─────────────────────────────────────────────────────────────────────────

    Walter (pin header)      →   Módulo XY-485           →   iEM3255
    ──────────────────────       (auto-dirección,              ─────────
                                   3.3V/5V compatible)
    IO17  (pin 21) ── TX ──────► TXD (entrada, dato del Walter)
    IO18  (pin 22) ◄─ RX ─────── RXD (salida, dato hacia el Walter)
    3V3   (pin 26) ───────────► VCC  (el módulo acepta 3.3V directo, no
                                       hace falta fuente externa de 5V)
    GND   (pin 27) ───────────► GND ─────────────────────────► GND común
                                  A   ───────────────────────► "txA+"
                                  B   ───────────────────────► "rxB-"

    * Auto-dirección real (no como el MAX485 crudo que se había asumido
      antes): el módulo detecta solo cuándo transmitir y cuándo recibir,
      así que no hay pin de dirección que conectar ni controlar desde el
      Walter — el código no usa IO16 para esto (ver más abajo).
    * El módulo trae un puente/jumper "R0" para activar su resistencia de
      terminación de 120Ω integrada. Como es un bus punto a punto de solo
      2 nodos (Walter y medidor), actívala en ambos extremos si el cable
      es largo (unos metros o más); en distancias muy cortas de banco de
      pruebas normalmente ni se nota la diferencia.
    * Si no hay respuesta del medidor, primero invierte A↔B — es el fallo
      de cableado RS-485 más común.
    * El iEM3255 se alimenta aparte (24VDC típico) — el Walter no lo energiza.

  LIBRERÍAS REQUERIDAS (Arduino IDE → Tools → Manage Libraries):
    "WalterModem"   by DPTechnics / Quickspot   ← LTE-M/NB-IoT + MQTT
    "ModbusMaster"  by Doc Walker (4-20ma)       ← Maestro Modbus RTU
    "ArduinoJson"   by Benoit Blanchon           ← Armado del payload JSON

  ARDUINO IDE — Board: "DPTechnics Walter" (buscar así en el selector de placas)
    Flash Size / Partition Scheme : (2MB APP/12.5MB FATFS)
      ← OBLIGATORIO así, según doc oficial, para permitir actualizar el
        firmware del módem por OTA. Si no aparece la placa "DPTechnics
        Walter" en el selector, instala primero su paquete de placas desde
        Tools → Board → Boards Manager buscando "walter" (o revisa
        https://www.quickspot.io/documentation.html por la URL exacta del
        board manager — no la encontré documentada de forma pública al
        momento de escribir esto, verifícala tú directo en la IDE).

  ─────────────────────────────────────────────────────────────────────────
  ⚠️  ANTES DE COMPILAR — MUY IMPORTANTE
  ─────────────────────────────────────────────────────────────────────────
  Las funciones de MQTT/PDP de WalterModem (mqttConnect, mqttPublish,
  definePDPContext, etc.) cambiaron de firma entre versiones de la
  librería (v1.2 → v1.4 tuvieron cambios que rompen compatibilidad).
  Escribí este bloque con la API tal como la documenta Quickspot, pero
  NO pude verificarla contra el código fuente exacto de la versión que
  se instale en tu máquina (GitHub la bloqueó por robots.txt al
  consultarla). Antes de flashear:

    1. Instala la librería WalterModem desde el Library Manager.
    2. Abre File → Examples → WalterModem → (ejemplo de MQTT).
    3. Compara la sección `publicarMQTT()` de este archivo contra ese
       ejemplo — si cambió algún nombre de función o el orden de los
       parámetros, ajústalo ahí. Es la única parte de este archivo que
       no pude confirmar al 100%.

  La lectura Modbus (lo que de verdad necesitas para "checar que esté
  sacando los datos") NO depende de esto: puedes compilar y probar solo
  esa parte por USB/Serial aunque la parte celular/MQTT aún no compile,
  comentando la línea de publicarMQTT() en loop().

  ─────────────────────────────────────────────────────────────────────────
  CONEXIONES — RS-485 (medidor iEM3255)
  ─────────────────────────────────────────────────────────────────────────
    UART1 (por software, pines libres del header — UART0/Serial2 quedan
    reservados: Serial = USB-CDC nativo para depurar, Serial2 lo usa
    internamente la librería WalterModem para hablar con el módem Sequans)

      Walter IO17 (pin 21 header) ──TX──► TXD del módulo XY-485
      Walter IO18 (pin 22 header) ◄──RX── RXD del módulo XY-485
      Walter 3V3  (pin 26)        ──────► VCC del módulo (confirmado
                                            compatible 3.3V/5V — conexión
                                            directa, sin level shifter)
      Walter GND  (pin 27)        ──────► GND del módulo (y GND común con
                                            el iEM3255)

      Este módulo SÍ es de auto-dirección (conversión bidireccional
      automática, confirmado por ficha técnica) — no lleva DE/RE, así que
      no hay pin de dirección que conectar ni controlar desde el Walter.

      Módulo A ─────────────────────────► terminal "txA+" del iEM3255
      Módulo B ─────────────────────────► terminal "rxB-" del iEM3255
                                          (activa el jumper R0 del módulo
                                          si el cable es largo — ver nota
                                          de terminación 120Ω arriba)

      Nota: aunque el medidor rotule sus terminales como "txA+"/"rxB-" (una
      nomenclatura heredada de RS-422 full-duplex), en RS-485 half-duplex
      esto es simplemente el par diferencial A/B del bus — no hay TX/RX
      separados. Si al probar no hay respuesta del medidor, lo primero que
      hay que intentar es invertir A↔B: es el error de cableado RS-485 más
      común y no daña nada probarlo.

    El iEM3255 necesita su propia alimentación (24VDC típico, revisa tu
    modelo) — el Walter NO lo alimenta.

  ─────────────────────────────────────────────────────────────────────────
  PARÁMETROS DEL PUERTO SERIAL DEL MEDIDOR
  ─────────────────────────────────────────────────────────────────────────
    Verifica en el menú del iEM3255 (o con el software de configuración)
    los parámetros de comunicación configurados: dirección esclavo,
    baudrate, paridad. Dejo 9600 8N1 como valor por defecto de fábrica
    típico de la familia iEM3xxx, pero CONFÍRMALO en tu unidad — si no
    coincide exactamente no vas a obtener respuesta del medidor.

  ─────────────────────────────────────────────────────────────────────────
  MAPA DE REGISTROS — FC03 (Read Holding Registers), Float32, orden CDAB
  ─────────────────────────────────────────────────────────────────────────
  CDAB = palabra baja (LSW) primero, palabra alta (MSW) después; cada
  palabra en big-endian (estándar Modbus). Confirmado por ti contra
  simulador y medidor real para voltaje/frecuencia; el resto los tomo
  tal como los diste.

    Campo                 Dirección Modicon   Registro real (−400000)
    ────────────────────  ─────────────────   ────────────────────────
    corriente1 (L1)             403000               3000
    corriente2 (L2)             403002               3002
    corriente3 (L3)             403008               3008   ← nota: no
        sigue el patrón +2 de corriente1/2 (esperarías 3004). Lo dejo
        tal como lo diste, pero te sugiero confirmarlo con el mismo
        método que usaste para voltaje/frecuencia (simulador + medidor
        real) antes de confiar en el valor de fase C.
    voltaje1 (L1-N)             403026               3026
    voltaje2 (L2-N)             403028               3028
    voltaje3 (L3-N)             403030               3030
    potencia1 (P activa L1)     403052               3052
    potencia2 (P activa L2)     403054               3054
    potencia3 (P activa L3)     403056               3056
    potenciaTotal (P activa)    403058               3058
    potenciaReacTotal (P react) 403066               3066
    potenciaApTotal (P aparente)403074               3074
    factorPotencia               403082               3082
    frecuencia                   403108               3108

  Todos caen dentro del rango 3000–3109 → se leen en UN solo bloque de
  110 registros (máximo permitido por Modbus es 125), más eficiente que
  14 lecturas separadas.
*/

#include <WalterModem.h>
#include <ModbusMaster.h>
#include <ArduinoJson.h>

// ═══ CONFIGURA AQUÍ ═══════════════════════════════════════════════════════
#define MODBUS_SLAVE_ID     1              // dirección esclavo del iEM3255
#define MODBUS_BAUD         9600           // ← confirma en el menú del medidor
#define APN_TELCEL          "m2m.itelcel.com"

#define MQTT_HOST           "mqtt.ocean53.xyz"
#define MQTT_PORT           1883
#define MQTT_USER           "sergio"
#define MQTT_PASS           "pegs530112"
#define MQTT_TOPIC          "iem3255/walter01/state"
#define MQTT_CLIENT_ID      "walter-iem3255-01"

#define INTERVALO_LECTURA_MS  30000         // cada cuánto lee + publica
// ═══════════════════════════════════════════════════════════════════════════

// ─── Pines RS-485 (UART1 por software) ─────────────────────────────────────
// Módulo XY-485: auto-dirección, no hay pin DE/RE que definir.
#define RS485_TX     17
#define RS485_RX     18

#define REG_BASE   3000
#define REG_COUNT  110   // cubre 3000..3109 inclusive

HardwareSerial RS485Serial(1);
ModbusMaster node;

WalterModem modem;
WalterModemRsp modemRsp = {};

unsigned long ultimaLectura = 0;

// ─── Estructura con la última lectura válida ───────────────────────────────
struct LecturaIEM3255 {
  float corriente1, corriente2, corriente3;
  float voltaje1, voltaje2, voltaje3;
  float potencia1, potencia2, potencia3;
  float potenciaTotal, potenciaReacTotal, potenciaApTotal;
  float factorPotencia;
  float frecuencia;
  bool valida;
} lectura;

// ─── Control de dirección RS-485 ────────────────────────────────────────────
// No se necesita: el módulo XY-485 hace conversión bidireccional automática
// (confirmado por ficha técnica). Si en el futuro cambias a un módulo con
// DE/RE manual, agrega de vuelta:
//
//   #define RS485_DE_RE  16   // (o el pin libre que uses)
//   void preTransmission()  { digitalWrite(RS485_DE_RE, HIGH); delayMicroseconds(50); }
//   void postTransmission() { digitalWrite(RS485_DE_RE, LOW); }
//
// ...y en setup(): pinMode(RS485_DE_RE, OUTPUT) + digitalWrite(..., LOW),
// más las dos líneas node.preTransmission()/node.postTransmission() que
// están comentadas más abajo.

// ─── Decodifica un float32 Modbus en orden CDAB a partir del offset ────────
float leerFloatCDAB(uint16_t direccionAbsoluta) {
  uint16_t offset  = direccionAbsoluta - REG_BASE;
  uint16_t regBajo = node.getResponseBuffer(offset);      // LSW
  uint16_t regAlto = node.getResponseBuffer(offset + 1);  // MSW
  uint32_t combinado = ((uint32_t)regAlto << 16) | regBajo;
  float valor;
  memcpy(&valor, &combinado, sizeof(valor));
  return valor;
}

// ─── Lee el bloque completo de registros del iEM3255 ───────────────────────
bool leerIEM3255() {
  uint8_t resultado = node.readHoldingRegisters(REG_BASE, REG_COUNT);

  if (resultado != node.ku8MBSuccess) {
    Serial.printf("[Modbus] Error de lectura, código: 0x%02X\n", resultado);
    lectura.valida = false;
    return false;
  }

  lectura.corriente1        = leerFloatCDAB(3000);
  lectura.corriente2        = leerFloatCDAB(3002);
  lectura.corriente3        = leerFloatCDAB(3008);
  lectura.voltaje1          = leerFloatCDAB(3026);
  lectura.voltaje2          = leerFloatCDAB(3028);
  lectura.voltaje3          = leerFloatCDAB(3030);
  lectura.potencia1         = leerFloatCDAB(3052);
  lectura.potencia2         = leerFloatCDAB(3054);
  lectura.potencia3         = leerFloatCDAB(3056);
  lectura.potenciaTotal     = leerFloatCDAB(3058);
  lectura.potenciaReacTotal = leerFloatCDAB(3066);
  lectura.potenciaApTotal   = leerFloatCDAB(3074);
  lectura.factorPotencia    = leerFloatCDAB(3082);
  lectura.frecuencia        = leerFloatCDAB(3108);
  lectura.valida = true;

  Serial.println("─────────────────────────────────────");
  Serial.printf("V1=%.2fV  V2=%.2fV  V3=%.2fV\n", lectura.voltaje1, lectura.voltaje2, lectura.voltaje3);
  Serial.printf("I1=%.3fA  I2=%.3fA  I3=%.3fA\n", lectura.corriente1, lectura.corriente2, lectura.corriente3);
  Serial.printf("P1=%.1fW  P2=%.1fW  P3=%.1fW  Ptotal=%.1fW\n", lectura.potencia1, lectura.potencia2, lectura.potencia3, lectura.potenciaTotal);
  Serial.printf("Q total=%.1fVAR  S total=%.1fVA  FP=%.3f  f=%.2fHz\n", lectura.potenciaReacTotal, lectura.potenciaApTotal, lectura.factorPotencia, lectura.frecuencia);
  Serial.println("─────────────────────────────────────");

  return true;
}

// ─── Arma el JSON con la lectura actual ────────────────────────────────────
String armarPayloadJSON() {
  JsonDocument doc;
  doc["dispositivo"] = MQTT_CLIENT_ID;
  doc["ts"] = millis();
  doc["voltaje1"] = lectura.voltaje1;
  doc["voltaje2"] = lectura.voltaje2;
  doc["voltaje3"] = lectura.voltaje3;
  doc["corriente1"] = lectura.corriente1;
  doc["corriente2"] = lectura.corriente2;
  doc["corriente3"] = lectura.corriente3;
  doc["potencia1"] = lectura.potencia1;
  doc["potencia2"] = lectura.potencia2;
  doc["potencia3"] = lectura.potencia3;
  doc["potenciaTotal"] = lectura.potenciaTotal;
  doc["potenciaReacTotal"] = lectura.potenciaReacTotal;
  doc["potenciaApTotal"] = lectura.potenciaApTotal;
  doc["factorPotencia"] = lectura.factorPotencia;
  doc["frecuencia"] = lectura.frecuencia;

  String salida;
  serializeJson(doc, salida);
  return salida;
}

// ─── Inicializa el módem, activa el contexto PDP y conecta MQTT ───────────
// ⚠️ Revisa esta función contra el ejemplo oficial instalado en tu IDE
//    (ver aviso arriba) antes de confiar en que compila/funciona tal cual.
bool inicializarModem() {
  if (!modem.begin(&Serial2)) {
    Serial.println("[Modem] No se pudo inicializar WalterModem");
    return false;
  }

  if (!modem.checkComm()) {
    Serial.println("[Modem] Sin comunicación con el módem");
    return false;
  }

  if (!modem.definePDPContext(&modemRsp, APN_TELCEL)) {
    Serial.println("[Modem] Error definiendo contexto PDP (revisa el APN)");
    return false;
  }

  if (!modem.setOpState(WALTER_MODEM_OPSTATE_FULL)) {
    Serial.println("[Modem] Error activando el radio");
    return false;
  }

  Serial.println("[Modem] Esperando registro en la red Telcel...");
  unsigned long inicio = millis();
  while (!modem.isNetworkRegistered()) {
    delay(500);
    Serial.print(".");
    if (millis() - inicio > 120000UL) {
      Serial.println("\n[Modem] Timeout esperando registro de red");
      return false;
    }
  }
  Serial.println("\n[Modem] Registrado en la red celular");

  if (!modem.mqttConfig(MQTT_CLIENT_ID, MQTT_USER, MQTT_PASS)) {
    Serial.println("[MQTT] Error configurando cliente MQTT");
    return false;
  }

  if (!modem.mqttConnect(MQTT_HOST, MQTT_PORT)) {
    Serial.println("[MQTT] Error conectando al broker");
    return false;
  }

  Serial.println("[MQTT] Conectado al broker");
  return true;
}

// ─── Publica la lectura actual por MQTT ────────────────────────────────────
bool publicarMQTT() {
  String payload = armarPayloadJSON();
  Serial.println("[MQTT] Publicando: " + payload);

  bool ok = modem.mqttPublish(MQTT_TOPIC, (uint8_t*)payload.c_str(), payload.length());
  if (!ok) {
    Serial.println("[MQTT] Error al publicar — intentando reconectar");
    modem.mqttConnect(MQTT_HOST, MQTT_PORT);
  }
  return ok;
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("\n=== Walter + iEM3255 — arrancando ===");

  // RS-485 (módulo XY-485, auto-dirección — sin pinMode/DE-RE que configurar)
  RS485Serial.begin(MODBUS_BAUD, SERIAL_8N1, RS485_RX, RS485_TX);

  node.begin(MODBUS_SLAVE_ID, RS485Serial);
  // Si algún día cambias a un módulo con DE/RE manual, descomenta:
  // node.preTransmission(preTransmission);
  // node.postTransmission(postTransmission);

  // Primero valida que el Modbus funcione localmente (esto es lo que
  // realmente necesitas para "checar que esté sacando los datos" del
  // medidor, independiente de si el módem/MQTT ya compila o no).
  Serial.println("[Modbus] Probando lectura inicial del iEM3255...");
  leerIEM3255();

  // Comenta esta línea si por ahora solo quieres validar el Modbus por
  // Serial, sin meter la parte celular/MQTT a la ecuación todavía.
  if (!inicializarModem()) {
    Serial.println("[Modem] No se pudo inicializar — se seguirá leyendo el "
                    "medidor pero no se publicará por MQTT hasta reintentar.");
  }
}

void loop() {
  if (millis() - ultimaLectura >= INTERVALO_LECTURA_MS) {
    ultimaLectura = millis();

    if (leerIEM3255()) {
      publicarMQTT();  // comenta esta línea para probar solo Modbus por Serial
    }
  }
}
