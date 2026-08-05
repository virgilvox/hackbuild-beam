// DETENT motor test - isolates wiring and power from the real firmware.
// No BLE, no timer ISR, no queue, no laser. Just blocking half-steps.
// If a motor turns here and not in detent_firmware.ino, the problem is config.
// If it does not turn here either, the problem is wiring, power, or the motor.
//
// Board: ESP32C3 Dev Module, USB CDC On Boot = Enabled.
//
// Serial commands (115200, send newline):
//   x        step motor X forward 512 half-steps
//   X        step motor X backward
//   y / Y    same for motor Y
//   s        slow sweep, ramps from 40 to 1000 steps/s so you can hear it stall
//   p        PIN WALK - drives all 8 phase pins high one at a time, naming each.
//            Watch the LEDs. Any pin whose LED never lights is the broken link.
//   1..4     hold one phase on motor X
//   5..8     hold one phase on motor Y
//   0        release all coils
//   ?        report

const uint8_t PIN_X[4] = {0, 1, 3, 4};      // IN1 IN2 IN3 IN4  ->  blue pink yellow orange
const uint8_t PIN_Y[4] = {5, 6, 7, 10};

// Half-step. Bit 0 = IN1. Never energises IN1+IN3 or IN2+IN4 together.
const uint8_t HALFSTEP[8] = {0b0001, 0b0011, 0b0010, 0b0110,
                             0b0100, 0b1100, 0b1000, 0b1001};

uint8_t phX = 0, phY = 0;
uint16_t rate = 250;                        // half-steps per second

void applyPhase(const uint8_t *pins, uint8_t p) {
  for (int i = 0; i < 4; i++) digitalWrite(pins[i], (HALFSTEP[p] >> i) & 1);
}
void release(const uint8_t *pins) {
  for (int i = 0; i < 4; i++) digitalWrite(pins[i], LOW);
}

void run(const uint8_t *pins, uint8_t &ph, int dir, int steps, uint16_t sps) {
  uint32_t us = 1000000UL / (sps < 1 ? 1 : sps);
  for (int i = 0; i < steps; i++) {
    ph = (ph + (dir > 0 ? 1 : 7)) & 7;
    applyPhase(pins, ph);
    delayMicroseconds(us);
  }
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 4; i++) { pinMode(PIN_X[i], OUTPUT); pinMode(PIN_Y[i], OUTPUT); }
  release(PIN_X); release(PIN_Y);
  delay(1200);
  Serial.println("motor test ready");
  Serial.println("p = PIN WALK (run this first) | x X y Y = 512 steps | s = rate sweep");
  Serial.println("1-4 hold X phase | 5-8 hold Y phase | 0 release | ? info");
}

void loop() {
  if (!Serial.available()) return;
  char c = Serial.read();
  if (c == '\n' || c == '\r') return;

  switch (c) {
    case 'x': Serial.println("X fwd 512"); run(PIN_X, phX,  1, 512, rate); break;
    case 'X': Serial.println("X rev 512"); run(PIN_X, phX, -1, 512, rate); break;
    case 'y': Serial.println("Y fwd 512"); run(PIN_Y, phY,  1, 512, rate); break;
    case 'Y': Serial.println("Y rev 512"); run(PIN_Y, phY, -1, 512, rate); break;

    case 's': {
      // Walk the rate up until it stalls. Whatever speed it stops turning at,
      // set the firmware draw rate to about 60 percent of that.
      const uint16_t steps[] = {40, 80, 150, 250, 400, 600, 800, 1000};
      for (uint8_t i = 0; i < 8; i++) {
        Serial.print("  "); Serial.print(steps[i]); Serial.println(" steps/s");
        run(PIN_X, phX, 1, steps[i] / 2 + 60, steps[i]);
        delay(500);
      }
      Serial.println("sweep done");
      break;
    }

    case 'p': {
      // The decisive test. One pin at a time, named out loud. Eight LEDs should
      // light in sequence, four on board A then four on board B. A pin that
      // never lights its LED is a wrong header hole, a broken wire, or a dead
      // driver channel, and no amount of firmware will fix it.
      release(PIN_X); release(PIN_Y);
      Serial.println("PIN WALK - watch the LEDs, each should light for 1s");
      for (int m = 0; m < 2; m++) {
        const uint8_t *pins = m ? PIN_Y : PIN_X;
        for (int i = 0; i < 4; i++) {
          Serial.print("  board "); Serial.print(m ? "B (Y)" : "A (X)");
          Serial.print("  IN"); Serial.print(i + 1);
          Serial.print("  GPIO"); Serial.print(pins[i]);
          Serial.print("  wire ");
          Serial.println(i == 0 ? "blue" : i == 1 ? "pink" : i == 2 ? "yellow" : "orange");
          digitalWrite(pins[i], HIGH);
          delay(1000);
          digitalWrite(pins[i], LOW);
          delay(250);
        }
      }
      Serial.println("PIN WALK done. Any LED that stayed dark is your fault.");
      break;
    }

    case '1': case '2': case '3': case '4':
    case '5': case '6': case '7': case '8': {
      // Hold one input high so you can meter it. That motor wire should read
      // near 0 V against the supply positive.
      release(PIN_X); release(PIN_Y);
      int n = c - '1';
      const uint8_t *pins = n > 3 ? PIN_Y : PIN_X;
      int i = n & 3;
      digitalWrite(pins[i], HIGH);
      Serial.print("holding board "); Serial.print(n > 3 ? "B (Y)" : "A (X)");
      Serial.print(" IN"); Serial.print(i + 1);
      Serial.print(" on GPIO"); Serial.println(pins[i]);
      break;
    }

    case '0': release(PIN_X); release(PIN_Y); Serial.println("released"); break;

    case '?':
      Serial.print("rate "); Serial.print(rate); Serial.println(" steps/s");
      Serial.println("X = GPIO 0,1,3,4   Y = GPIO 5,6,7,10");
      Serial.println("GPIO 8 and 9 sit between 7 and 10 on the header. Do not use them.");
      break;

    case '-': if (rate > 40) rate -= 50; Serial.println(rate); break;
    case '+': rate += 50; Serial.println(rate); break;
  }
}
