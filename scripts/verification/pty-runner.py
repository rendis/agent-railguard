#!/usr/bin/env python3
"""Run one command in a controllable PTY for terminal contract tests."""

from __future__ import annotations

import argparse
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--columns", type=int, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--resize-file", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if not args.command:
        parser.error("a command is required after --")
    return args


def set_size(fd: int, columns: int, rows: int) -> None:
    if columns <= 0 or rows <= 0:
        raise ValueError("PTY dimensions must be positive")
    size = struct.pack("HHHH", rows, columns, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, size)


def read_size(path: Path, fallback: tuple[int, int]) -> tuple[int, int]:
    try:
        value = path.read_text(encoding="utf-8").strip()
        columns, rows = value.split("x", maxsplit=1)
        return int(columns), int(rows)
    except (FileNotFoundError, OSError, ValueError):
        return fallback


def main() -> int:
    args = parse_args()
    master, slave = pty.openpty()
    current_size = (args.columns, args.rows)
    set_size(slave, *current_size)
    child = subprocess.Popen(
        args.command,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave)
    stdin_fd = sys.stdin.fileno()
    stdout = sys.stdout.buffer
    next_resize_check = 0.0
    try:
        while True:
            now = time.monotonic()
            if now >= next_resize_check:
                next_resize_check = now + 0.02
                requested = read_size(args.resize_file, current_size)
                if requested != current_size:
                    current_size = requested
                    set_size(master, *current_size)
                    os.killpg(child.pid, signal.SIGWINCH)

            readable, _, _ = select.select([master, stdin_fd], [], [], 0.02)
            if stdin_fd in readable:
                data = os.read(stdin_fd, 4096)
                if data:
                    os.write(master, data)
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                stdout.write(data)
                stdout.flush()
            if child.poll() is not None and master not in readable:
                try:
                    while data := os.read(master, 65536):
                        stdout.write(data)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                stdout.flush()
                break
    finally:
        os.close(master)
        if child.poll() is None:
            try:
                child.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGTERM)
    return child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
