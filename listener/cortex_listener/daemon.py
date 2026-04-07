"""Cortex Listener Daemon — orchestrates audio capture, transcription, and ingestion.

This is the main loop that ties together:
  1. AudioCapture (audio.py) — records mic and/or system audio
  2. Transcription (transcribe.py) — converts audio to text via mlx-whisper
  3. Ingestion (ingest.py) — saves transcripts to Cortex memory

Run with: cortex-listen start
"""

import logging
import queue
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .audio import AudioCapture
from .config import ListenerConfig, ListenerState, WHISPER_MODELS
from .ingest import ingest_transcript
from .transcribe import transcribe_and_save

logger = logging.getLogger("cortex-listener.daemon")


class ListenerDaemon:
    """Main daemon that orchestrates the listen -> transcribe -> ingest pipeline."""

    def __init__(self, config: Optional[ListenerConfig] = None):
        self.config = config or ListenerConfig.load()
        self.state = ListenerState.load()

        # Transcription queue: (audio_path, source_label)
        self._transcribe_queue: queue.Queue = queue.Queue()

        # Audio capture
        self._capture: Optional[AudioCapture] = None

        # Control
        self._running = False
        self._transcribe_thread: Optional[threading.Thread] = None

    def start(self):
        """Start the listener daemon."""
        if self._running:
            logger.warning("Daemon already running")
            return

        logger.info("=" * 60)
        logger.info("Cortex Listener starting")
        logger.info(f"  Microphone:    {'ON' if self.config.mic_enabled else 'OFF (muted)'}")
        logger.info(f"  System audio:  {'ON' if self.config.system_audio_enabled else 'OFF'}")
        logger.info(f"  Whisper model: {self.config.whisper_model}")
        logger.info(f"  Namespace:     {self.config.cortex_namespace}")
        logger.info(f"  Auto-ingest:   {'ON' if self.config.auto_ingest else 'OFF'}")
        logger.info("=" * 60)

        self._running = True

        # Resolve model name
        model = WHISPER_MODELS.get(
            self.config.whisper_model, self.config.whisper_model
        )

        # Setup audio capture
        recordings_dir = Path(self.config.recordings_dir)
        recordings_dir.mkdir(parents=True, exist_ok=True)

        self._capture = AudioCapture(
            mic_enabled=self.config.mic_enabled,
            system_audio_enabled=self.config.system_audio_enabled,
            sample_rate=self.config.sample_rate,
            channels=self.config.channels,
            chunk_duration=self.config.chunk_duration_secs,
            silence_threshold=self.config.silence_threshold,
            output_dir=recordings_dir,
            on_chunk_ready=self._on_chunk_ready,
        )

        # Start transcription worker thread
        self._transcribe_thread = threading.Thread(
            target=self._transcription_worker,
            daemon=True,
            name="transcribe-worker",
        )
        self._transcribe_thread.start()

        # Start audio capture
        session_id = self._capture.start()
        self.state.is_recording = True
        self.state.current_session_id = session_id
        self.state.last_recording_start = datetime.now(timezone.utc).isoformat()
        self.state.save()

        logger.info(f"Recording session: {session_id}")

        # Handle shutdown signals
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)

        # Main loop — just keep alive
        try:
            while self._running:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()

    def stop(self):
        """Stop the daemon gracefully."""
        if not self._running:
            return

        logger.info("Shutting down Cortex Listener...")
        self._running = False

        if self._capture:
            self._capture.stop()

        # Wait for transcription queue to drain
        if self._transcribe_thread and self._transcribe_thread.is_alive():
            logger.info("Waiting for transcription queue to drain...")
            self._transcribe_queue.put(None)  # Sentinel
            self._transcribe_thread.join(timeout=60)

        self.state.is_recording = False
        self.state.save()
        logger.info("Cortex Listener stopped.")

    def toggle_mic(self, enabled: bool):
        """Toggle microphone on/off (privacy control)."""
        self.config.mic_enabled = enabled
        if self._capture:
            self._capture.toggle_mic(enabled)
        logger.info(f"Microphone {'ENABLED' if enabled else 'DISABLED (muted)'}")

    def _on_chunk_ready(self, audio_path: Path, source: str):
        """Callback when an audio chunk is written to disk."""
        self._transcribe_queue.put((audio_path, source))

    def _transcription_worker(self):
        """Worker thread that processes audio chunks from the queue."""
        model = WHISPER_MODELS.get(
            self.config.whisper_model, self.config.whisper_model
        )
        transcripts_dir = Path(self.config.transcripts_dir)

        while self._running or not self._transcribe_queue.empty():
            try:
                item = self._transcribe_queue.get(timeout=2)
            except queue.Empty:
                continue

            if item is None:  # Sentinel for shutdown
                break

            audio_path, source = item

            try:
                transcript = transcribe_and_save(
                    audio_path,
                    transcripts_dir,
                    source=source,
                    model=model,
                    language=self.config.language,
                )

                if transcript and self.config.auto_ingest:
                    ingest_transcript(
                        transcript,
                        cortex_bin=self.config.cortex_bin,
                        namespace=self.config.cortex_namespace,
                        tags=self.config.default_tags,
                        min_words=self.config.min_transcript_words,
                    )
                    self.state.total_transcripts += 1
                    self.state.last_transcript_saved = datetime.now(timezone.utc).isoformat()
                    self.state.save()

                # Clean up audio if configured
                if not self.config.keep_audio and audio_path.exists():
                    audio_path.unlink()
                    logger.debug(f"Cleaned up audio: {audio_path.name}")

            except Exception as e:
                logger.error(f"Transcription error for {audio_path}: {e}", exc_info=True)

    def _signal_handler(self, signum, frame):
        """Handle shutdown signals gracefully."""
        logger.info(f"Received signal {signum}, shutting down...")
        self._running = False
