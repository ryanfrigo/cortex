# Cortex Listener 🎤

**Local audio capture and transcription daemon for [Cortex](../README.md) memory. Record meetings, conversations, and audio — transcribe locally with Whisper on Apple Silicon — auto-ingest into your AI memory layer.**

No cloud. No API keys. No data leaves your machine.

## What It Does

```
  Microphone ──┐
               ├──> Audio Chunks ──> mlx-whisper ──> Cortex Memory
  System Audio ┘        (30s)       (local, fast)     (MCP server)
```

1. **Captures audio** from your microphone and/or system audio (meetings, podcasts, etc.)
2. **Transcribes locally** using [mlx-whisper](https://github.com/ml-explore/mlx-examples) on Apple Silicon
3. **Auto-ingests** transcripts into Cortex memory with full metadata
4. **Privacy first** — microphone has a toggle, all processing is local

## Quick Start

```bash
# From the cortex repo root
cd listener

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -e .

# Optional: system audio capture (macOS 13+)
pip install mac-system-audio

# Start listening (mic only by default if no system audio package)
cortex-listen start

# Start with mic disabled (system audio only)
cortex-listen start --no-mic

# Start with faster model (less accurate but 3x faster)
cortex-listen start --model tiny

# Toggle mic on/off while running (privacy)
cortex-listen mic off
cortex-listen mic on

# Check status
cortex-listen status

# Stop (or Ctrl+C)
cortex-listen stop
```

## Privacy Controls

**Microphone toggle** — disable mic capture at any time without stopping the listener:

```bash
# Disable mic (system audio still captures)
cortex-listen mic off

# Re-enable
cortex-listen mic on

# Or start with mic disabled
cortex-listen start --no-mic
```

When mic is off, no microphone audio is captured or processed. System audio capture (if enabled) continues independently.

## Configuration

```bash
# Show current config
cortex-listen config

# Change settings
cortex-listen config --set whisper_model=tiny
cortex-listen config --set mic_enabled=false
cortex-listen config --set cortex_namespace=meetings
cortex-listen config --set chunk_duration_secs=60
```

Config is stored at `~/.cortex/listener-config.json`.

### Available Whisper Models

| Model | Speed (4min audio) | Accuracy | Size |
|-------|-------------------|----------|------|
| `tiny` | ~0.2s | ★★☆☆☆ | 39M |
| `base` | ~0.5s | ★★★☆☆ | 74M |
| `small` | ~1s | ★★★☆☆ | 244M |
| `medium` | ~2s | ★★★★☆ | 769M |
| `large-v3-turbo` | ~3s | ★★★★★ | 809M |
| `large-v3` | ~5s | ★★★★★ | 1.5G |
| `distil-large-v3` | ~2s | ★★★★☆ | 756M |

*Speeds on Apple Silicon M3 Max. First run downloads the model.*

## Transcribe a Single File

```bash
# Quick transcription
cortex-listen transcribe recording.wav

# Save as JSON
cortex-listen transcribe meeting.mp3 -o transcript.json

# Use a specific model
cortex-listen transcribe lecture.wav --model large-v3

# Ingest an existing transcript
cortex-listen ingest transcript.json --namespace meetings
```

## How It Works

1. **Audio capture** runs in background threads:
   - Microphone via `sounddevice` (PortAudio)
   - System audio via `mac-system-audio` (ScreenCaptureKit, macOS 13+)

2. **Chunking**: Audio is split into 30-second chunks. Silent chunks are automatically skipped.

3. **Transcription**: Each chunk is transcribed by `mlx-whisper` running on Apple Silicon GPU via the MLX framework. Large-v3-turbo processes 4 minutes of audio in ~3 seconds.

4. **Ingestion**: Transcripts are saved to Cortex memory via the CLI with:
   - Namespace: `audio` (configurable)
   - Type: `episodic`
   - Tags: `audio`, `transcript`, source type
   - Full timestamped segments for longer recordings

5. **Query via MCP**: Once in Cortex, transcripts are searchable via the MCP server:
   ```
   memory_search("what was discussed in the meeting about deployment")
   ```

## System Audio (macOS)

System audio capture uses Apple's ScreenCaptureKit (macOS 13+). On first use, macOS will prompt for Screen Recording permission.

```bash
# Install the optional system audio package
pip install mac-system-audio

# Grant Screen Recording permission when prompted
# System Preferences > Privacy & Security > Screen Recording
```

## Requirements

- **macOS** with Apple Silicon (M1/M2/M3/M4)
- **Python 3.10+**
- **Cortex** (`npm install -g cortex-memory`) for memory ingestion
- **PortAudio** for microphone capture: `brew install portaudio`

## Architecture

```
cortex_listener/
├── cli.py          # Command-line interface
├── daemon.py       # Main orchestration daemon
├── audio.py        # Audio capture (mic + system)
├── transcribe.py   # Whisper transcription pipeline
├── ingest.py       # Cortex memory ingestion
└── config.py       # Configuration management
```

## License

MIT — same as Cortex.
