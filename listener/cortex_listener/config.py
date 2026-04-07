"""Configuration for Cortex Listener."""

import json
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path

DEFAULT_CONFIG_DIR = Path.home() / ".cortex"
DEFAULT_RECORDINGS_DIR = DEFAULT_CONFIG_DIR / "recordings"
DEFAULT_TRANSCRIPTS_DIR = DEFAULT_CONFIG_DIR / "transcripts"
CONFIG_FILE = DEFAULT_CONFIG_DIR / "listener-config.json"
STATE_FILE = DEFAULT_CONFIG_DIR / "listener-state.json"

# Whisper model options (speed vs accuracy)
WHISPER_MODELS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "distil-large-v3": "mlx-community/distil-whisper-large-v3",
}


@dataclass
class ListenerConfig:
    """Listener configuration with sensible defaults."""

    # Audio capture
    mic_enabled: bool = True          # Privacy toggle — can disable mic capture
    system_audio_enabled: bool = True  # Capture system/meeting audio
    sample_rate: int = 16000           # Whisper expects 16kHz
    channels: int = 1                  # Mono for transcription
    chunk_duration_secs: int = 30      # Process audio in 30s chunks
    silence_threshold: float = 0.01    # RMS below this = silence
    silence_skip_secs: float = 2.0     # Skip chunks with this much silence

    # Transcription
    whisper_model: str = "large-v3-turbo"  # Best speed/accuracy tradeoff
    language: str = "en"                    # Language hint for Whisper

    # Storage
    recordings_dir: str = str(DEFAULT_RECORDINGS_DIR)
    transcripts_dir: str = str(DEFAULT_TRANSCRIPTS_DIR)
    keep_audio: bool = False           # Delete audio after transcription
    max_recording_hours: float = 8.0   # Auto-stop after this many hours

    # Cortex integration
    cortex_namespace: str = "audio"    # Default namespace for audio memories
    cortex_bin: str = "cortex"         # Path to cortex CLI
    auto_ingest: bool = True           # Auto-save transcripts to cortex
    min_transcript_words: int = 10     # Skip very short transcripts

    # Tags applied to all audio memories
    default_tags: list = field(default_factory=lambda: ["audio", "transcript"])

    def save(self, path: Path = CONFIG_FILE):
        """Save config to JSON file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(asdict(self), f, indent=2)

    @classmethod
    def load(cls, path: Path = CONFIG_FILE) -> "ListenerConfig":
        """Load config from JSON file, or return defaults."""
        if path.exists():
            with open(path) as f:
                data = json.load(f)
            return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
        return cls()


@dataclass
class ListenerState:
    """Persistent state across listener restarts."""

    is_recording: bool = False
    current_session_id: str = ""
    total_hours_recorded: float = 0.0
    total_transcripts: int = 0
    last_recording_start: str = ""
    last_transcript_saved: str = ""

    def save(self, path: Path = STATE_FILE):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(asdict(self), f, indent=2)

    @classmethod
    def load(cls, path: Path = STATE_FILE) -> "ListenerState":
        if path.exists():
            with open(path) as f:
                data = json.load(f)
            return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
        return cls()
