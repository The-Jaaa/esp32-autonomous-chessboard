/*
 * ESP32 Hall Effect Sensor Test
 * Monitors 4 Sensors simultaneously
 */

// Define the GPIO pins connected to your sensors
const int sensor1Pin = 10;
const int sensor2Pin = 11;
const int sensor3Pin = 12;
const int sensor4Pin = 13;

void setup() {
  Serial.begin(115200);
  
  // Initialize pins as INPUT
  // If your sensors don't have built-in resistors, use INPUT_PULLUP
  pinMode(sensor1Pin, INPUT_PULLUP);
  pinMode(sensor2Pin, INPUT_PULLUP);
  pinMode(sensor3Pin, INPUT_PULLUP);
  pinMode(sensor4Pin, INPUT_PULLUP);

  Serial.println("\n--- Hall Effect Sensor Test Initialized ---");
  Serial.println("S1\tS2\tS3\tS4");
  Serial.println("-------------------------------------------");
}

void loop() {
  // Read digital states (Most Hall sensors like A3144 are digital)
  int s1 = digitalRead(sensor1Pin);
  int s2 = digitalRead(sensor2Pin);
  int s3 = digitalRead(sensor3Pin);
  int s4 = digitalRead(sensor4Pin);

  // Print results to Serial Monitor
  Serial.print(s1 == LOW ? "DETECT\t" : "OFF\t");
  Serial.print(s2 == LOW ? "DETECT\t" : "OFF\t");
  Serial.print(s3 == LOW ? "DETECT\t" : "OFF\t");
  Serial.println(s4 == LOW ? "DETECT" : "OFF");

  delay(200); // Update every 200ms
}
