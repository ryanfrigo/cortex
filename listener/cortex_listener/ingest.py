"""Cortex ingestion module — saves transcripts into Cortex memory.

Uses the cortex CLI to save transcripts as memories in the configured
namespace, with metadata for source, duration, timestamps, etc.
"""

import json
import logging
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger("cortex-listener.ingest")


def ingest_transcript(
    transcript: dict,
    *,
    cortex_bin: str = "cortex",
    namespace: str = "audio",
    tags: Optional[list[str]] = None,
    min_words: int = 10,
) -> bool:
    """Save a transcript to Cortex memory via the CLI.

    Args:
        transcript: Transcript dict with at least 'text' and 'segments'
        cortex_bin: Path to the cortex CLI binary
        namespace: Cortex namespace for audio memories
        tags: Additional tags to apply
        min_words: Minimum word count to bother saving

    Returns:
        True if successfully ingested, False otherwise
    """
    text = transcript.get("text", "").strip()
    if not text or len(text.split()) < min_words:
        logger.debug("Transcript too short, skipping ingest")
        return False

    # Build a rich memory content string
    duration = transcript.get("duration_secs", 0)
    source = transcript.get("audio_source", "unknown")
    transcribed_at = transcript.get("transcribed_at", datetime.now(timezone.utc).isoformat())

    # Format: structured transcript with metadata header
    content_parts = [
        f"[Audio Transcript | source={source} | duration={duration:.0f}s | {transcribed_at}]",
        "",
        text,
    ]

    # Add segment timestamps if available (for longer transcripts)
    segments = transcript.get("segments", [])
    if len(segments) > 1 and duration > 60:
        content_parts.append("")
        content_parts.append("--- Timestamped Segments ---")
        for seg in segments:
            start = _format_time(seg.get("start", 0))
            end = _format_time(seg.get("end", 0))
            seg_text = seg.get("text", "").strip()
            if seg_text:
                content_parts.append(f"[{start}-{end}] {seg_text}")

    content = "\n".join(content_parts)

    # Build tags
    all_tags = ["audio", "transcript", source]
    if tags:
        all_tags.extend(tags)
    tags_str = ",".join(sorted(set(all_tags)))

    # Call cortex CLI
    try:
        cmd = [
            cortex_bin, "save",
            content,
            "--namespace", namespace,
            "--type", "episodic",
            "--tags", tags_str,
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode == 0:
            logger.info(
                f"Ingested transcript into cortex: "
                f"namespace={namespace}, {len(text.split())} words, source={source}"
            )
            return True
        else:
            logger.error(f"Cortex ingest failed: {result.stderr}")
            return False

    except FileNotFoundError:
        logger.error(
            f"Cortex CLI not found at '{cortex_bin}'. "
            "Install with: npm install -g cortex-memory"
        )
        return False
    except subprocess.TimeoutExpired:
        logger.error("Cortex ingest timed out")
        return False
    except Exception as e:
        logger.error(f"Cortex ingest error: {e}")
        return False


def ingest_transcript_file(
    transcript_path: str | Path,
    *,
    cortex_bin: str = "cortex",
    namespace: str = "audio",
    tags: Optional[list[str]] = None,
    min_words: int = 10,
) -> bool:
    """Load a transcript JSON file and ingest it into Cortex."""
    path = Path(transcript_path)
    if not path.exists():
        logger.error(f"Transcript file not found: {path}")
        return False

    with open(path) as f:
        transcript = json.load(f)

    return ingest_transcript(
        transcript,
        cortex_bin=cortex_bin,
        namespace=namespace,
        tags=tags,
        min_words=min_words,
    )


def _format_time(seconds: float) -> str:
    """Format seconds into MM:SS."""
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"
