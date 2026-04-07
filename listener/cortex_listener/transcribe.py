"""Transcription module — converts audio chunks to text using mlx-whisper.

Runs entirely locally on Apple Silicon via the MLX framework.
No API keys, no cloud, no data leaves your machine.
"""

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger("cortex-listener.transcribe")

# Lazy-load mlx_whisper to avoid slow import at startup
_whisper_model = None
_whisper_model_name = None


def _get_model(model_name: str = "mlx-community/whisper-large-v3-turbo"):
    """Lazy-load the whisper model (cached after first call)."""
    global _whisper_model, _whisper_model_name
    if _whisper_model is None or _whisper_model_name != model_name:
        logger.info(f"Loading whisper model: {model_name} (first load downloads ~800MB)")
        _whisper_model_name = model_name
        # mlx_whisper.transcribe handles model loading internally
        # We just store the name for reuse
        _whisper_model = model_name
    return _whisper_model


def transcribe_audio(
    audio_path: str | Path,
    *,
    model: str = "mlx-community/whisper-large-v3-turbo",
    language: str = "en",
    word_timestamps: bool = False,
) -> dict:
    """Transcribe an audio file using mlx-whisper.

    Args:
        audio_path: Path to WAV/MP3/etc audio file
        model: HuggingFace model ID for mlx-whisper
        language: Language hint (e.g., "en")
        word_timestamps: Whether to include word-level timestamps

    Returns:
        dict with keys: text, segments, language, duration_secs, model,
        transcription_time_secs, realtime_factor
    """
    import mlx_whisper

    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    model_name = _get_model(model)
    start_time = time.time()

    logger.info(f"Transcribing: {audio_path.name} with {model_name}")

    result = mlx_whisper.transcribe(
        str(audio_path),
        path_or_hf_repo=model_name,
        language=language,
        word_timestamps=word_timestamps,
        fp16=True,
    )

    elapsed = time.time() - start_time

    # Calculate audio duration from segments
    audio_duration = 0.0
    if result.get("segments"):
        audio_duration = result["segments"][-1].get("end", 0.0)

    rtf = elapsed / audio_duration if audio_duration > 0 else 0

    transcript = {
        "text": result.get("text", "").strip(),
        "segments": [
            {
                "start": seg.get("start", 0),
                "end": seg.get("end", 0),
                "text": seg.get("text", "").strip(),
            }
            for seg in result.get("segments", [])
        ],
        "language": result.get("language", language),
        "duration_secs": round(audio_duration, 2),
        "model": model_name,
        "transcription_time_secs": round(elapsed, 2),
        "realtime_factor": round(rtf, 4),
    }

    logger.info(
        f"Transcribed {audio_duration:.1f}s audio in {elapsed:.1f}s "
        f"(RTF={rtf:.3f}), {len(transcript['text'].split())} words"
    )

    return transcript


def save_transcript(
    transcript: dict,
    output_dir: str | Path,
    audio_filename: str,
    source: str = "unknown",
) -> Path:
    """Save a transcript to a JSON file.

    Args:
        transcript: Transcript dict from transcribe_audio()
        output_dir: Directory to save transcript
        audio_filename: Original audio filename (used to derive transcript name)
        source: Audio source label (mic, system, mixed)

    Returns:
        Path to saved transcript file
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Build filename from audio filename
    stem = Path(audio_filename).stem
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"{stem}_transcript.json"
    filepath = output_dir / filename

    # Enrich with metadata
    enriched = {
        **transcript,
        "source_audio": audio_filename,
        "audio_source": source,
        "transcribed_at": datetime.now(timezone.utc).isoformat(),
    }

    with open(filepath, "w") as f:
        json.dump(enriched, f, indent=2)

    logger.info(f"Transcript saved: {filepath.name}")
    return filepath


def transcribe_and_save(
    audio_path: str | Path,
    output_dir: str | Path,
    *,
    source: str = "unknown",
    model: str = "mlx-community/whisper-large-v3-turbo",
    language: str = "en",
) -> Optional[dict]:
    """Transcribe audio and save transcript. Returns transcript or None if empty."""
    transcript = transcribe_audio(audio_path, model=model, language=language)

    if not transcript["text"] or len(transcript["text"].split()) < 3:
        logger.debug(f"Skipping empty/trivial transcript for {audio_path}")
        return None

    save_transcript(
        transcript,
        output_dir,
        Path(audio_path).name,
        source=source,
    )

    return transcript
