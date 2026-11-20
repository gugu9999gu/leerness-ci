"""Render, install or verify the project-local, standalone Leerness skill."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import stat
import sys
from textwrap import dedent

SOURCE = Path(__file__).resolve().parents[1] / "skills/leerness/SKILL.md"
HOSTS = {"claude": ".claude", "codex": ".agents"}


def rendered():
    source = SOURCE.read_bytes()
    header, body = source.split(b"\n---\n", 1)
    if not header.startswith(b"---\n") or b"\r" in source:
        raise ValueError(f"Expected UTF-8 skill with LF frontmatter in {SOURCE}")
    marker = b"# leerness-standalone v1 sha256=" + hashlib.sha256(source).hexdigest().encode()
    return header + b"\n" + marker + b"\n---\n" + body


def linked(path):
    if not os.path.lexists(path):
        return False
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0)
                                              & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def declared_name(path):
    with path.open(encoding="utf-8-sig") as stream:
        if stream.readline().strip() != "---":
            return None
        lines = []
        for line in stream:
            if line.rstrip() in ("---", "..."):
                break
            lines.append(line)
        else:
            raise ValueError(f"Unclosed skill frontmatter: {path}")
    header = dedent("".join(lines))
    rows = [s for s in header.splitlines() if s.strip() and not s.lstrip().startswith("#")]
    if all(re.fullmatch(r"[a-zA-Z][\w-]*:.*", s) for s in rows):
        names = [s.partition(":")[2].strip() for s in rows if s.startswith("name:")]
        if len(names) == 1:
            match = re.fullmatch(r"""(["']?)([\w.-]+)\1(?:\s+#.*)?""", names[0])
            if match:
                return match[2]
    try:
        import yaml
    except ImportError:
        raise ValueError(f"Cannot verify the YAML skill name in {path} with the standard library. "
                         "Use an environment with PyYAML to check the collision.") from None
    try:
        metadata = yaml.safe_load(header)
    except yaml.YAMLError as error:
        raise ValueError(f"Invalid skill frontmatter: {path}") from error
    if not isinstance(metadata, dict):
        raise ValueError(f"Expected skill metadata in {path}")
    return metadata.get("name")


def check_collisions(root, host, parent, folder):
    if host == "claude":
        command = root / ".claude/commands/leerness.md"
        if os.path.lexists(command):
            raise ValueError(f"Existing Claude command: {command}")
    if not parent.exists():
        return
    seen = set()

    def scan_error(error):
        raise error

    for at, directories, files in os.walk(parent, onerror=scan_error, followlinks=True):
        directory = Path(at)
        resolved = directory.resolve(strict=True)
        if resolved in seen:
            directories.clear()
            continue
        seen.add(resolved)
        candidate = directory / "SKILL.md"
        if "SKILL.md" not in files or candidate == folder / "SKILL.md":
            continue
        name = declared_name(candidate) or directory.name
        if name == "leerness":
            raise ValueError(f"Another project skill already uses leerness: {candidate}")


def project_skill(root, host, install):
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError(f"Project is not a directory: {root}")
    host_dir = root / HOSTS[host]
    parent = host_dir / "skills"
    folder = parent / "leerness"
    target = folder / "SKILL.md"
    for path in (host_dir, parent, folder, target):
        if linked(path):
            raise ValueError(f"Linked installation path: {path}")
    check_collisions(root, host, parent, folder)
    data = rendered()
    if folder.exists():
        if folder.is_dir() and set(folder.iterdir()) == {target} and target.is_file() and target.read_bytes() == data:
            return target
        raise ValueError(f"Existing skill differs or has extra files: {folder}. Preserve it before installing.")
    if not install:
        raise ValueError(f"Missing skill: {target}")
    parent.mkdir(parents=True, exist_ok=True)
    folder.mkdir()
    with target.open("xb") as stream:
        stream.write(data)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("render", help="write the generated SKILL.md to stdout")
    for action in ("install", "verify"):
        command = sub.add_parser(action)
        command.add_argument("host", choices=HOSTS)
        command.add_argument("project", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "render":
            sys.stdout.buffer.write(rendered())
        else:
            print(project_skill(args.project, args.host, args.action == "install"))
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
