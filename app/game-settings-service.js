class GameSettingsService {
  constructor({ store, emit = () => {} }) {
    this.store = store;
    this.emit = emit;
    this.physicalAdapter = null;
  }

  setPhysicalAdapter(adapter) {
    this.physicalAdapter = adapter || null;
  }

  get() {
    const defaults = this.store.getAppSettings();
    const activePhysical = this.physicalAdapter?.getState?.() || null;
    return { defaults, activePhysical };
  }

  publish() {
    const settings = this.get();
    this.emit('game-settings-updated', settings);
    return settings;
  }

  updateDefaults(patch = {}) {
    if (patch.humanColor === undefined && patch.difficultyLevel === undefined) {
      const error = new Error('Provide a human color or difficulty level.');
      error.code = 'missing_game_setting';
      error.statusCode = 400;
      throw error;
    }
    this.store.updateAppSettings(patch);
    return this.publish();
  }

  updateActiveDifficulty({ difficultyLevel, expectedSessionGeneration } = {}) {
    if (!Number.isInteger(difficultyLevel) || difficultyLevel < 1 || difficultyLevel > 15) {
      const error = new Error('Difficulty level must be an integer from 1 to 15.');
      error.code = 'invalid_difficulty_level';
      error.statusCode = 400;
      throw error;
    }
    if (!this.physicalAdapter?.updateDifficulty) {
      const error = new Error('Physical game settings are unavailable.');
      error.code = 'physical_settings_unavailable';
      error.statusCode = 503;
      throw error;
    }
    this.physicalAdapter.updateDifficulty({ difficultyLevel, expectedSessionGeneration });
    return this.publish();
  }

  updateFromMentor(conversationId, patch = {}) {
    const hasColor = patch.humanColor !== undefined;
    const hasLevel = patch.difficultyLevel !== undefined;
    if (!hasColor && !hasLevel) {
      const error = new Error('Provide a human color or difficulty level.');
      error.code = 'missing_game_setting';
      error.statusCode = 400;
      throw error;
    }

    this.store.updateAppSettings(patch);
    const physical = this.physicalAdapter?.getState?.() || null;
    let difficultyAppliedToActiveGame = false;
    if (hasLevel && physical?.active
      && this.physicalAdapter?.isConversationAttached?.(conversationId)) {
      this.physicalAdapter.updateDifficulty({
        difficultyLevel: patch.difficultyLevel,
        expectedSessionGeneration: physical.sessionGeneration
      });
      difficultyAppliedToActiveGame = true;
    }

    const settings = this.publish();
    return {
      ...settings,
      difficultyAppliedToActiveGame,
      sideAppliesNextGame: Boolean(hasColor && physical?.active)
    };
  }
}

module.exports = { GameSettingsService };
