#include <AccelStepper.h>
#include <Adafruit_NeoPixel.h>

// --- CoreXY Pin Definitions ---
constexpr uint8_t MOTOR_A_STEP_PIN = 42;
constexpr uint8_t MOTOR_A_DIR_PIN  = 41;
constexpr uint8_t MOTOR_B_STEP_PIN = 39;
constexpr uint8_t MOTOR_B_DIR_PIN  = 40;
constexpr uint8_t MAGNET_PIN       = 38;
constexpr uint8_t LIMIT_Y_PIN      = 47; 
constexpr uint8_t LIMIT_X_PIN      = 48; 

// --- NeoPixel & MUX Pin Definitions ---
#define LED_PIN 8
#define SIG1_PIN 4  
#define SIG2_PIN 5  
#define SIG3_PIN 6  
#define SIG4_PIN 7  
#define S0 18
#define S1 17
#define S2 16
#define S3 15

// --- Logic & Config ---
#define SWITCH_UNPRESSED LOW 
#define SWITCH_PRESSED HIGH    
#define NUM_LEDS 256 

AccelStepper motorA(1, MOTOR_A_STEP_PIN, MOTOR_A_DIR_PIN);
AccelStepper motorB(1, MOTOR_B_STEP_PIN, MOTOR_B_DIR_PIN);
Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);

// --- 64 CALIBRATED COORDINATES ---
// Format: {Y, X} 
const long squareCoordinates[64][2] = {
  {3100, 1400}, {2900, 5400}, {2900, 9600}, {2800, 13400}, {2800, 17300}, {2850, 21200}, {2750, 25350}, {2750, 29450},
  {7000, 29350}, {7000, 25350}, {7050, 21450}, {7100, 17600}, {7200, 13600}, {7250, 9550}, {7350, 5425}, {7300, 1375},
  {11150, 1375}, {11100, 5475}, {11100, 9500}, {11100, 13400}, {11150, 17300}, {11100, 21550}, {11000, 25300}, {11000, 29400},
  {14750, 29375}, {14800, 25475}, {14875, 21425}, {14925, 17425}, {14925, 13425}, {14925, 9375}, {14950, 5225}, {15075, 1475},
  {18975, 1425}, {18975, 5275}, {18875, 9225}, {18925, 13225}, {19025, 17625}, {19025, 21475}, {18975, 25275}, {18975, 29475},
  {22850, 29300}, {22900, 25300}, {22900, 21500}, {22950, 17400}, {23050, 13450}, {23025, 9350}, {23025, 5300}, {23075, 1300},
  {27175, 1350}, {27175, 5100}, {27125, 9200}, {27125, 13500}, {27075, 17500}, {27075, 21200}, {27025, 25250}, {26975, 29300},
  {30975, 29300}, {30925, 25300}, {31025, 21325}, {30925, 17325}, {30925, 13275}, {30975, 9275}, {31075, 5475}, {31125, 1425}
};

// State Tracking
int currentSquare = 0;
bool lastXState = SWITCH_UNPRESSED;
bool lastYState = SWITCH_UNPRESSED;
long currentX = 0;
long currentY = 0;

void setup() {
  Serial.begin(115200);
  pinMode(MAGNET_PIN, OUTPUT);
  digitalWrite(MAGNET_PIN, LOW); 

  pinMode(LIMIT_X_PIN, INPUT_PULLUP);
  pinMode(LIMIT_Y_PIN, INPUT_PULLUP);

  pinMode(S0, OUTPUT); pinMode(S1, OUTPUT);
  pinMode(S2, OUTPUT); pinMode(S3, OUTPUT);
  pinMode(SIG1_PIN, INPUT_PULLUP); pinMode(SIG2_PIN, INPUT_PULLUP);
  pinMode(SIG3_PIN, INPUT_PULLUP); pinMode(SIG4_PIN, INPUT_PULLUP);

  strip.begin();
  strip.setBrightness(40); 
  strip.show();

  motorA.setMaxSpeed(2500.0);      
  motorA.setAcceleration(1000.0);  
  motorB.setMaxSpeed(2500.0);
  motorB.setAcceleration(1000.0);

  homeGantry();
  goToSquare(0);
}

// --- Navigation Math ---
void goToXY(long targetX, long targetY) {
  long targetA = -targetX + targetY; 
  long targetB = targetX + targetY;
  
  motorA.moveTo(targetA);
  motorB.moveTo(targetB);
  
  while (motorA.distanceToGo() != 0 || motorB.distanceToGo() != 0) {
    motorA.run(); 
    motorB.run();
  }
  currentX = targetX;
  currentY = targetY;
}

void goToSquare(int index) {
  // Reads backwards to accommodate data format {Y, X}
  long tX = squareCoordinates[index][1]; 
  long tY = squareCoordinates[index][0]; 
  goToXY(tX, tY);
}

void homeGantry() {
  if (digitalRead(LIMIT_X_PIN) == SWITCH_PRESSED || digitalRead(LIMIT_Y_PIN) == SWITCH_PRESSED) {
    motorA.setCurrentPosition(0); motorB.setCurrentPosition(0);
    goToXY(200, 200); 
  }

  motorA.move(1000000); motorB.move(-1000000); 
  while (digitalRead(LIMIT_X_PIN) == SWITCH_UNPRESSED) { motorA.run(); motorB.run(); }
  motorA.setCurrentPosition(0); motorB.setCurrentPosition(0);
  motorA.moveTo(0); motorB.moveTo(0);
  
  goToXY(100, 0); 

  motorA.move(-1000000); motorB.move(-1000000); 
  while (digitalRead(LIMIT_Y_PIN) == SWITCH_UNPRESSED) { motorA.run(); motorB.run(); }
  motorA.setCurrentPosition(0); motorB.setCurrentPosition(0);
  motorA.moveTo(0); motorB.moveTo(0);

  goToXY(0, 100); 
  motorA.setCurrentPosition(0); motorB.setCurrentPosition(0);
  currentX = 0; currentY = 0;
}

// --- LED Helper ---
void setSquareColor(int squareNumber, bool isDetected) {
  int startingLED = squareNumber * 4;
  if (isDetected) {
    strip.setPixelColor(startingLED, strip.Color(0, 255, 0));
    strip.setPixelColor(startingLED + 1, strip.Color(0, 255, 0));
    strip.setPixelColor(startingLED + 2, strip.Color(0, 255, 0));
    strip.setPixelColor(startingLED + 3, strip.Color(0, 255, 0));
  } else {
    strip.setPixelColor(startingLED, strip.Color(0, 0, 0));
    strip.setPixelColor(startingLED + 1, strip.Color(0, 0, 0));
    strip.setPixelColor(startingLED + 2, strip.Color(0, 0, 0));
    strip.setPixelColor(startingLED + 3, strip.Color(0, 0, 0));
  }
}

// --- Piece Dragging ---
void dragToSquare(int newSquare) {
  digitalWrite(MAGNET_PIN, HIGH);
  delay(150); 
  goToSquare(newSquare);
  digitalWrite(MAGNET_PIN, LOW);
  delay(50); 
}

void loop() {
  // FAST HARDWARE POLLING: Must remain non-blocking!
  for (int i = 0; i < 16; i++) {
    digitalWrite(S0, bitRead(i, 0)); digitalWrite(S1, bitRead(i, 1));
    digitalWrite(S2, bitRead(i, 2)); digitalWrite(S3, bitRead(i, 3));
    delayMicroseconds(10);

    bool d1 = (digitalRead(SIG1_PIN) == LOW); setSquareColor(i, d1); 
    bool d2 = (digitalRead(SIG2_PIN) == LOW); setSquareColor(i + 16, d2); 
    bool d3 = (digitalRead(SIG3_PIN) == LOW); setSquareColor(i + 32, d3); 
    bool d4 = (digitalRead(SIG4_PIN) == LOW); setSquareColor(i + 48, d4); 
  }
  strip.show(); 

  // MANUAL TESTING CONTROLS (Will be replaced by WebSocket/Server Commands)
  bool currentXState = digitalRead(LIMIT_X_PIN);
  bool currentYState = digitalRead(LIMIT_Y_PIN);

  if (currentXState == SWITCH_PRESSED && lastXState == SWITCH_UNPRESSED) {
    if (currentSquare < 63) { currentSquare++; dragToSquare(currentSquare); }
    delay(200); 
  }

  if (currentYState == SWITCH_PRESSED && lastYState == SWITCH_UNPRESSED) {
    if (currentSquare > 0) { currentSquare--; dragToSquare(currentSquare); }
    delay(200); 
  }

  lastXState = currentXState;
  lastYState = currentYState;
}