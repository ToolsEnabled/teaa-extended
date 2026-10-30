import importlib.util
import json
import os
import base64
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'vendor' / 'knowledge' / 'knowledge.py'
spec = importlib.util.spec_from_file_location('teaa_knowledge_windows_port_fixture', SOURCE)
knowledge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = knowledge
spec.loader.exec_module(knowledge)


class WindowsPortTests(unittest.TestCase):
    def test_native_ancestry_query_returns_only_process_names(self):
        calls = []
        def run(args, **kwargs):
            calls.append((args, kwargs))
            return SimpleNamespace(returncode=0, stdout='{"startingPid":123,"startingName":"node","names":["node","powershell"]}')
        with tempfile.TemporaryDirectory() as temp:
            system_root = Path(temp)
            powershell = system_root / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe'
            powershell.parent.mkdir(parents=True)
            powershell.touch()
            self.assertEqual(knowledge._windows_parent_names(123, run, str(system_root)), ['node', 'powershell'])
            self.assertEqual(calls[0][0][0], str(powershell))
        self.assertEqual(calls[0][0][3], '-EncodedCommand')
        encoded = calls[0][0][4]
        command = base64.b64decode(encoded).decode('utf-16le')
        self.assertIn('$id=[int]123', command)
        self.assertIn('$startingPid=$id', command)
        self.assertIn('Get-CimInstance -ClassName Win32_Process', command)
        self.assertIn('startingPid=$startingPid', command)
        self.assertNotIn('$args[0]', command)
        self.assertNotIn('-Property ProcessId,ParentProcessId,Name', command)
        self.assertNotIn('$args[0]', command)
        self.assertEqual(calls[0][1]['timeout'], 8)

    def test_unknown_native_ancestry_refuses_closed(self):
        def run(_args, **_kwargs):
            return SimpleNamespace(returncode=1, stdout='')
        with tempfile.TemporaryDirectory() as temp:
            powershell = Path(temp) / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe'
            powershell.parent.mkdir(parents=True)
            powershell.touch()
            with self.assertRaises(OSError):
                knowledge._windows_parent_names(123, run, temp)

    def test_empty_or_unbound_native_ancestry_refuses_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            powershell = Path(temp) / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe'
            powershell.parent.mkdir(parents=True)
            powershell.touch()
            for body in (
                '{"startingPid":123,"startingName":"node","names":[]}',
                '{"startingPid":123,"startingName":"","names":[""]}',
                '{"startingPid":124,"startingName":"node","names":["node"]}',
                '{"startingPid":123,"startingName":"node","names":["other"]}',
            ):
                def run(_args, _body=body, **_kwargs):
                    return SimpleNamespace(returncode=0, stdout=_body)
                with self.subTest(body=body), self.assertRaises(OSError):
                    knowledge._windows_parent_names(123, run, temp)

    def test_missing_trusted_powershell_refuses_closed_without_fallback(self):
        calls = []
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(OSError):
                knowledge._windows_parent_names(123, lambda *args, **kwargs: calls.append(args), temp)
        self.assertEqual(calls, [])

    def test_native_guard_preserves_worker_refusal(self):
        with patch.object(knowledge.os, 'name', 'nt'), patch.object(knowledge, '_windows_parent_names', return_value=['teaa', 'fleetV5']):
            with self.assertRaises(knowledge.KnowledgeError) as caught:
                knowledge.guard(environ={}, start_pid=123)
        self.assertEqual(caught.exception.code, 'INTERIOR_WORKER_REFUSED')

    def test_native_guard_keeps_owner_launch_on_verified_non_fleet_ancestry(self):
        with patch.object(knowledge.os, 'name', 'nt'), patch.object(knowledge, '_windows_parent_names', return_value=['teaa', 'node']):
            self.assertIsNone(knowledge.guard(environ={}, start_pid=123))

    @unittest.skipUnless(os.name == 'nt', 'native Windows process identity is exercised on Windows')
    def test_native_ancestry_contains_the_actual_starting_process(self):
        names = knowledge._windows_parent_names(os.getpid())
        self.assertTrue(names, 'native ancestry query must return a nonempty chain')
        self.assertIn(Path(sys.executable).stem.lower(), names)

    @unittest.skipUnless(os.name == 'nt', 'native Windows file locking is exercised on Windows')
    def test_native_repository_lock_creates_and_releases_lock_file(self):
        with tempfile.TemporaryDirectory(prefix='teaa-knowledge-lock-') as temp:
            repo = Path(temp) / 'repo'
            repo.mkdir()
            (repo / 'INDEX.md').write_text('# Knowledge\n', encoding='utf-8')
            (repo / 'MANIFEST.json').write_text('{}\n', encoding='utf-8')
            (repo / 'rules').mkdir()
            (repo / 'rules' / 'global.md').write_text('# Rules\n', encoding='utf-8')
            subprocess.run(['git', 'init', '--quiet', str(repo)], check=True, timeout=20)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Knowledge MCP', '-c', 'user.email=knowledge@localhost', 'add', 'INDEX.md', 'MANIFEST.json', 'rules/global.md'], check=True, timeout=20)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Knowledge MCP', '-c', 'user.email=knowledge@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Create lock fixture'], check=True, timeout=20)
            config = knowledge.Config(repo=repo, sync='off', interior='allow')
            server = knowledge.Knowledge(config, check_guard=False)
            with server.repo_lock():
                lock = repo / '.git' / 'knowledge.lock'
                self.assertTrue(lock.is_file())
                self.assertEqual(lock.stat().st_size, 1)
            self.assertTrue(lock.is_file())


if __name__ == '__main__':
    unittest.main(verbosity=2)
