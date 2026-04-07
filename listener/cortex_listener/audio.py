"""Audio capture module — handles mic and system audio recording.

Captures audio from the microphone (via sounddevice) and optionally from
system audio (via mac-system-audio / ScreenCaptureKit).  Audio is written
to WAV chunks on disk, then picked up by the transcription pipeline.

Privacy: The microphone can be toggled on/off at any time without restarting.
"""

import logging
import os
import queue
import threading
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import numpy as np

logger = logging.getLogger("cortex-listener.audio")

# Lazy imports for optional system audio
_system_audio_available = False
try:
    import mac_system_audio  # noqa: F401
    _system_audio_available = True
except ImportError:
    pass


class AudioCapture:
    """Manages audio capture from mic and/or system audio.

    Audio is captured in chunks and saved as WAV files.  A callback is
    invoked with the path to each completed chunk for downstream processing.
    """

    def __init__(
        self,
        *,
        mic_enabled: bool = True,
        system_audio_enabled: bool = True,
        sample_rate: int = 16000,
        channels: int = 1,
        chunk_duration: int = 30,
        silence_threshold: float = 0.01,
        output_dir: str | Path = "/tmp/cortex-recordings",
        on_chunk_ready: Optional[Callable[[Path, str], None]] = None,
    ):
        self.mic_enabled = mic_enabled
        self.system_audio_enabled = system_audio_enabled
        self.sample_rate = sample_rate
        self.channels = channels
        self.chunk_duration = chunk_duration
        self.silence_threshold = silence_threshold
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.on_chunk_ready = on_chunk_ready

        self._running = False
        self._mic_thread: Optional[threading.Thread] = None
        self._sys_thread: Optional[threading.Thread] = None
        self._session_id = ""

        # Audio buffers
        self._mic_buffer: queue.Queue = queue.Queue()
        self._sys_buffer: queue.Queue = queue.Queue()

    @property
    def session_id(self) -> str:
        return self._session_id

    def start(self) -> str:
        """Start audio capture. Returns session ID."""
        if self._running:
            logger.warning("Already recording")
            return self._session_id

        self._session_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        self._running = True

        if self.mic_enabled:
            self._mic_thread = threading.Thread(
                target=self._capture_mic, daemon=True, name="mic-capture"
            )
            self._mic_thread.start()
            logger.info("Microphone capture started")

        if self.system_audio_enabled and _system_audio_available:
            self._sys_thread = threading.Thread(
                target=self._capture_system_audio, daemon=True, name="sys-capture"
            )
            self._sys_thread.start()
            logger.info("System audio capture started")
        elif self.system_audio_enabled and not _system_audio_available:
            logger.warning(
                "System audio capture requested but mac-system-audio not installed. "
                "Install with: pip install mac-system-audio"
            )

        # Chunk writer thread
        self._writer_thread = threading.Thread(
            target=self._chunk_writer, daemon=True, name="chunk-writer"
        )
        self._writer_thread.start()

        return self._session_id

    def stop(self):
        """Stop audio capture and flush remaining audio."""
        if not self._running:
            return
        logger.info("Stopping audio capture...")
        self._running = False

        # Give threads time to finish
        if self._mic_thread and self._mic_thread.is_alive():
            self._mic_thread.join(timeout=3)
        if self._sys_thread and self._sys_thread.is_alive():
            self._sys_thread.join(timeout=3)
        if hasattr(self, "_writer_thread") and self._writer_thread.is_alive():
            self._writer_thread.join(timeout=5)

    def toggle_mic(self, enabled: bool):
        """Toggle microphone capture on/off (privacy control)."""
        self.mic_enabled = enabled
        logger.info(f"Microphone {'enabled' if enabled else 'DISABLED (muted)'}")

    def _capture_mic(self):
        """Capture audio from the default microphone."""
        import sounddevice as sd

        def callback(indata, frames, time_info, status):
            if status:
                logger.debug(f"Mic status: {status}")
            if self.mic_enabled and self._running:
                self._mic_buffer.put(indata.copy())

        try:
            with sd.InputStream(
                samplerate=self.sample_rate,
                channels=self.channels,
                dtype="float32",
                blocksize=int(self.sample_rate * 0.5),  # 500ms blocks
                callback=callback,
            ):
                while self._running:
                    time.sleep(0.1)
        except Exception as e:
            logger.error(f"Mic capture error: {e}")

    def _capture_system_audio(self):
        """Capture system audio via ScreenCaptureKit (macOS 13+)."""
        try:
            import mac_system_audio

            capture = mac_system_audio.SystemAudioCapture(
                sample_rate=48000, channels=2
            )

            def on_audio(audio_data, sample_rate, num_channels):
                if not self._running:
                    return
                # Resample from 48kHz stereo to 16kHz mono
                audio = np.array(audio_data, dtype=np.float32)
                if num_channels == 2:
                    audio = audio.reshape(-1, 2).mean(axis=1)
                # Simple downsample from 48k to 16k (factor of 3)
                if sample_rate != self.sample_rate:
                    factor = sample_rate // self.sample_rate
                    audio = audio[::factor]
                self._sys_buffer.put(audio)

            capture.start(callback=on_audio)
            while self._running:
                time.sleep(0.1)
            capture.stop()
        except Exception as e:
            logger.error(f"System audio capture error: {e}")

    def _chunk_writer(self):
        """Collects audio from buffers and writes WAV chunks to disk."""
        chunk_samples = self.sample_rate * self.chunk_duration
        chunk_idx = 0

        while self._running or not self._mic_buffer.empty() or not self._sys_buffer.empty():
            mic_frames = []
            sys_frames = []
            collected = 0

            deadline = time.time() + self.chunk_duration

            while collected < chunk_samples and (self._running or time.time() < deadline + 1):
                # Drain mic buffer
                try:
                    while True:
                        data = self._mic_buffer.get_nowait()
                        flat = data.flatten()
                        mic_frames.append(flat)
                        collected += len(flat)
                except queue.Empty:
                    pass

                # Drain system audio buffer
                try:
                    while True:
                        data = self._sys_buffer.get_nowait()
                        sys_frames.append(data)
                except queue.Empty:
                    pass

                if collected < chunk_samples:
                    time.sleep(0.2)

                if time.time() > deadline + 2:
                    break

            # Mix mic + system audio
            audio = self._mix_sources(mic_frames, sys_frames, chunk_samples)
            if audio is None or len(audio) == 0:
                continue

            # Check for silence
            rms = np.sqrt(np.mean(audio**2))
            if rms < self.silence_threshold:
                logger.debug(f"Chunk {chunk_idx}: silence (RMS={rms:.4f}), skipping")
                continue

            # Determine source label
            has_mic = len(mic_frames) > 0 and self.mic_enabled
            has_sys = len(sys_frames) > 0
            if has_mic and has_sys:
                source = "mixed"
            elif has_mic:
                source = "mic"
            elif has_sys:
                source = "system"
            else:
                source = "unknown"

            # Write WAV
            ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
            filename = f"{self._session_id}_chunk{chunk_idx:04d}_{ts}.wav"
            filepath = self.output_dir / filename
            self._write_wav(filepath, audio)

            logger.info(
                f"Chunk {chunk_idx}: {len(audio)/self.sample_rate:.1f}s, "
                f"source={source}, RMS={rms:.4f} -> {filepath.name}"
            )

            if self.on_chunk_ready:
                self.on_chunk_ready(filepath, source)

            chunk_idx += 1

    def _mix_sources(
        self,
        mic_frames: list,
        sys_frames: list,
        target_samples: int,
    ) -> Optional[np.ndarray]:
        """Mix mic and system audio frames into a single array."""
        mic_audio = np.concatenate(mic_frames) if mic_frames else np.array([], dtype=np.float32)
        sys_audio = np.concatenate(sys_frames) if sys_frames else np.array([], dtype=np.float32)

        if len(mic_audio) == 0 and len(sys_audio) == 0:
            return None

        # Pad shorter source to match longer
        max_len = max(len(mic_audio), len(sys_audio))
        if max_len == 0:
            return None

        if len(mic_audio) > 0 and len(sys_audio) > 0:
            # Mix both sources
            if len(mic_audio) < max_len:
                mic_audio = np.pad(mic_audio, (0, max_len - len(mic_audio)))
            if len(sys_audio) < max_len:
                sys_audio = np.pad(sys_audio, (0, max_len - len(sys_audio)))
            mixed = (mic_audio * 0.5 + sys_audio * 0.5)
        elif len(mic_audio) > 0:
            mixed = mic_audio
        else:
            mixed = sys_audio

        # Clip to prevent clipping
        return np.clip(mixed, -1.0, 1.0).astype(np.float32)

    def _write_wav(self, path: Path, audio: np.ndarray):
        """Write float32 audio array to a WAV file."""
        int16_audio = (audio * 32767).astype(np.int16)
        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(self.channels)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(self.sample_rate)
            wf.writeframes(int16_audio.tobytes())
