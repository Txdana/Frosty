import sys, json
from faster_whisper import WhisperModel

wav, model = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "base")
m = WhisperModel(model, device="cpu", compute_type="int8")
segments, _ = m.transcribe(wav, vad_filter=True)
print(json.dumps([{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]))
