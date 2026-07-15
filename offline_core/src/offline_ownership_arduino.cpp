#include "EmbeddedConfig.h"

#if ENABLE_OFFLINE_EMBEDDED_DIAGNOSTICS || ENABLE_OFFLINE_OWNERSHIP_DIAGNOSTICS || \
    ENABLE_OFFLINE_RUNTIME_DIAGNOSTICS
#include "../offline_ownership.cpp"
#endif
