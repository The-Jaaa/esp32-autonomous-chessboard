#include "EmbeddedConfig.h"

#if ENABLE_OFFLINE_LANE_MOTION_DIAGNOSTICS || \
    ENABLE_OFFLINE_CAPTURE_MOTION_DIAGNOSTICS
#include "../offline_lane_motion.cpp"
#endif
