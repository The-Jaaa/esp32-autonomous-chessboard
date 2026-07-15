#pragma once

#include "offline_embedded_config.h"

#if ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS || ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS || \
    ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS || ENABLE_OFFLINE_PHASE_EXECUTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_QUIET_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS

#include <Arduino.h>

void beginOfflineDiagnosticSerial();
void emitOfflineDiagnosticJson(const char* prefix, const String& payload);

#endif
