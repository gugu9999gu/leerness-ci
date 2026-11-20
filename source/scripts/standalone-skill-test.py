"""Focused tests for the two distributions and safe project installation."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/standalone-skill.py"
HOSTS = {"claude": ".claude", "codex": ".agents"}


class StandaloneSkillTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()

    def run_tool(self, *args, script=SCRIPT, success=True):
        result = subprocess.run([sys.executable, str(script), *map(str, args)], capture_output=True)
        self.assertEqual(result.returncode == 0, success, result.stderr.decode(errors="replace"))
        return result.stdout if success else result.stderr

    def test_distributions(self):
        rendered = self.run_tool("render")
        source = (ROOT / "skills/leerness/SKILL.md").read_bytes()
        self.assertEqual(source.split(b"\n---\n", 1)[1], rendered.split(b"\n---\n", 1)[1])
        for host, folder in HOSTS.items():
            self.assertEqual((ROOT / folder / "skills/leerness/SKILL.md").read_bytes(), rendered)
            self.run_tool("verify", host, ROOT)

    def test_install_update_and_restore(self):
        next_release = Path(self.temp.name) / "next"
        next_script = next_release / "scripts" / SCRIPT.name
        next_script.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, next_script)
        source = next_release / "skills/leerness/SKILL.md"
        source.parent.mkdir(parents=True)
        source.write_bytes((ROOT / "skills/leerness/SKILL.md").read_bytes() + b"\nRelease 2.\n")
        for host, prefix in HOSTS.items():
            folder = self.root / prefix / "skills/leerness"
            target = folder / "SKILL.md"
            self.run_tool("install", host, self.root)
            stamp = target.stat().st_mtime_ns
            self.run_tool("install", host, self.root)
            self.assertEqual(stamp, target.stat().st_mtime_ns)
            self.run_tool("verify", host, self.root)
            self.run_tool("install", host, self.root, script=next_script, success=False)
            backup = Path(self.temp.name) / (host + "-previous")
            folder.rename(backup)
            self.run_tool("install", host, self.root, script=next_script)
            self.run_tool("verify", host, self.root, script=next_script)
            self.run_tool("verify", host, self.root, success=False)
            folder.rename(Path(self.temp.name) / (host + "-new"))
            backup.rename(folder)
            self.run_tool("verify", host, self.root)
            target.write_bytes(target.read_bytes() + b"local edit\n")
            edited = target.read_bytes()
            self.run_tool("install", host, self.root, success=False)
            self.assertEqual(edited, target.read_bytes())

    def test_project_collisions(self):
        for host, prefix in HOSTS.items():
            skills = self.root / prefix / "skills"
            other = skills / "custom"
            other.mkdir(parents=True)
            definition = other / "SKILL.md"
            for header in (b"name: 'leerness' # alias", b"  name: leerness\n  description: Existing project skill",
                           b'{name: leerness, description: "Custom"}'):
                definition.write_bytes(b"---\n" + header + b"\n---\nKeep this.")
                self.run_tool("install", host, self.root, success=False)
                self.assertFalse((skills / "leerness").exists())
            definition.write_bytes(b"---\nname: another\n---\nOther")
            directory = skills / "leerness"
            directory.mkdir()
            (directory / "custom.txt").write_bytes(b"owned")
            self.run_tool("install", host, self.root, success=False)
            self.assertEqual(list(directory.iterdir()), [directory / "custom.txt"])

    def test_claude_command_collision(self):
        command = self.root / ".claude/commands/leerness.md"
        command.parent.mkdir(parents=True)
        command.write_bytes(b"Existing command.")
        self.run_tool("install", "claude", self.root, success=False)
        self.assertEqual(command.read_bytes(), b"Existing command.")
        self.assertFalse((self.root / ".claude/skills").exists())

    def test_readonly_status_with_stale_index(self):
        def git(*args):
            return subprocess.check_output(["git", *args], cwd=self.root)

        git("init", "-q")
        git("config", "core.autocrlf", "false")
        tracked = self.root / "unchanged.txt"
        tracked.write_bytes(b"same contents\n")
        git("add", "unchanged.txt")
        old_time = tracked.stat().st_mtime + 20
        os.utime(tracked, (old_time, old_time))
        index = self.root / ".git/index"
        before = index.read_bytes()
        self.assertIn(b"unchanged.txt", git("--no-optional-locks", "status", "--short", "--branch"))
        self.assertEqual(before, index.read_bytes())

    @unittest.skipUnless(shutil.which("node"), "CLI coexistence requires a development Node runtime")
    def test_cli_project_migration_keeps_standalone_bytes(self):
        self.run_tool("install", "claude", self.root)
        target = self.root / ".claude/skills/leerness/SKILL.md"
        initial = target.read_bytes()
        cli = ["node", str(ROOT / "bin/leerness.js")]
        init = ["init", str(self.root), "--yes", "--mode", "standard", "--no-setup-agents",
                "--no-official-skills", "--no-mcp", "--no-auto-roadmap", "--no-banner"]
        edited = initial.replace(b"\n---\n", b"\n\ndisable-model-invocation: true\n---\n", 1)
        for cmd, expected in ((init, initial), (init, edited), (["migrate", str(self.root)], edited)):
            target.write_bytes(expected)
            result = subprocess.run(cli + cmd, cwd=self.root, capture_output=True, timeout=120)
            self.assertEqual(0, result.returncode, result.stderr[-1200:])
            self.assertEqual(expected, target.read_bytes())


if __name__ == "__main__":
    unittest.main()
