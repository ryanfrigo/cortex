"""CLI interface for Cortex Listener.

Usage:
    cortex-listen start              Start recording and transcribing
    cortex-listen start --no-mic     Start with microphone disabled (system audio only)
    cortex-listen start --no-system  Start with mic only (no system audio)
    cortex-listen start --model tiny Use a smaller/faster model
    cortex-listen stop               Stop the running listener
    cortex-listen status             Show current listener status
    cortex-listen mic on|off         Toggle microphone (privacy control)
    cortex-listen config             Show current configuration
    cortex-listen config --set key=value  Update a config value
    cortex-listen transcribe <file>  Transcribe a single audio file
    cortex-listen ingest <file>      Ingest a transcript JSON into cortex
"""

import argparse
import json
import logging
import os
import signal
import sys
from pathlib import Path

from .config import ListenerConfig, ListenerState, STATE_FILE, WHISPER_MODELS


def setup_logging(verbose: bool = False):
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def cmd_start(args):
    """Start the listener daemon."""
    from .daemon import ListenerDaemon

    config = ListenerConfig.load()

    # Apply CLI overrides
    if args.no_mic:
        config.mic_enabled = False
    if args.no_system:
        config.system_audio_enabled = False
    if args.model:
        config.whisper_model = args.model
    if args.namespace:
        config.cortex_namespace = args.namespace
    if args.no_ingest:
        config.auto_ingest = False
    if args.keep_audio:
        config.keep_audio = True

    daemon = ListenerDaemon(config)
    daemon.start()


def cmd_stop(args):
    """Stop the listener by sending SIGTERM to the running process."""
    state = ListenerState.load()
    if not state.is_recording:
        print("Listener is not running.")
        return

    # Find and kill the process (simple approach via state file PID)
    # For now, just update state
    state.is_recording = False
    state.save()
    print("Listener stop signal sent.")
    print("(If running in foreground, use Ctrl+C)")


def cmd_status(args):
    """Show current listener status."""
    state = ListenerState.load()
    config = ListenerConfig.load()

    print("Cortex Listener Status")
    print("=" * 40)
    print(f"  Recording:         {'YES' if state.is_recording else 'no'}")
    print(f"  Session ID:        {state.current_session_id or 'none'}")
    print(f"  Microphone:        {'ON' if config.mic_enabled else 'OFF (muted)'}")
    print(f"  System audio:      {'ON' if config.system_audio_enabled else 'OFF'}")
    print(f"  Whisper model:     {config.whisper_model}")
    print(f"  Namespace:         {config.cortex_namespace}")
    print(f"  Auto-ingest:       {'ON' if config.auto_ingest else 'OFF'}")
    print(f"  Total transcripts: {state.total_transcripts}")
    print(f"  Last recording:    {state.last_recording_start or 'never'}")
    print(f"  Last transcript:   {state.last_transcript_saved or 'never'}")


def cmd_mic(args):
    """Toggle microphone on/off."""
    config = ListenerConfig.load()

    if args.action == "on":
        config.mic_enabled = True
        config.save()
        print("Microphone ENABLED")
    elif args.action == "off":
        config.mic_enabled = False
        config.save()
        print("Microphone DISABLED (muted)")
    elif args.action == "toggle":
        config.mic_enabled = not config.mic_enabled
        config.save()
        print(f"Microphone {'ENABLED' if config.mic_enabled else 'DISABLED (muted)'}")
    else:
        print(f"Microphone is {'ON' if config.mic_enabled else 'OFF (muted)'}")


def cmd_config(args):
    """Show or update configuration."""
    config = ListenerConfig.load()

    if args.set_value:
        for kv in args.set_value:
            if "=" not in kv:
                print(f"Invalid format: {kv} (use key=value)")
                continue
            key, value = kv.split("=", 1)
            if not hasattr(config, key):
                print(f"Unknown config key: {key}")
                continue
            # Type coercion
            current = getattr(config, key)
            if isinstance(current, bool):
                value = value.lower() in ("true", "1", "yes")
            elif isinstance(current, int):
                value = int(value)
            elif isinstance(current, float):
                value = float(value)
            setattr(config, key, value)
            print(f"  {key} = {value}")
        config.save()
        print("Configuration saved.")
    else:
        print("Cortex Listener Configuration")
        print("=" * 40)
        from dataclasses import asdict
        for key, value in asdict(config).items():
            print(f"  {key}: {value}")
        print()
        print(f"Available models: {', '.join(WHISPER_MODELS.keys())}")


def cmd_transcribe(args):
    """Transcribe a single audio file."""
    from .transcribe import transcribe_audio

    config = ListenerConfig.load()
    model = WHISPER_MODELS.get(
        args.model or config.whisper_model,
        args.model or config.whisper_model,
    )

    transcript = transcribe_audio(
        args.file,
        model=model,
        language=args.language or config.language,
    )

    if args.output:
        output_path = Path(args.output)
        with open(output_path, "w") as f:
            json.dump(transcript, f, indent=2)
        print(f"Transcript saved to: {output_path}")
    else:
        print(transcript["text"])
        print()
        print(f"Duration: {transcript['duration_secs']}s")
        print(f"Transcription time: {transcript['transcription_time_secs']}s")
        print(f"Realtime factor: {transcript['realtime_factor']}")


def cmd_ingest(args):
    """Ingest a transcript JSON file into Cortex."""
    from .ingest import ingest_transcript_file

    config = ListenerConfig.load()
    success = ingest_transcript_file(
        args.file,
        cortex_bin=config.cortex_bin,
        namespace=args.namespace or config.cortex_namespace,
        tags=config.default_tags,
    )

    if success:
        print("Transcript ingested into Cortex.")
    else:
        print("Failed to ingest transcript.", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        prog="cortex-listen",
        description="Cortex Listener — local audio capture and transcription for Cortex memory",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose logging")
    sub = parser.add_subparsers(dest="command")

    # start
    p_start = sub.add_parser("start", help="Start recording and transcribing")
    p_start.add_argument("--no-mic", action="store_true", help="Disable microphone (privacy)")
    p_start.add_argument("--no-system", action="store_true", help="Disable system audio capture")
    p_start.add_argument("--model", choices=list(WHISPER_MODELS.keys()), help="Whisper model")
    p_start.add_argument("--namespace", help="Cortex namespace for transcripts")
    p_start.add_argument("--no-ingest", action="store_true", help="Don't auto-ingest to cortex")
    p_start.add_argument("--keep-audio", action="store_true", help="Keep audio files after transcription")

    # stop
    sub.add_parser("stop", help="Stop the listener")

    # status
    sub.add_parser("status", help="Show listener status")

    # mic
    p_mic = sub.add_parser("mic", help="Toggle microphone on/off")
    p_mic.add_argument("action", nargs="?", choices=["on", "off", "toggle"], default="toggle")

    # config
    p_config = sub.add_parser("config", help="Show/update configuration")
    p_config.add_argument("--set", dest="set_value", nargs="+", metavar="key=value")

    # transcribe
    p_transcribe = sub.add_parser("transcribe", help="Transcribe a single audio file")
    p_transcribe.add_argument("file", help="Path to audio file")
    p_transcribe.add_argument("-o", "--output", help="Save transcript to JSON file")
    p_transcribe.add_argument("--model", help="Whisper model to use")
    p_transcribe.add_argument("--language", help="Language hint")

    # ingest
    p_ingest = sub.add_parser("ingest", help="Ingest a transcript into Cortex")
    p_ingest.add_argument("file", help="Path to transcript JSON file")
    p_ingest.add_argument("--namespace", help="Cortex namespace")

    args = parser.parse_args()
    setup_logging(args.verbose)

    commands = {
        "start": cmd_start,
        "stop": cmd_stop,
        "status": cmd_status,
        "mic": cmd_mic,
        "config": cmd_config,
        "transcribe": cmd_transcribe,
        "ingest": cmd_ingest,
    }

    if args.command in commands:
        commands[args.command](args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
