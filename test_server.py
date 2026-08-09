import tempfile
import unittest
from pathlib import Path

from server import RequestError, build_ytdlp_command, classify_downloader_error, find_output_file, validate_youtube_url


class YouTubeUrlValidationTests(unittest.TestCase):
    def test_accepts_video_page_urls(self):
        self.assertEqual(
            validate_youtube_url("https://www.youtube.com/watch?v=BaW_jenozKc"),
            "https://www.youtube.com/watch?v=BaW_jenozKc",
        )
        self.assertEqual(
            validate_youtube_url("https://youtu.be/BaW_jenozKc?t=10#fragment"),
            "https://youtu.be/BaW_jenozKc?t=10",
        )
        self.assertEqual(
            validate_youtube_url("https://www.youtube.com/shorts/BaW_jenozKc"),
            "https://www.youtube.com/shorts/BaW_jenozKc",
        )

    def test_rejects_direct_media_and_non_youtube_pages(self):
        cases = [
            "https://cdn.example.org/video.mp4",
            "https://www.youtube.com/video.mp4",
            "https://vimeo.com/123456789",
            "https://www.youtube.com/playlist?list=PL123456",
            "https://www.youtube.com/results?search_query=music",
            "https://www.youtube.com/watch?v=BaW_jenozKc&list=PL123456",
            "https://youtu.be/BaW_jenozKc?index=1",
        ]
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(RequestError):
                    validate_youtube_url(value)

    def test_rejects_unsafe_or_malformed_urls(self):
        cases = [
            "",
            "http://www.youtube.com/watch?v=BaW_jenozKc",
            "https://user:pass@www.youtube.com/watch?v=BaW_jenozKc",
            "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/watch?v=BaW_jenozKc&v=OtherId",
        ]
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(RequestError):
                    validate_youtube_url(value)


class DownloaderCommandTests(unittest.TestCase):
    def test_mp4_command_is_an_argument_list_and_disables_playlists(self):
        with tempfile.TemporaryDirectory() as directory:
            command = build_ytdlp_command(
                "https://www.youtube.com/watch?v=BaW_jenozKc",
                "mp4",
                Path(directory),
            )

        self.assertIsInstance(command, list)
        self.assertIn("--no-playlist", command)
        extractor_args_index = command.index("--extractor-args")
        self.assertEqual(command[extractor_args_index + 1], "youtube:player_client=tv_embedded,android_vr")
        self.assertIn("--merge-output-format", command)
        self.assertEqual(command[-1], "https://www.youtube.com/watch?v=BaW_jenozKc")

    def test_mp3_command_uses_audio_postprocessing(self):
        with tempfile.TemporaryDirectory() as directory:
            command = build_ytdlp_command(
                "https://youtu.be/BaW_jenozKc",
                "mp3",
                Path(directory),
            )

        self.assertIn("--extract-audio", command)
        self.assertIn("--audio-format", command)
        self.assertIn("mp3", command)

    def test_classifies_youtube_bot_check_separately_from_restricted_videos(self):
        code, message = classify_downloader_error("Sign in to confirm you're not a bot")
        self.assertEqual(code, "youtube-bot-check")
        self.assertIn("時間を置いて", message)


class OutputPathTests(unittest.TestCase):
    def test_accepts_only_a_non_empty_file_inside_work_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            work_dir = Path(directory)
            output = work_dir / "video.mp4"
            output.write_bytes(b"mp4")
            found = find_output_file(work_dir, f"{output}\n")
            self.assertEqual(found, output.resolve())

    def test_rejects_path_outside_work_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            work_dir = Path(directory)
            outside = work_dir.parent / "outside.mp4"
            outside.write_bytes(b"not returned")
            try:
                with self.assertRaises(RequestError):
                    find_output_file(work_dir, f"{outside}\n")
            finally:
                outside.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
