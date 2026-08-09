#include "EmbeddedConfig.h"

#if ENABLE_OFFLINE_PRODUCTION_INTERACTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CONTINUOUS_GAMEPLAY_DIAGNOSTICS
#include "../offline_human_promotion.cpp"
#endif
