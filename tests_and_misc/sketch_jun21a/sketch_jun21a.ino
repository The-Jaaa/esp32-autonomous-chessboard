#include <AccelStepper.h>
#include <Adafruit_NeoPixel.h>

// --- CoreXY Pin Definitions ---
constexpr uint8_t MOTOR_A_STEP_PIN = 42;
constexpr uint8_t MOTOR_A_DIR_PIN  = 41;
constexpr uint8_t MOTOR_B_STEP_PIN = 39;
constexpr uint8_t MOTOR_B_DIR_PIN  = 40;
constexpr uint8_t MAGNET_PIN       = 38;
constexpr uint8_t LIMIT_X_PIN      = 47; // NEXT SQUARE BUTTON
constexpr uint8_t LIMIT_Y_PIN      = 48; // PREV SQUARE BUTTON

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

// --- YOUR 64 CALIBRATED COORDINATES (Duplicate 26 Removed) ---
const long squareCoordinates[64][2] = {
  {3100, 1400},  // Square 0
  {2900, 5400},  // Square 1
  {2900, 9600},  // Square 2
  {2800, 13400},  // Square 3
  {2800, 17300},  // Square 4
  {2850, 21200},  // Square 5
  {2750, 25350},  // Square 6
  {2750, 29450},  // Square 7
  {7000, 29350},  // Square 8
  {7000, 25350},  // Square 9
  {7050, 21450},  // Square 10
  {7100, 17600},  // Square 11
  {7200, 13600},  // Square 12
  {7250, 9550},   // Square 13
  {7350, 5425},   // Square 14
  {7300, 1375},   // Square 15
  {11150, 1375},  // Square 16
  {11100, 5475},  // Square 17
  {11100, 9500},  // Square 18
  {11100, 13400}, // Square 19
  {11150, 17300}, // Square 20
  {11100, 21550}, // Square 21
  {11000, 25300}, // Square 22
  {11000, 29400}, // Square 23
  {14750, 29375}, // Square 24
  {14800, 25475}, // Square 25
  {14875, 21425}, // Square 26
  {14925, 17425}, // Square 27
  {14925, 13425}, // Square 28
  {14925, 9375},  // Square 29
  {14950, 5225},  // Square 30
  {15075, 1475},  // Square 31
  {18975, 1425},  // Square 32
  {18975, 5275},  // Square 33
  {18875, 9225},  // Square 34
  {18925, 13225}, // Square 35
  {19025, 17625}, // Square 36
  {19025, 21475}, // Square 37
  {18975, 25275}, // Square 38
  {18975, 29475}, // Square 39
  {22850, 29300}, // Square 40
  {22900, 25300}, // Square 41
  {22900, 21500}, // Square 42
  {22950, 17400}, // Square 43
  {23050, 13450}, // Square 44
  {23025, 9350},  // Square 45
  {23025, 5300},  // Square 46
  {23075, 1300},  // Square 47
  {27175, 1350},  // Square 48
  {27175, 5100},  // Square 49
  {27125, 9200},  // Square 50
  {27125, 13500}, // Square 51
  {27075, 17500}, // Square 52
  {27075, 21200}, // Square 53
  {27025, 25250}, // Square 54
  {26975, 29300}, // Square 55
  {30975, 29300}, // Square 56
  {30925, 25300}, // Square 57
  {31025, 21325}, // Square 58
  {30925, 17325}, // Square 59
  {30925, 13275}, // Square 60
  {30975, 9275},  // Square 61
  {31075, 5475},  // Square 62
  {31125, 1425}   // Square 63
};

// State Tracking
int currentSquare = 0;
bool lastXState = SWITCH_UNPRESSED;
bool lastYState = SWITCH_UNPRESSED;
long currentX = 0;
long currentY = 0;

void setup() {
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

  // Reduced speed/acceleration so the pieces don't tip over while dragging
  motorA.setMaxSpeed(2500.0);      
  motorA.setAcceleration(1000.0);  
  motorB.setMaxSpeed(2500.0);
  motorB.setAcceleration(1000.0);

  // Home and move to Square 0
  homeGantry();
  goToSquare(0);
}

// --- Navigation Math (v7 Perfect Alignment) ---
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
  long tY = squareCoordinates[index][0];
  long tX = squareCoordinates[index][1];
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

// --- The Piece-Dragging Function ---
void dragToSquare(int newSquare) {
  // 1. Turn on Magnet to grab the piece
  digitalWrite(MAGNET_PIN, HIGH);
  delay(150); // Give the coil time to fully magnetize and grab the core
  
  // 2. Smoothly drag it to the new coordinate
  goToSquare(newSquare);
  
  // 3. Drop the piece
  digitalWrite(MAGNET_PIN, LOW);
  delay(50); // Let the inductive energy dissipate so it doesn't scramble the sensors
}

void loop() {
  // 1. Constantly scan the 64 squares and update LEDs
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

  // 2. Check Limit Switches for Navigation
  bool currentXState = digitalRead(LIMIT_X_PIN);
  bool currentYState = digitalRead(LIMIT_Y_PIN);

  // If X Switch is newly pressed -> DRAG TO NEXT SQUARE
  if (currentXState == SWITCH_PRESSED && lastXState == SWITCH_UNPRESSED) {
    if (currentSquare < 63) {
      currentSquare++;
      dragToSquare(currentSquare);
    }
    delay(200); // Debounce button to prevent accidental double-clicks
  }

  // If Y Switch is newly pressed -> DRAG TO PREVIOUS SQUARE
  if (currentYState == SWITCH_PRESSED && lastYState == SWITCH_UNPRESSED) {
    if (currentSquare > 0) {
      currentSquare--;
      dragToSquare(currentSquare);
    }
    delay(200); // Debounce button
  }

  lastXState = currentXState;
  lastYState = currentYState;
}