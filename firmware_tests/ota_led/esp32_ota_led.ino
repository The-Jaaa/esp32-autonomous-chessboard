#include <WiFi.h>
#include <ESPmDNS.h>
#include <WiFiUdp.h>
#include <ArduinoOTA.h>
#include <FastLED.h> // Using FastLED as per your project firmware

// ==========================================
// 1. WIFI CREDENTIALS
// ==========================================
const char* ssid = "YOUR_WIFI_NAME";
const char* password = "YOUR_WIFI_PASSWORD";

// ==========================================
// 2. LED GRID SETTINGS (256 LEDs, Pin 8)
// ==========================================
#define LED_PIN 8
#define NUM_LEDS 256
CRGB leds[NUM_LEDS];

// ==========================================
// 3. MULTIPLEXER SETTINGS (64 Sensors)
// ==========================================
#define SIG1_PIN 4
#define SIG2_PIN 5
#define SIG3_PIN 6
#define SIG4_PIN 7
#define S0 18
#define S1 17
#define S2 16
#define S3 15

// Track previous states to avoid continuous LED updates
bool squareStates[64] = {false};

void setup() {
  Serial.begin(115200);
  Serial.println("Booting OTA LED Test...");

  // Initialize MUX Pins
  pinMode(S0, OUTPUT); pinMode(S1, OUTPUT);
  pinMode(S2, OUTPUT); pinMode(S3, OUTPUT);
  pinMode(SIG1_PIN, INPUT_PULLUP); pinMode(SIG2_PIN, INPUT_PULLUP);
  pinMode(SIG3_PIN, INPUT_PULLUP); pinMode(SIG4_PIN, INPUT_PULLUP);

  // Initialize FastLED for the 256-LED grid
  FastLED.addLeds<WS2812B, LED_PIN, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(40);
  FastLED.clear();
  FastLED.show(); 

  // Connect to WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  
  while (WiFi.waitForConnectResult() != WL_CONNECTED) {
    Serial.println("Connection Failed! Rebooting in 5 seconds...");
    delay(5000);
    ESP.restart();
  }

  // Configure Over-The-Air (OTA) Updates
  ArduinoOTA.setHostname("ESP32-LED-Test");
  
  ArduinoOTA.onStart([]() { Serial.println("Start OTA Upload"); });
  ArduinoOTA.onEnd([]() { Serial.println("\nEnd OTA Upload"); });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("Progress: %u%%\r", (progress / (total / 100)));
  });
  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("Error[%u]: ", error);
  });
  
  ArduinoOTA.begin();
  
  Serial.println("\nReady for OTA Updates!");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
}

// Helper to light up a single 2x2 grid (4 LEDs) based on sensor state
void setSquareColor(int squareNumber, bool isDetected) {
  int startingLED = squareNumber * 4; // Because each square has 4 LEDs
  CRGB color = isDetected ? CRGB(0, 255, 0) : CRGB(0, 0, 0); // Green if detected
  for (int i = 0; i < 4; i++) {
    leds[startingLED + i] = color;
  }
}

void loop() {
  // Listen for OTA uploads over WiFi
  ArduinoOTA.handle();

  bool ledsChanged = false;

  // Scan all 16 channels of the 4 multiplexers (total 64 squares)
  for (int i = 0; i < 16; i++) {
    // Set the multiplexer address (0-15)
    digitalWrite(S0, bitRead(i, 0)); 
    digitalWrite(S1, bitRead(i, 1));
    digitalWrite(S2, bitRead(i, 2)); 
    digitalWrite(S3, bitRead(i, 3));
    delayMicroseconds(10); // Give the multiplexer time to switch
    
    // Read MUX 1 (Squares 0-15)
    bool d1 = (digitalRead(SIG1_PIN) == LOW);
    if (d1 != squareStates[i]) {
      squareStates[i] = d1;
      setSquareColor(i, d1);
      ledsChanged = true;
    }
    
    // Read MUX 2 (Squares 16-31)
    bool d2 = (digitalRead(SIG2_PIN) == LOW);
    if (d2 != squareStates[i + 16]) {
      squareStates[i + 16] = d2;
      setSquareColor(i + 16, d2);
      ledsChanged = true;
    }
    
    // Read MUX 3 (Squares 32-47)
    bool d3 = (digitalRead(SIG3_PIN) == LOW);
    if (d3 != squareStates[i + 32]) {
      squareStates[i + 32] = d3;
      setSquareColor(i + 32, d3);
      ledsChanged = true;
    }
    
    // Read MUX 4 (Squares 48-63)
    bool d4 = (digitalRead(SIG4_PIN) == LOW);
    if (d4 != squareStates[i + 48]) {
      squareStates[i + 48] = d4;
      setSquareColor(i + 48, d4);
      ledsChanged = true;
    }
  }

  // Only push data to the LED strip if a sensor state actually changed
  if (ledsChanged) {
    FastLED.show();
  }
  
  // Very small delay to prevent crashing the watchdog timer
  delay(5); 
}
