const levelLabel = (level) => {
  if (level === 1) return 'Complete Beginner';
  if (level === 2) return 'Beginner';
  if (level <= 5) return 'Casual';
  if (level <= 8) return 'Intermediate';
  if (level <= 11) return 'Advanced';
  return 'Expert';
};

export function GameSettingsControls({
  defaults,
  activeHumanColor = null,
  activeGame = false,
  activeSearch = false,
  disabled = false,
  difficultyDisabled = false,
  onColorChange,
  onLevelChange,
  compact = false
}) {
  const level = defaults?.difficultyLevel || 1;
  const sidePending = activeGame && activeHumanColor && defaults?.humanColor !== activeHumanColor;

  return (
    <div className={`shared-game-settings ${compact ? 'is-compact' : ''}`}>
      <div className="shared-setting-heading is-side">
        <span>Play as</span>
        {activeGame && <small>{sidePending ? 'Applies next game' : `Current: ${activeHumanColor}`}</small>}
      </div>
      <div className="shared-side-selector" role="group" aria-label="Human side">
        {['white', 'black'].map((color) => (
          <button
            key={color}
            type="button"
            className={defaults?.humanColor === color ? 'is-active' : ''}
            onClick={() => onColorChange(color)}
            disabled={disabled}
          >
            {color === 'white' ? 'White' : 'Black'}
          </button>
        ))}
      </div>
      <div className="shared-setting-heading is-difficulty">
        <span>Difficulty</span>
        <strong>{levelLabel(level)} <small>Level {level}</small></strong>
      </div>
      <input
        aria-label="Difficulty level"
        type="range"
        min="1"
        max="15"
        value={level}
        disabled={disabled || difficultyDisabled}
        onChange={(event) => onLevelChange(Number(event.target.value))}
      />
      <div className="shared-setting-scale"><span>Beginner</span><span>Expert</span></div>
      {activeSearch && <p className="shared-setting-note">Applies next robot turn</p>}
    </div>
  );
}
