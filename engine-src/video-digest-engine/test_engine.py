import json
import tempfile
import unittest
from pathlib import Path

import video_digest_engine as engine


class ParseTimeTests(unittest.TestCase):
    def test_seconds_number(self):
        self.assertEqual(engine.parse_time(12.5), 12.5)
        self.assertEqual(engine.parse_time(-3), 0.0)

    def test_clock_strings(self):
        self.assertEqual(engine.parse_time("12:34"), 754.0)
        self.assertEqual(engine.parse_time("1:02:03.5"), 3723.5)
        self.assertEqual(engine.parse_time("00:00:01,250"), 1.25)

    def test_invalid_returns_zero(self):
        self.assertEqual(engine.parse_time("not-a-time"), 0.0)
        self.assertEqual(engine.parse_time(""), 0.0)


class ParseSrtTests(unittest.TestCase):
    def test_extracts_segments(self):
        content = (
            "1\n"
            "00:00:01,000 --> 00:00:02,500\n"
            "第一句 字幕\n\n"
            "2\n"
            "00:00:03.000 --> 00:00:04.000\n"
            "Second line\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "sub.srt"
            file.write_text(content, encoding="utf-8")
            segments = engine.parse_srt(file)

        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["text"], "第一句 字幕")
        self.assertAlmostEqual(segments[0]["start"], 1.0)
        self.assertAlmostEqual(segments[0]["end"], 2.5)
        self.assertEqual(segments[1]["text"], "Second line")


class ParseWhisperJsonTests(unittest.TestCase):
    def test_offsets_and_milliseconds(self):
        value = {
            "segments": [
                {"start": 0, "end": 1250, "text": " 你好 世界 "},
                {"timestamps": {"from": "00:00:02.000", "to": "00:00:03.000"}, "text": "timed"},
                {"offsets": {"from": 4000, "to": 5000}, "text": "offset"},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "asr.json"
            file.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            segments = engine.parse_whisper_json(file)

        self.assertEqual(len(segments), 3)
        self.assertEqual(segments[0]["text"], "你好 世界")
        self.assertEqual(segments[0]["start"], 0.0)
        self.assertEqual(segments[0]["end"], 1.25)
        self.assertEqual(segments[2]["start"], 4.0)
        self.assertEqual(segments[2]["end"], 5.0)


class PixelsTests(unittest.TestCase):
    def test_default_region(self):
        self.assertEqual(engine.pixels({}, 1920, 1080), (96, 821, 1728, 194))

    def test_clamps_values(self):
        self.assertEqual(engine.pixels({"x": -0.1, "y": 0.8, "width": 5, "height": 5}, 100, 100), (0, 80, 100, 20))


class LanguageCodeTests(unittest.TestCase):
    def test_aliases_and_default(self):
        self.assertEqual(engine.language_code("中文"), "ch")
        self.assertEqual(engine.language_code("英语"), "en")
        self.assertEqual(engine.language_code("fr"), "fr")
        self.assertEqual(engine.language_code(""), "auto")


if __name__ == "__main__":
    unittest.main()
