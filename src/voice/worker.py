"""The voice worker: a model held warm, so talking to Simba feels like talking.

The first version shelled out to Python for every utterance. That costs an
interpreter start plus a full Whisper load per sentence — measured at two
seconds for a four-word question, of which the actual transcription is a small
fraction. Two seconds is the difference between an assistant you talk to and one
you submit requests to.

So this stays running and keeps the model in memory. The gateway posts audio and
gets text back; nothing is loaded, spawned or paged in on the hot path.

Deliberately a plain http.server on loopback rather than a queue or a socket
protocol: the gateway already speaks HTTP to ReelAgent on 4877, this is the same
shape, and a thing you can curl is a thing you can debug at three in the morning.

    python src/voice/worker.py            # uses ReelAgent's venv interpreter
"""
import io
import json
import os
import sys
import tempfile
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("SIMBA_VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("SIMBA_VOICE_PORT", "4878"))

# `small` is what the reel pipeline already downloaded, so a cold start on this
# machine costs nothing extra. `distil-small.en` is roughly twice as fast for
# English-only if latency ever matters more than the language coverage.
MODEL_NAME = os.environ.get("SIMBA_WHISPER_MODEL", "small")

_model = None
_device = "cpu"
_lock = threading.Lock()


def load():
    """Load once, on the first request rather than at import.

    Starting the worker should not block on a model download; the first
    utterance can wait, every later one should not.
    """
    global _model, _device
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        from faster_whisper import WhisperModel

        # The 3070 is worth trying and not worth requiring: ctranslate2 needs a
        # matching cuDNN, and when that is missing it fails at load with an
        # error that says nothing about cuDNN. CPU on this machine is ~0.3s for
        # a short utterance, which is fine.
        try:
            _model = WhisperModel(MODEL_NAME, device="cuda", compute_type="float16")
            _device = "cuda"
        except Exception as e:
            print(f"cuda unavailable ({type(e).__name__}: {e}) - using cpu", flush=True)
            _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
            _device = "cpu"
        print(f"whisper {MODEL_NAME} ready on {_device}", flush=True)
    return _model


def transcribe(audio: bytes, suffix: str = ".wav") -> dict:
    model = load()
    # faster-whisper reads a path or a file-like; a BytesIO avoids touching the
    # disk at all for the common case of a few seconds of speech.
    try:
        segments, info = model.transcribe(io.BytesIO(audio), vad_filter=True)
    except Exception:
        # Some containers need a real file with an extension to be sniffed.
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(audio)
            path = f.name
        try:
            segments, info = model.transcribe(path, vad_filter=True)
        finally:
            os.unlink(path)
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "seconds": round(info.duration, 2), "language": info.language,
            "device": _device}


def wav_duration(data: bytes) -> float:
    try:
        with wave.open(io.BytesIO(data)) as w:
            return round(w.getnframes() / float(w.getframerate()), 2)
    except Exception:
        return 0.0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # the gateway logs the request; two copies of it is noise

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("", "/health"):
            # Reports whether the model is *loaded*, not merely whether the
            # process is up — "listening but will take thirty seconds" is a
            # different state from "ready" and the caller should see it.
            return self._send(200, {"ok": True, "loaded": _model is not None,
                                    "device": _device, "model": MODEL_NAME})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/stt":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        audio = self.rfile.read(n)
        if not audio:
            return self._send(400, {"error": "no audio"})
        try:
            result = transcribe(audio)
            result["clip_seconds"] = wav_duration(audio)
            self._send(200, result)
        except Exception as e:
            self._send(500, {"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    # Warm on start rather than on the first request, because the first request
    # is usually a person waiting.
    threading.Thread(target=load, daemon=True).start()
    print(f"voice worker on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
