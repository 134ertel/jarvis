"""Voice system: speech-to-text and text-to-speech.

Isolated from app.ai so the speech engine (local vs. cloud, model choice) can change
without touching reasoning logic — app.ai only ever sees plain text in and out.

See stt.py and tts.py for the current engine choices and their tradeoffs.
"""
