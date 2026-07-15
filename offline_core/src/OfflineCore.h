#pragma once

#include "EmbeddedConfig.h"

#if ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS || ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS
#include "../offline_ownership.h"
#endif

#if ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS
#include "../offline_coordinator.h"
#include "../offline_engine.h"
#include "../offline_external_route.h"
#include "../offline_game.h"
#include "../offline_motion.h"
#include "../offline_physical.h"
#include "../offline_route.h"
#endif
