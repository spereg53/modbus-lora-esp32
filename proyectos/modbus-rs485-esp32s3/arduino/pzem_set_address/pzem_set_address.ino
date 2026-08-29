/*
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║  PZEM-004T v3 — Cambiar dirección Modbus                                ║
  ║  Usar UNA VEZ, con UN SOLO PZEM conectado                               ║
  ╚══════════════════════════════════════════════════════════════════════════╝

  INSTRUCCIONES:
    1. Conecta SOLO el PZEM que quieres cambiar (desconecta el otro)
    2. Cambia NEW_ADDRESS abajo (0x01 ó 0x02)
    3. Flashea y abre monitor serial a 115200
    4. El sketch cambia la dirección y confirma
    5. Desconecta, conecta el siguiente PZEM y repite si necesitas

  CONEXIÓN (cualquier ESP32):
    GPIO16 (RX) ──── TX del PZEM
    GPIO17 (TX) ──── RX del PZEM
    3.3V o 5V   ──── 5V del PZEM
    GND         ──── GND del PZEM

  NOTA: el PZEM necesita estar conectado a la línea AC para funcionar
*/

#include <PZEM004Tv30.h>

// ═══ CONFIGURA AQUÍ ══════════════════════════════════════════════════════════
#define NEW_ADDRESS   0x02    // ← dirección que quieres asignar (0x01 a 0xF7)
// ═════════════════════════════════════════════════════════════════════════════

#define PZEM_RX  16
#define PZEM_TX  17

HardwareSerial PzemSerial(1);

// Dirección broadcast — habla con cualquier PZEM sin importar su dirección actual
PZEM004Tv30 pzem(&PzemSerial, PZEM_RX, PZEM_TX, 0xF8);  // 0xF8 = broadcast address

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n╔══════════════════════════════════════╗");
  Serial.println("║  PZEM-004T — Cambio de dirección     ║");
  Serial.println("╚══════════════════════════════════════╝");
  Serial.printf( "  Nueva dirección objetivo: 0x%02X\n\n", NEW_ADDRESS);

  PzemSerial.begin(9600, SERIAL_8N1, PZEM_RX, PZEM_TX);
  delay(500);

  // Lee dirección actual
  uint8_t current = pzem.readAddress();
  if (current == 0xFF) {
    Serial.println("✗  No se detectó ningún PZEM.");
    Serial.println("   Verifica conexiones y que esté conectado a AC.");
    return;
  }
  Serial.printf("  Dirección actual : 0x%02X\n", current);

  if (current == NEW_ADDRESS) {
    Serial.printf("  Ya tiene la dirección 0x%02X — no hay nada que cambiar.\n", NEW_ADDRESS);
    printMeasurements();
    return;
  }

  // Cambia dirección
  Serial.printf("  Cambiando 0x%02X → 0x%02X ...\n", current, NEW_ADDRESS);
  bool ok = pzem.setAddress(NEW_ADDRESS);

  if (ok) {
    Serial.printf("\n✓  Dirección cambiada a 0x%02X exitosamente.\n", NEW_ADDRESS);
    // Verifica leyendo con la nueva dirección
    delay(500);
    PZEM004Tv30 pzemNew(&PzemSerial, PZEM_RX, PZEM_TX, NEW_ADDRESS);
    uint8_t verify = pzemNew.readAddress();
    if (verify == NEW_ADDRESS)
      Serial.println("✓  Verificación OK — dirección confirmada.");
    else
      Serial.println("⚠  No se pudo verificar. Revisa en monitor si el cambio se aplicó.");
    printMeasurements();
  } else {
    Serial.println("✗  Error al cambiar la dirección.");
    Serial.println("   Intenta de nuevo o verifica que haya un solo PZEM conectado.");
  }
}

void printMeasurements() {
  Serial.println("\n─── Lectura de prueba ───────────────────");
  PZEM004Tv30 p(&PzemSerial, PZEM_RX, PZEM_TX, NEW_ADDRESS);
  delay(300);
  float v  = p.voltage();
  float i  = p.current();
  float pw = p.power();
  float e  = p.energy();
  float hz = p.frequency();
  float pf = p.pf();

  if (isnan(v)) {
    Serial.println("  Sin lectura — verifica conexión AC");
  } else {
    Serial.printf("  Voltaje   : %.1f V\n",  v);
    Serial.printf("  Corriente : %.2f A\n",  i);
    Serial.printf("  Potencia  : %.1f W\n",  pw);
    Serial.printf("  Energía   : %.3f kWh\n", e);
    Serial.printf("  Frecuencia: %.1f Hz\n", hz);
    Serial.printf("  PF        : %.2f\n",    pf);
  }
  Serial.println("─────────────────────────────────────────");
}

void loop() {
  // nada — sketch de un solo uso
}
