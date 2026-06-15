/*
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║  Modbus RTU Slave — ESP32-S3-N16R8 + LoRa611Pro + 2x PZEM-004T v3     ║
  ║  2 medidores TTL directos — sin convertidor RS485                       ║
  ╚══════════════════════════════════════════════════════════════════════════╝

  LIBRERÍAS REQUERIDAS:
    "ModbusRTUSlave"  by C.B. Mulliner
    "PZEM004Tv30"     by Jakub Mandula

  ARDUINO IDE — Board: ESP32S3 Dev Module
    Flash Size        : 16MB (128Mb)
    Partition Scheme  : Huge APP (3MB No OTA/1MB SPIFFS)
    PSRAM             : OPI PSRAM   ← CRÍTICO para N16R8
    Flash Mode        : QIO 80MHz
    USB Mode          : Hardware CDC and JTAG
    USB CDC On Boot   : Enabled

  ─────────────────────────────────────────────────────────────────────────
  CONEXIONES
  ─────────────────────────────────────────────────────────────────────────

    UART1  GPIO16(RX) / GPIO17(TX) ──── PZEM-004T #A  (addr 0x01)
    UART2  GPIO21(RX) / GPIO18(TX) ──── PZEM-004T #B  (addr 0x02)
    UART0  GPIO44(RX) / GPIO43(TX) ──── LoRa611Pro (Modbus RTU slave)

    USB CDC GPIO19/20 ─── monitor serial

    PROHIBIDOS: GPIO 19,20 (USB), 26-32 (Flash 16MB), 33-37 (PSRAM OPI)

  ─────────────────────────────────────────────────────────────────────────
  MAPA DE REGISTROS HOLDING — FC03 (27 registros)
  ─────────────────────────────────────────────────────────────────────────

    Addr  Campo            Escala  Fuente
    ────  ───────────────  ──────  ──────
     0    Voltaje A         ×10    PZEM #A (0x01)
     1    Corriente A       ×100   PZEM #A
     2    Potencia A        W      PZEM #A
     3    Energía A hi      Wh     PZEM #A (uint32)
     4    Energía A lo      Wh     PZEM #A (uint32)
     5    Frecuencia A      ×10    PZEM #A
     6    Factor pot. A     ×100   PZEM #A
     7    Voltaje B         ×10    PZEM #B (0x02)
     8    Corriente B       ×100   PZEM #B
     9    Potencia B        W      PZEM #B
    10    Energía B hi      Wh     PZEM #B (uint32)
    11    Energía B lo      Wh     PZEM #B (uint32)
    12    Frecuencia B      ×10    PZEM #B
    13    Factor pot. B     ×100   PZEM #B
    14    IP octeto 1       —      WiFi
    15    IP octeto 2       —      WiFi
    16    IP octeto 3       —      WiFi
    17    IP octeto 4       —      WiFi
    18    RSSI              dBm    WiFi (int16)
    19    Heap alto         —      ESP32 uint32
    20    Heap bajo         —      ESP32 uint32
    21    Uptime alto       s      ESP32 uint32
    22    Uptime bajo       s      ESP32 uint32
    23    Temp CPU          ×10    ESP32-S3
    24    Slave ID          —      1 / 2 / 3
    25    FW version        ×100   300 = v3.0
    26    WiFi OK           —      1 / 0
*/

#include <ModbusRTUSlave.h>
#include <PZEM004Tv30.h>
#include <WiFi.h>
#include <WebServer.h>

// ═══ CONFIGURA AQUÍ ══════════════════════════════════════════════════════════
#define SLAVE_ID    1             // ← 1, 2 ó 3
#define WIFI_SSID   "grand"
#define WIFI_PASS   "pegs530112"
// ═════════════════════════════════════════════════════════════════════════════

// ─── Pines ───────────────────────────────────────────────────────────────────
#define LORA_RX   44   // UART0 → LoRa611Pro (Modbus)
#define LORA_TX   43
#define PZEM_A_RX 16   // UART1 → PZEM-004T #A (addr 0x01)
#define PZEM_A_TX 17
#define PZEM_B_RX 21   // UART2 → PZEM-004T #B (addr 0x02)
#define PZEM_B_TX 18

#define PZEM_ADDR_A  0x01
#define PZEM_ADDR_B  0x02

#define BAUD_MODBUS  9600
#define NUM_REGS     27
#define UPDATE_MS    2000

enum {
  // PZEM A (0-6)
  REG_VA=0, REG_IA, REG_PA, REG_EA_HI, REG_EA_LO, REG_HZA, REG_PFA,
  // PZEM B (7-13)
  REG_VB,   REG_IB, REG_PB, REG_EB_HI, REG_EB_LO, REG_HZB, REG_PFB,
  // Sistema (14-26)
  REG_IP0, REG_IP1, REG_IP2, REG_IP3,
  REG_RSSI,
  REG_HEAP_HI, REG_HEAP_LO,
  REG_UPTIME_HI, REG_UPTIME_LO,
  REG_TEMP, REG_SLAVE_ID, REG_FW_VER, REG_WIFI_OK
};

uint16_t holdingRegs[NUM_REGS] = {0};

HardwareSerial LoRaSerial(0);   // UART0
HardwareSerial PzemSerialA(1);  // UART1
HardwareSerial PzemSerialB(2);  // UART2

ModbusRTUSlave  modbus(LoRaSerial);
PZEM004Tv30     pzemA(&PzemSerialA, PZEM_A_RX, PZEM_A_TX, PZEM_ADDR_A);
PZEM004Tv30     pzemB(&PzemSerialB, PZEM_B_RX, PZEM_B_TX, PZEM_ADDR_B);
WebServer       server(80);

// ─── Lee un PZEM y escribe 7 registros a partir de baseReg ───────────────────
void readPzem(PZEM004Tv30 &pzem, int base) {
  float v  = pzem.voltage();
  float i  = pzem.current();
  float p  = pzem.power();
  float e  = pzem.energy();
  float hz = pzem.frequency();
  float pf = pzem.pf();

  holdingRegs[base + 0] = isnan(v)  ? 0 : (uint16_t)(v  * 10);
  holdingRegs[base + 1] = isnan(i)  ? 0 : (uint16_t)(i  * 100);
  holdingRegs[base + 2] = isnan(p)  ? 0 : (uint16_t) p;
  holdingRegs[base + 5] = isnan(hz) ? 0 : (uint16_t)(hz * 10);
  holdingRegs[base + 6] = isnan(pf) ? 0 : (uint16_t)(pf * 100);

  uint32_t wh = isnan(e) ? 0 : (uint32_t)(e * 1000);
  holdingRegs[base + 3] = (uint16_t)(wh >> 16);
  holdingRegs[base + 4] = (uint16_t)(wh & 0xFFFF);
}

void updateRegisters() {
  readPzem(pzemA, REG_VA);
  readPzem(pzemB, REG_VB);

  if (WiFi.status() == WL_CONNECTED) {
    IPAddress ip = WiFi.localIP();
    holdingRegs[REG_IP0]     = ip[0];
    holdingRegs[REG_IP1]     = ip[1];
    holdingRegs[REG_IP2]     = ip[2];
    holdingRegs[REG_IP3]     = ip[3];
    holdingRegs[REG_RSSI]    = (uint16_t)(int16_t)WiFi.RSSI();
    holdingRegs[REG_WIFI_OK] = 1;
  } else {
    holdingRegs[REG_WIFI_OK] = 0;
  }

  uint32_t heap   = ESP.getFreeHeap();
  uint32_t uptime = millis() / 1000;
  holdingRegs[REG_HEAP_HI]   = (uint16_t)(heap   >> 16);
  holdingRegs[REG_HEAP_LO]   = (uint16_t)(heap   & 0xFFFF);
  holdingRegs[REG_UPTIME_HI] = (uint16_t)(uptime >> 16);
  holdingRegs[REG_UPTIME_LO] = (uint16_t)(uptime & 0xFFFF);
  holdingRegs[REG_TEMP]      = (uint16_t)(temperatureRead() * 10);
  holdingRegs[REG_SLAVE_ID]  = SLAVE_ID;
  holdingRegs[REG_FW_VER]    = 300;
}

// ─── /json ───────────────────────────────────────────────────────────────────
void handleJson() {
  uint32_t uptime = ((uint32_t)holdingRegs[REG_UPTIME_HI] << 16) | holdingRegs[REG_UPTIME_LO];
  uint32_t heap   = ((uint32_t)holdingRegs[REG_HEAP_HI]   << 16) | holdingRegs[REG_HEAP_LO];
  uint32_t whA    = ((uint32_t)holdingRegs[REG_EA_HI]     << 16) | holdingRegs[REG_EA_LO];
  uint32_t whB    = ((uint32_t)holdingRegs[REG_EB_HI]     << 16) | holdingRegs[REG_EB_LO];

  char buf[900];
  snprintf(buf, sizeof(buf),
    "{\n"
    "  \"slave_id\": %d,\n"
    "  \"meterA\": {\n"
    "    \"voltage\":   %.1f,\n"
    "    \"current\":   %.2f,\n"
    "    \"power_w\":   %d,\n"
    "    \"energy_wh\": %lu,\n"
    "    \"frequency\": %.1f,\n"
    "    \"pf\":        %.2f\n"
    "  },\n"
    "  \"meterB\": {\n"
    "    \"voltage\":   %.1f,\n"
    "    \"current\":   %.2f,\n"
    "    \"power_w\":   %d,\n"
    "    \"energy_wh\": %lu,\n"
    "    \"frequency\": %.1f,\n"
    "    \"pf\":        %.2f\n"
    "  },\n"
    "  \"ip\":        \"%d.%d.%d.%d\",\n"
    "  \"rssi_dbm\":  %d,\n"
    "  \"free_heap\": %lu,\n"
    "  \"psram\":     %lu,\n"
    "  \"uptime_s\":  %lu,\n"
    "  \"temp_c\":    %.1f,\n"
    "  \"wifi_ok\":   %d\n"
    "}",
    SLAVE_ID,
    holdingRegs[REG_VA]/10.0f, holdingRegs[REG_IA]/100.0f,
    holdingRegs[REG_PA], whA,
    holdingRegs[REG_HZA]/10.0f, holdingRegs[REG_PFA]/100.0f,
    holdingRegs[REG_VB]/10.0f, holdingRegs[REG_IB]/100.0f,
    holdingRegs[REG_PB], whB,
    holdingRegs[REG_HZB]/10.0f, holdingRegs[REG_PFB]/100.0f,
    holdingRegs[REG_IP0], holdingRegs[REG_IP1],
    holdingRegs[REG_IP2], holdingRegs[REG_IP3],
    (int16_t)holdingRegs[REG_RSSI],
    heap, ESP.getFreePsram(), uptime,
    holdingRegs[REG_TEMP]/10.0f,
    holdingRegs[REG_WIFI_OK]
  );
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", buf);
}

// ─── / ───────────────────────────────────────────────────────────────────────
void handleRoot() {
  uint32_t uptime = ((uint32_t)holdingRegs[REG_UPTIME_HI] << 16) | holdingRegs[REG_UPTIME_LO];
  uint32_t whA    = ((uint32_t)holdingRegs[REG_EA_HI]     << 16) | holdingRegs[REG_EA_LO];
  uint32_t whB    = ((uint32_t)holdingRegs[REG_EB_HI]     << 16) | holdingRegs[REG_EB_LO];

  String html = "<!DOCTYPE html><html><head><meta charset='utf-8'>"
    "<meta http-equiv='refresh' content='3'>"
    "<title>Slave " + String(SLAVE_ID) + " S3</title>"
    "<style>body{font-family:monospace;background:#1e1e1e;color:#d4d4d4;padding:20px}"
    "h2,h3{color:#4ec9b0}table{border-collapse:collapse;width:420px;margin-bottom:16px}"
    "td{padding:5px 10px;border:1px solid #444}"
    "td:first-child{color:#9cdcfe;width:160px}td:last-child{color:#ce9178}"
    ".ok{color:#4ec9b0}.warn{color:#f14c4c}</style></head><body>"
    "<h2>ESP32-S3-N16R8 — Slave ID=" + String(SLAVE_ID) + "</h2>"
    "<p style='color:#569cd6'>Flash: 16MB &nbsp;|&nbsp; PSRAM: "
    + String(ESP.getPsramSize()/1024/1024) + "MB OPI &nbsp;|&nbsp; Free PSRAM: "
    + String(ESP.getFreePsram()/1024) + " KB</p>"
    "<h3>Medidor A — PZEM 0x01 (UART1)</h3><table>"
    "<tr><td>Voltaje</td><td>"    + String(holdingRegs[REG_VA]/10.0f,1)  + " V</td></tr>"
    "<tr><td>Corriente</td><td>"  + String(holdingRegs[REG_IA]/100.0f,2) + " A</td></tr>"
    "<tr><td>Potencia</td><td>"   + String(holdingRegs[REG_PA])           + " W</td></tr>"
    "<tr><td>Energía</td><td>"    + String(whA/1000.0f,3)                 + " kWh</td></tr>"
    "<tr><td>Frecuencia</td><td>" + String(holdingRegs[REG_HZA]/10.0f,1) + " Hz</td></tr>"
    "<tr><td>PF</td><td>"         + String(holdingRegs[REG_PFA]/100.0f,2) + "</td></tr>"
    "</table>"
    "<h3>Medidor B — PZEM 0x02 (UART2)</h3><table>"
    "<tr><td>Voltaje</td><td>"    + String(holdingRegs[REG_VB]/10.0f,1)  + " V</td></tr>"
    "<tr><td>Corriente</td><td>"  + String(holdingRegs[REG_IB]/100.0f,2) + " A</td></tr>"
    "<tr><td>Potencia</td><td>"   + String(holdingRegs[REG_PB])           + " W</td></tr>"
    "<tr><td>Energía</td><td>"    + String(whB/1000.0f,3)                 + " kWh</td></tr>"
    "<tr><td>Frecuencia</td><td>" + String(holdingRegs[REG_HZB]/10.0f,1) + " Hz</td></tr>"
    "<tr><td>PF</td><td>"         + String(holdingRegs[REG_PFB]/100.0f,2) + "</td></tr>"
    "</table>"
    "<table>"
    "<tr><td>IP</td><td>"   +
      String(holdingRegs[REG_IP0])+"."+String(holdingRegs[REG_IP1])+"."+
      String(holdingRegs[REG_IP2])+"."+String(holdingRegs[REG_IP3])+"</td></tr>"
    "<tr><td>Uptime</td><td>"+ String(uptime)+" s</td></tr>"
    "<tr><td>Free Heap</td><td>"+ String(ESP.getFreeHeap()/1024)+" KB</td></tr>"
    "<tr><td>Temp CPU</td><td>"+ String(holdingRegs[REG_TEMP]/10.0f,1)+" °C</td></tr>"
    "<tr><td>WiFi</td><td class='"+(holdingRegs[REG_WIFI_OK]?"ok'>OK":"warn'>SIN RED")+"</td></tr>"
    "</table>"
    "<p style='color:#555;font-size:11px'><a href='/json' style='color:#569cd6'>/json</a></p>"
    "</body></html>";
  server.send(200, "text/html", html);
}

void webTask(void *pvParameters) {
  for (;;) { server.handleClient(); vTaskDelay(2 / portTICK_PERIOD_MS); }
}

void setup() {
  // USB CDC Serial (GPIO19/20) — monitor
  Serial.begin(115200);
  delay(800);
  Serial.printf("\n╔══ ESP32-S3-N16R8  Slave ID=%d ══╗\n", SLAVE_ID);
  Serial.printf("║  Flash : %lu MB\n", ESP.getFlashChipSize()/1024/1024);
  Serial.printf("║  PSRAM : %lu MB OPI\n", ESP.getPsramSize()/1024/1024);

  // PZEM A — UART1
  PzemSerialA.begin(9600, SERIAL_8N1, PZEM_A_RX, PZEM_A_TX);
  delay(100);
  Serial.println("║  PZEM-A OK (UART1 GPIO16/17)");

  // PZEM B — UART2
  PzemSerialB.begin(9600, SERIAL_8N1, PZEM_B_RX, PZEM_B_TX);
  delay(100);
  Serial.println("║  PZEM-B OK (UART2 GPIO21/18)");

  // WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("║  WiFi");
  for (int t = 0; t < 20 && WiFi.status() != WL_CONNECTED; t++) {
    delay(500); Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED)
    Serial.printf(" ✓  %s\n", WiFi.localIP().toString().c_str());
  else
    Serial.println(" sin red");

  // WebServer en core 0
  server.on("/",     handleRoot);
  server.on("/json", handleJson);
  server.begin();
  xTaskCreatePinnedToCore(webTask, "webTask", 4096, NULL, 1, NULL, 0);

  // Primera lectura
  updateRegisters();

  // Modbus — UART0 (GPIO44/43)
  // IMPORTANTE: modbus.begin() resetea los pines → LoRaSerial.begin() DESPUÉS
  modbus.configureHoldingRegisters(holdingRegs, NUM_REGS);
  modbus.begin(SLAVE_ID, BAUD_MODBUS);
  LoRaSerial.begin(BAUD_MODBUS, SERIAL_8N1, LORA_RX, LORA_TX);
  delay(100);

  Serial.printf("╚══ Modbus OK — %d regs @ %d baud (UART0 GPIO44/43) ══╝\n\n",
    NUM_REGS, BAUD_MODBUS);
}

void loop() {
  modbus.poll();

  static uint32_t lastUpdate = 0;
  if (millis() - lastUpdate >= UPDATE_MS) {
    lastUpdate = millis();
    updateRegisters();

    uint32_t whA = ((uint32_t)holdingRegs[REG_EA_HI] << 16) | holdingRegs[REG_EA_LO];
    uint32_t whB = ((uint32_t)holdingRegs[REG_EB_HI] << 16) | holdingRegs[REG_EB_LO];
    Serial.printf("[%5lus] ID=%d | A: %.1fV %.2fA %dW %.3fkWh | B: %.1fV %.2fA %dW %.3fkWh | heap:%luK\n",
      millis()/1000, SLAVE_ID,
      holdingRegs[REG_VA]/10.0f,  holdingRegs[REG_IA]/100.0f,  holdingRegs[REG_PA],  whA/1000.0f,
      holdingRegs[REG_VB]/10.0f,  holdingRegs[REG_IB]/100.0f,  holdingRegs[REG_PB],  whB/1000.0f,
      ESP.getFreeHeap()/1024);
  }
}
