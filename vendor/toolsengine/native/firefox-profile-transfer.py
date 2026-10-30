#!/usr/bin/python3
"""Explicit standalone-MCP profile transfer. Never print credential contents."""
import fcntl
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import sys
import tempfile
import time

FILES = ('logins.json', 'key4.db', 'cert9.db', 'cookies.sqlite')
DATABASES = ('key4.db', 'cert9.db', 'cookies.sqlite')

def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise ValueError('Profile transfer requires plain files owned by this account.')
    return info

def digest(path):
    try:
        regular(path)
    except FileNotFoundError:
        return None
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').digest()

def plain_directory(path):
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if not stat.S_ISDIR(current.lstat().st_mode):
            raise ValueError('Profile transfer paths must be plain directories without links.')
    if path.stat().st_uid != os.getuid():
        raise ValueError('The Firefox profile belongs to another account.')

def running(profile):
    for proc in Path('/proc').iterdir():
        try:
            if not proc.name.isdigit() or proc.stat().st_uid != os.getuid():
                continue
            args = (proc / 'cmdline').read_bytes().decode().split('\0')
            if Path(os.readlink(proc / 'exe')).name not in ('firefox', 'firefox-esr'):
                continue
            if any(args[i] == '--profile' and Path(args[i+1]).resolve() == profile for i in range(len(args)-1)):
                return True
        except (OSError, UnicodeError):
            continue
    return False

def snapshot(source, stage):
    names = FILES + tuple(name + '-wal' for name in DATABASES)
    for _ in range(8):
        before = [digest(source / name) for name in names]
        for name, value in zip(names, before):
            target = stage / name
            if target.exists():
                target.unlink()
            if value is not None:
                fd = os.open(source / name, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as src, target.open('xb') as dst:
                    os.chmod(target, 0o600)
                    shutil.copyfileobj(src, dst)
        after = [digest(source / name) for name in names]
        copies = [digest(stage / name) for name in names]
        if before == after == copies:
            copied = [name for name in FILES if (stage / name).exists()]
            if not copied:
                raise ValueError('No login or cookie files were found to transfer.')
            if 'logins.json' in copied and 'key4.db' not in copied:
                raise ValueError('The saved-login database has no matching key database.')
            for name in DATABASES:
                if name not in copied:
                    continue
                # SQLite sees only the frozen private DB/WAL pair. It cannot
                # create a shared-memory file or checkpoint the user's source.
                destination = stage / (name + '.snapshot')
                with closing(sqlite3.connect(stage / name)) as src, closing(sqlite3.connect(destination)) as dst:
                    deadline = time.monotonic() + 10
                    def progress(*_):
                        if time.monotonic() > deadline:
                            raise TimeoutError('Firefox database snapshot timed out.')
                    src.backup(dst, pages=128, progress=progress)
                    if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                        raise ValueError('Firefox database snapshot failed integrity checking.')
                os.chmod(destination, 0o600)
                os.replace(destination, stage / name)
            return copied
        time.sleep(.1)
    raise ValueError('Firefox login state kept changing; no stable snapshot was copied.')

def transfer(source, target):
    source, target = Path(source).absolute(), Path(target).absolute()
    plain_directory(source)
    plain_directory(target)
    if source == target or source in target.parents or target in source.parents:
        raise ValueError('The source and dedicated profiles must be separate.')
    marker = target / '.toolsengine-agent-firefox'
    regular(marker)
    if marker.read_text() not in ('ToolsEngine dedicated Firefox profile v1\n', 'ToolsEngine agent Firefox profile v1\n'):
        raise ValueError('The destination is not a recognized dedicated profile.')
    if target.stat().st_mode & 0o077:
        raise ValueError('The dedicated profile must be private to this account.')
    lock = target / '.parentlock'
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        regular(lock)
        try:
            fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Close the dedicated Firefox before transferring login state.') from None
        if running(target):
            raise ValueError('Close the dedicated Firefox before transferring login state.')
        with tempfile.TemporaryDirectory(prefix='.toolsengine-transfer-', dir=target) as temporary:
            stage = Path(temporary)
            copied = snapshot(source, stage)
            backup = stage / 'previous'
            backup.mkdir(mode=0o700)
            affected = FILES + tuple(name + ending for name in DATABASES for ending in ('-wal', '-shm'))
            existing = []
            for name in affected:
                try:
                    regular(target / name)
                    existing.append(name)
                except FileNotFoundError:
                    pass
            moved, installed = [], []
            try:
                for name in existing:
                    os.replace(target / name, backup / name)
                    moved.append(name)
                for name in copied:
                    os.replace(stage / name, target / name)
                    installed.append(name)
            except BaseException:
                for name in installed:
                    (target / name).unlink()
                for name in moved:
                    os.replace(backup / name, target / name)
                raise
        return {'imported': True, 'copied': copied, 'sourceUnchanged': True}
    finally:
        os.close(fd)

if __name__ == '__main__':
    try:
        print(json.dumps(transfer(*sys.argv[1:])))
    except Exception as error:
        # Files and database values never enter an error response.
        print('Firefox profile transfer failed: ' + (str(error) if isinstance(error, (ValueError, TimeoutError)) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
