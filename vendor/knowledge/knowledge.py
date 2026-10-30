#!/usr/bin/env python3
"""Generic project-brief MCP. Python 3.11+, Git; no third-party dependencies."""
from __future__ import annotations
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
if os.name == 'nt':
    import msvcrt
else:
    import fcntl
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata

VERSION = '1.2.0'
DEFAULT_STALE_AFTER = 900
PROTOCOLS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')
SLUG = r'[a-z0-9][a-z0-9-]*'
MARKERS = ('TOOLSENABLED_FLEET_WORKER', 'FLEET_WORKER_ID', 'FLEET_NODE_ID',
           'FLEET_AGENT_ID', 'OPEN_SHELL_WORKER_ID', 'OPENSHELL_WORKER_ID',
           'TOOLSENABLED_OPENSHELL_WORKSPACE', 'TOOLSENABLED_HOST_NODE', 'TOOLSENABLED_HOST_SESSION')
STOPWORDS = frozenset('a an the please work on in at my our project help with to for of and i want me you this'.split())

class KnowledgeError(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.details = code, details
    def result(self):
        return {'error': self.code, 'message': str(self), **self.details}


def guard(interior='refuse', environ=None, proc=Path('/proc'), start_pid=None):
    """Inspect current marker names and ancestor process names, never argv/env."""
    if interior not in ('refuse', 'allow'):
        raise KnowledgeError('CONFIG_INVALID', 'interior must be refuse or allow')
    if interior == 'allow':
        return
    env = os.environ if environ is None else environ
    if any(env.get(key) not in (None, '', '0', 'false') for key in MARKERS):
        raise KnowledgeError('INTERIOR_WORKER_REFUSED', 'Fleet worker marker present')
    pid, visited = start_pid or os.getppid(), set()
    if os.name == 'nt':
        try:
            names = _windows_parent_names(pid)
        except Exception:
            raise KnowledgeError('INTERIOR_IDENTITY_UNKNOWN', 'Cannot verify owner process ancestry')
        if any(re.search(r'fleet|openshell|open-shell', name) for name in names):
            raise KnowledgeError('INTERIOR_WORKER_REFUSED', 'Fleet process ancestor present')
        return
    while pid > 1 and pid not in visited:
        visited.add(pid)
        try:
            comm = (proc / str(pid) / 'comm').read_text().strip().lower()
            stat = (proc / str(pid) / 'stat').read_text()
        except (OSError, UnicodeError):
            raise KnowledgeError('INTERIOR_IDENTITY_UNKNOWN', 'Cannot verify owner process ancestry')
        if re.search(r'fleet|openshell|open-shell', comm):
            raise KnowledgeError('INTERIOR_WORKER_REFUSED', 'Fleet process ancestor present')
        pid = int(stat[stat.rfind(')') + 2:].split()[1])


def _windows_parent_names(start_pid, run=subprocess.run, system_root=None):
    """Read native Windows parent image names; failure remains unknown/fail-closed."""
    if type(start_pid) is not int or start_pid < 1:
        raise OSError('Windows process identity is invalid')
    root = os.environ.get('SystemRoot') if system_root is None else system_root
    if not isinstance(root, str) or not root:
        raise OSError('Windows system root is unavailable')
    powershell = Path(root) / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe'
    if not powershell.is_absolute() or not powershell.is_file():
        raise OSError('Trusted Windows PowerShell is unavailable')
    # PowerShell 5.1 treats all remaining tokens after -Command as command text,
    # rather than populating $args. Embed only the already-converted integer PID
    # in encoded PowerShell so the query receives the exact starting identity.
    script = (r'''$ErrorActionPreference='Stop'; $id=[int]PID_VALUE; $startingPid=$id; Start-Sleep -Milliseconds 300; $seen=New-Object 'System.Collections.Generic.HashSet[int]'; $names=New-Object 'System.Collections.Generic.List[string]'; $processes=Get-CimInstance -ClassName Win32_Process -ErrorAction Stop; $byId=@{}; foreach($item in $processes){ $byId[[int]$item.ProcessId]=$item }; if(-not $byId.ContainsKey($id)){ throw 'Starting process identity unavailable' }; $startingName=[IO.Path]::GetFileNameWithoutExtension([string]$byId[$id].Name).ToLowerInvariant(); while($id -gt 1 -and $id -ne 4){ if(-not $seen.Add($id)){ throw 'Process parent cycle' }; if(-not $byId.ContainsKey($id)){ throw 'Process identity unavailable' }; $p=$byId[$id]; $name=[IO.Path]::GetFileNameWithoutExtension([string]$p.Name).ToLowerInvariant(); $names.Add($name); if($name -eq 'wininit'){ break }; $id=[int]$p.ParentProcessId }; ConvertTo-Json -Compress -InputObject @{startingPid=$startingPid;startingName=$startingName;names=@($names.ToArray())}'''
              .replace('PID_VALUE', str(int(start_pid))))
    encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
    result = run([str(powershell), '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                 capture_output=True, text=True, timeout=8, check=False)
    if result.returncode != 0:
        raise OSError('Windows process ancestry query failed')
    value = json.loads(result.stdout)
    if (not isinstance(value, dict) or type(value.get('startingPid')) is not int
            or value.get('startingPid') != start_pid
            or not isinstance(value.get('startingName'), str) or not value['startingName']
            or not isinstance(value.get('names'), list) or not value['names']
            or any(not isinstance(name, str) or not name for name in value['names'])
            or value['names'][0] != value['startingName']):
        raise OSError('Windows process ancestry response was invalid')
    return value['names']


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def git(repo, *args, timeout=5, env_extra=None, data=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
               GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=5 -o ConnectionAttempts=1',
               # Fetch never adds refs/remotes/origin/HEAD (Git 2.48+ default), so refs change only when data changes.
               GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='remote.origin.followRemoteHEAD', GIT_CONFIG_VALUE_0='never')
    env.update(env_extra or {})
    command = ['git']
    if os.name == 'nt':
        # Keep Git's ordinary Windows CRLF worktree normalization even though
        # user/global config is intentionally isolated from Knowledge operations.
        command += ['-c', 'core.autocrlf=true']
    command += ['-c', f'core.hooksPath={os.devnull}', '-c', 'credential.helper=',
                '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false',
                '-c', 'maintenance.auto=false', '-c', 'gc.auto=0']
    if repo is not None:
        command += ['-C', str(repo)]
    command += list(args)
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, start_new_session=True)
    try:
        out, _ = proc.communicate(data, timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        raise KnowledgeError('GIT_TIMEOUT', 'Git operation exceeded configured timeout')
    if proc.returncode:
        # No raw stderr: transports may echo private URLs or credentials.
        raise KnowledgeError('GIT_FAILED', 'Git operation failed', operation=args[0], exitCode=proc.returncode)
    return out


@dataclass(frozen=True)
class Config:
    repo: Path
    origin: str | None = None
    sync: str = 'background'
    interval: float = 300
    timeout: float = 30
    interior: str = 'refuse'
    author_name: str = 'Knowledge MCP'
    author_email: str = 'knowledge@localhost'
    stale_after: float = DEFAULT_STALE_AFTER
    attempt_history: int = 20
    # Seconds a write waits for another process's sync/update on the same clone before REPO_BUSY.
    lock_wait: float = 30
    # Seconds a read waits for a sync already running when the copy is stale (0 = never wait).
    read_wait: float = 3
    @classmethod
    def load(cls, value):
        if not isinstance(value, dict) or set(value) - {'repo','origin','sync','interval','timeout','interior','author_name','author_email','stale_after','attempt_history','lock_wait','read_wait'}:
            raise KnowledgeError('CONFIG_INVALID', 'Unknown configuration fields')
        value = dict(value)
        if not value.get('repo') and not value.get('origin'):
            raise KnowledgeError('CONFIG_INVALID', 'Set repo or origin')
        if value.get('origin') and (not isinstance(value['origin'], str) or value['origin'].startswith('-')):
            raise KnowledgeError('CONFIG_INVALID', 'Invalid origin')
        origin = value.get('origin')
        if origin and ((re.search(r'://[^/]*@', origin) and not origin.startswith('ssh://')) or re.search(r'://[^/]*[:][^/@]*@|[?\x00\r\n]', origin)):
            raise KnowledgeError('CONFIG_INVALID', 'Use an origin without embedded secrets or query parameters')
        if not value.get('repo'):
            base = Path(os.environ.get('XDG_CACHE_HOME', str(Path.home()/'.cache')))
            value['repo'] = base / 'knowledge' / hashlib.sha256(origin.encode()).hexdigest()[:20]
        value['repo'] = Path(value['repo']).expanduser().absolute()
        result = cls(**value)
        if result.sync not in ('background','off') or result.interior not in ('refuse','allow'):
            raise KnowledgeError('CONFIG_INVALID', 'Invalid sync or interior policy')
        for number in (result.timeout, result.interval, result.stale_after):
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not 0 < number < float('inf'):
                raise KnowledgeError('CONFIG_INVALID', 'timeout, interval and stale_after must be positive finite seconds')
        for number in (result.lock_wait, result.read_wait):
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not 0 <= number < float('inf'):
                raise KnowledgeError('CONFIG_INVALID', 'lock_wait and read_wait must be nonnegative finite seconds')
        if type(result.attempt_history) is not int or result.attempt_history < 1:
            raise KnowledgeError('CONFIG_INVALID', 'attempt_history must be a positive integer')
        return result


def normalize(value):
    return unicodedata.normalize('NFKC', value).casefold()


def tokens(value):
    return set(re.findall(r'[^\W_]+', normalize(value), re.UNICODE)) - STOPWORDS


DOCUMENT_MAGIC = '# Knowledge living document v1\n\n'
ENTRY_MARKER = b'<!-- knowledge-entry '
ENTRY_END = b'\n<!-- /knowledge-entry -->\n\n'


def render_entry(entry, history=False, anchor_prefix='', *, envelope=True):
    """Readable Markdown around byte-counted, unmodified UTF-8 payloads."""
    meta = {key:value for key,value in entry.items() if key != 'text'}
    meta['bytes'] = len(entry['text'].encode('utf-8'))
    identity = entry.get('id', 'checkpoint')
    prefix = f"### {identity} — {entry['date']}"
    if entry.get('status'):
        prefix += ' — '+entry['status']
    prefix += '\n'
    if not envelope:
        # Launcher delivery is readable guidance, without storage metadata or
        # links into HISTORY which is deliberately absent from that view.
        return prefix+entry['text']+'\n\n'
    if 'id' in entry:
        anchor = anchor_prefix+('history-' if history else '')+entry['id'].lower()
        prefix += f'<a id="{anchor}"></a>\n'
        if history:
            prefix += f'<a id="{anchor_prefix+entry["id"].lower()}"></a>\n'
    if history and entry.get('supersededAt'):
        replacement = entry.get('replacement')
        prefix += 'Superseded '+entry['supersededAt']
        prefix += f' by {replacement} ([replacement](#{anchor_prefix+replacement.lower()}))\n' if replacement else ' — retired; no replacement\n'
    if not history and entry.get('supersedes'):
        old = entry['supersedes']
        prefix += f'Supersedes [{old}](#{anchor_prefix}history-{old.lower()})\n'
    return prefix+'<!-- knowledge-entry '+json.dumps(meta, sort_keys=True, separators=(',',':'))+' -->\n'+entry['text']+ENTRY_END.decode()


def render_document(document):
    return (DOCUMENT_MAGIC+'## CURRENT\n\n'+''.join(render_entry(x) for x in document['current'])+
            '## HISTORY\n\n'+''.join(render_entry(x, True) for x in document['history']))


def render_current(document):
    """Plain agent-facing CURRENT; the canonical parser remains parse_document."""
    return '## CURRENT\n\n'+''.join(render_entry(x, envelope=False) for x in document['current'])


def sync_summary(last_success, last_failed=False, *, stale_after=DEFAULT_STALE_AFTER, at=None):
    """One-line launcher status using the same freshness policy as the MCP."""
    stamp = datetime.fromisoformat(last_success) if last_success else None
    age = max(0, ((at or datetime.now(timezone.utc))-stamp).total_seconds()) if stamp else None
    line = 'SYNC: Last successful sync: '+(f'{stamp.isoformat()}; age {age:.1f}s' if age is not None else 'unknown; age unknown')
    if last_failed or age is None or age > stale_after:
        line += '; this copy may be outdated'
    return line


def parse_document(content):
    """Read only canonical envelopes; payload headings/markers are never parsed."""
    if not content.startswith(DOCUMENT_MAGIC):
        raise KnowledgeError('DOCUMENT_INVALID', 'Not a living document')
    data = content.encode('utf-8')
    position = len((DOCUMENT_MAGIC+'## CURRENT\n\n').encode())
    if not data.startswith((DOCUMENT_MAGIC+'## CURRENT\n\n').encode()):
        raise KnowledgeError('DOCUMENT_INVALID', 'Missing CURRENT section')
    document = {'current':[], 'history':[]}
    section, history_seen = 'current', False
    try:
        while position < len(data):
            if data.startswith(b'## HISTORY\n\n', position):
                if history_seen:
                    raise ValueError('Duplicate HISTORY')
                section, history_seen = 'history', True
                position += len(b'## HISTORY\n\n')
                continue
            start = position
            marker = data.index(ENTRY_MARKER, position)
            end = data.index(b' -->\n', marker)
            meta = json.loads(data[marker+len(ENTRY_MARKER):end])
            if not isinstance(meta, dict):
                raise ValueError('Entry metadata must be an object')
            length = meta.pop('bytes')
            if type(length) is not int or length < 0:
                raise ValueError('Invalid byte length')
            position = end+len(b' -->\n')
            meta['text'] = data[position:position+length].decode('utf-8', 'strict')
            position += length
            if not data.startswith(ENTRY_END, position):
                raise ValueError('Invalid entry end')
            position += len(ENTRY_END)
            # Reject ambiguous or hand-edited envelopes rather than drop bytes.
            if data[start:position] != render_entry(meta, section=='history').encode():
                raise ValueError('Noncanonical entry')
            document[section].append(meta)
        if not history_seen:
            raise ValueError('Missing HISTORY')
        seen = set()
        for section, entries in document.items():
            for entry in entries:
                datetime.fromisoformat(entry['date'])
                if section == 'current' and ('id' not in entry or 'supersededAt' in entry):
                    raise ValueError('Invalid current decision')
                if 'id' in entry:
                    if not re.fullmatch(r'D[1-9][0-9]*', entry['id']) or entry['id'] in seen:
                        raise ValueError('Duplicate or invalid decision id')
                    seen.add(entry['id'])
        return document
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise KnowledgeError('DOCUMENT_INVALID', 'Malformed living document; no content was discarded')


def migrate_w4(original, date):
    """Pure, deterministic converter; the entire original becomes unreviewed D1."""
    content = original.decode('utf-8', 'strict')
    if content.startswith(DOCUMENT_MAGIC):
        parse_document(content)
        return original
    datetime.fromisoformat(date)
    return render_document({'current':[{'id':'D1','date':date,'status':'unreviewed','text':content}], 'history':[]}).encode()


def brief_view(documents, slug, include_history=False, project_path=None):
    """Global CURRENT, project CURRENT, then optional histories; exact offsets."""
    paths = [('rules/global.md','GLOBAL RULES'), (project_path or f'projects/{slug}/brief.md',f'PROJECT {slug}')]
    pieces, segments, offset = [], [], 0
    for section in (['current','history'] if include_history else ['current']):
        for path, label in paths:
            anchor_prefix = 'global-' if path=='rules/global.md' else f'project-{slug}-'
            piece = f'## {label} — {section.upper()}\n\n'+''.join(render_entry(x, section=='history', anchor_prefix) for x in documents[path][section])
            if pieces:
                pieces.append('\n\n')
                offset += 2
            segments.append({'path':path,'section':section.upper(),'offset':offset,'length':len(piece)})
            pieces.append(piece)
            offset += len(piece)
    return ''.join(pieces), segments


def read_snapshot(repo, timeout):
    revision = git(repo, 'rev-parse', 'HEAD', timeout=timeout).decode().strip()
    entries = git(repo, 'ls-tree', '-rz', revision, timeout=timeout).split(b'\0')
    paths, tree = {}, {}
    for entry in filter(None, entries):
        info, path = entry.split(b'\t', 1)
        name = path.decode('utf-8', 'strict')
        tree[name] = info.split()
        if name in ('INDEX.md','MANIFEST.json','rules/global.md') or re.fullmatch('projects/'+SLUG+'/brief.md', name):
            mode, typ, oid = info.split()
            if mode not in (b'100644', b'100755') or typ != b'blob':
                raise KnowledgeError('LAYOUT_INVALID', 'Brief layout must contain ordinary files')
            paths[name] = oid
    if not {'INDEX.md','MANIFEST.json','rules/global.md'} <= paths.keys():
        raise KnowledgeError('LAYOUT_INVALID', 'Missing INDEX.md, MANIFEST.json or rules/global.md')
    payload = git(repo, 'cat-file', '--batch', timeout=timeout, data=b''.join(x+b'\n' for x in paths.values()))
    files, pos = {}, 0
    for name in paths:
        end = payload.index(b'\n', pos)
        length = int(payload[pos:end].split()[-1])
        pos = end+1
        files[name] = payload[pos:pos+length].decode('utf-8', 'strict')
        pos += length+1
    manifest = json.loads(files['MANIFEST.json'])
    if not isinstance(manifest, dict):
        raise KnowledgeError('LAYOUT_INVALID', 'Manifest must be an object')
    projects, project_paths = {}, {}
    pattern = re.compile(r'^- `('+SLUG+r')`(?: \((active|archive)\))?: (.+)$')
    unmapped = False
    for line in files['INDEX.md'].splitlines():
        if line.startswith('#'):
            unmapped = line == '## Unmapped titles'
        if unmapped and re.fullmatch(r'- .+ \('+SLUG+r':[1-9][0-9]*\)', line):
            continue
        match = pattern.fullmatch(line)
        if not match:
            if line.lstrip().startswith(('- ', '* ', '+ ')):
                raise KnowledgeError('LAYOUT_INVALID', 'Unrecognized INDEX entry: '+line, row=line)
            continue
        slug, state, body = match.groups()
        path = f'projects/{slug}/brief.md'
        link = re.fullmatch(r'\[[^\]\r\n]*\]\(([^()\r\n]+)\)', body)
        if link:
            path = link[1]
            parts = path.split('/')
            if (not all(re.fullmatch(r'[A-Za-z0-9._-]+', p) and p not in ('.','..') for p in parts)
                    or not (path.startswith(f'projects/{slug}/') or path == f'archive/{slug}.md')):
                raise KnowledgeError('LAYOUT_INVALID', 'Unsafe INDEX brief link: '+line, row=line)
        elif state is None:
            raise KnowledgeError('LAYOUT_INVALID', 'Unrecognized INDEX entry: '+line, row=line)
        if state == 'archive' or (link and ('archive' in path.split('/')[:-1])):
            continue
        if slug in projects or path not in tree:
            raise KnowledgeError('LAYOUT_INVALID', 'Duplicate INDEX slug or missing brief: '+line, slug=slug, row=line)
        if path not in files:
            mode, typ, oid = tree[path]
            if mode not in (b'100644', b'100755') or typ != b'blob':
                raise KnowledgeError('LAYOUT_INVALID', 'INDEX brief must be an ordinary file: '+line, row=line)
            files[path] = git(repo, 'cat-file', 'blob', oid.decode(), timeout=timeout).decode('utf-8', 'strict')
        project_paths[slug] = path
        fields = [] if link else body.split('; ')
        locations = {}
        while len(fields) > 1 and re.match(r'[^:; ]+:(?:/|[A-Za-z]:[\\/])', fields[-1]):
            host, path = fields.pop().split(':', 1)
            if host in locations:
                raise KnowledgeError('LAYOUT_INVALID', 'Duplicate machine location', slug=slug)
            locations[host] = path
        projects[slug] = {'slug':slug, 'summary':'; '.join(fields), 'locations':dict(sorted(locations.items()))}
    documents = {}
    for path, text in files.items():
        if path=='rules/global.md' or path in project_paths.values() or re.fullmatch('projects/'+SLUG+'/brief.md', path):
            if text.startswith(DOCUMENT_MAGIC):
                documents[path] = parse_document(text)
            else:
                migration_date = git(repo,'log','-1','--format=%cI',revision,'--',path,timeout=timeout).decode().strip()
                documents[path] = parse_document(migrate_w4(text.encode(), migration_date).decode())
    briefs = {}
    for slug in projects:
        path = project_paths[slug]
        if not projects[slug]['summary']:
            projects[slug]['summary'] = next((line.strip() for entry in documents[path]['current']
                for line in entry['text'].splitlines() if line.strip() and not line.lstrip().startswith(('#','<!--'))), '')
        content, segments = brief_view(documents, slug, project_path=path)
        briefs[slug] = {'content':content,'sha256':hashlib.sha256(content.encode()).hexdigest(),
                        'segments':segments,'tokens':tokens(' '.join(x['text'] for x in documents[path]['current']))}
    return {'revision':revision, 'files':files, 'projects':dict(sorted(projects.items())), 'briefs':briefs,'documents':documents,'project_paths':project_paths}


class Knowledge:
    def __init__(self, config, *, check_guard=True):
        self.config = config
        if check_guard:
            guard(config.interior)
        self._snapshot = None
        self._state_lock, self._operation_lock = threading.Lock(), threading.Lock()
        self._sync_thread = None
        self._last_attempt = 0
        self._sync = {'lastSync':None, 'lastAttempt':None, 'state':'never', 'error':None}
        self._attempts = []
        self._origin_revision = None
        self._sync_file = None
        self._origin = config.origin
        if config.repo.exists():
            self._load()
            self._restore_sync_state()
        elif not config.origin:
            raise KnowledgeError('REPO_MISSING', 'Configured repository does not exist')
        if config.sync == 'background':
            self.maybe_sync()

    def _load(self):
        snapshot = read_snapshot(self.config.repo, self.config.timeout)
        try:
            origin = git(self.config.repo, 'remote', 'get-url', 'origin', timeout=self.config.timeout).decode().strip()
        except KnowledgeError:
            origin = None
        if origin and (re.search(r'://[^/]*@', origin) and not origin.startswith('ssh://') or re.search(r'://[^/]*:[^/@]*@|[?\x00\r\n]', origin)):
            raise KnowledgeError('ORIGIN_UNSAFE', 'Use an origin without embedded authentication or query parameters')
        if origin and not re.search(r'^[a-zA-Z][a-zA-Z0-9+.-]*://|^[^/]+:', origin):
            origin = str((self.config.repo / origin).resolve())
        if self.config.origin and origin != self.config.origin:
            raise KnowledgeError('ORIGIN_MISMATCH', 'Configured origin differs from clone origin')
        with self._state_lock:
            self._snapshot, self._origin = snapshot, origin
        self._refresh_origin_revision()

    def _refresh_origin_revision(self):
        try:
            branch = git(self.config.repo,'symbolic-ref','--short','HEAD',timeout=self.config.timeout).decode().strip()
            revision = git(self.config.repo,'rev-parse','--verify','refs/remotes/origin/'+branch,timeout=self.config.timeout).decode().strip()
            with self._state_lock:
                self._origin_revision = revision
        except KnowledgeError:
            pass

    def _restore_sync_state(self):
        directory = git(self.config.repo,'rev-parse','--absolute-git-dir',timeout=self.config.timeout).decode().strip()
        self._sync_file = Path(directory)/'knowledge-sync.json'
        try:
            stored = json.loads(self._sync_file.read_text())
            if stored.get('version') != 1:
                return
            attempts = stored['attempts']
            for attempt in attempts:
                datetime.fromisoformat(attempt['time'])
                if attempt['result'] not in ('ok','failed') or attempt.get('reason') not in (None,'offline origin','non-fast-forward','timeout','dirty worktree','repository busy','sync failed'):
                    raise ValueError('Invalid sync record')
            if stored['sync']['lastSync']:
                datetime.fromisoformat(stored['sync']['lastSync'])
            with self._state_lock:
                self._sync = {key:stored['sync'][key] for key in self._sync}
                self._attempts = attempts[-self.config.attempt_history:]
                origin_revision = stored.get('originRevision')
                if stored.get('localRevision')==self._snapshot['revision'] and isinstance(origin_revision,str) and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}',origin_revision):
                    self._origin_revision = origin_revision
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def _save_sync_state(self):
        if self._sync_file is None:
            directory = git(self.config.repo,'rev-parse','--absolute-git-dir',timeout=self.config.timeout).decode().strip()
            self._sync_file = Path(directory)/'knowledge-sync.json'
        with self._state_lock:
            payload = json.dumps({'version':1,'sync':self._sync,'attempts':self._attempts,
                                  'originRevision':self._origin_revision,
                                  'localRevision':self._snapshot['revision'] if self._snapshot else None})
        descriptor, name = tempfile.mkstemp(prefix='knowledge-sync-', dir=self._sync_file.parent)
        with os.fdopen(descriptor,'w') as handle:
            handle.write(payload)
        os.replace(name, self._sync_file)

    def sync_header(self, local_revision=None):
        """Cached only: no disk reads, waiting, or network operations on reads."""
        with self._state_lock:
            state = dict(self._sync)
            attempt = dict(self._attempts[-1]) if self._attempts else None
            origin_revision = self._origin_revision
            revision = local_revision or (self._snapshot['revision'] if self._snapshot else None)
        stamp = state['lastSync']
        age = max(0, (datetime.now(timezone.utc)-datetime.fromisoformat(stamp)).total_seconds()) if stamp else None
        warning = 'this copy may be outdated' if (attempt and attempt['result']=='failed') or age is None or age > self.config.stale_after else None
        lines = ['SYNC', 'Last successful sync: '+(f'{stamp} UTC; age {age:.1f}s' if stamp else 'unknown; age unknown')]
        lines.append('Last attempt: '+(attempt['time']+' UTC; '+attempt['result']+((': '+attempt['reason']) if attempt.get('reason') else '') if attempt else 'none'))
        lines += ['Local revision: '+(revision or 'unknown'), 'Origin revision (last known): '+(origin_revision or 'unknown')]
        if warning:
            lines.append(warning)
        return {'lastSuccessfulSync':stamp,'ageSeconds':age,'lastAttempt':attempt,
                'inProgress':state['state']=='running','localRevision':revision,'originRevision':origin_revision,
                'staleAfterSeconds':self.config.stale_after,'warning':warning,'text':'\n'.join(lines)}

    @contextmanager
    def repo_lock(self, wait=0):
        """Exclusive clone lock with bounded waiting and native Windows/POSIX byte locks."""
        deadline = time.monotonic() + max(0, wait)
        acquired = self._operation_lock.acquire(timeout=wait) if wait > 0 else self._operation_lock.acquire(blocking=False)
        if not acquired:
            raise KnowledgeError('REPO_BUSY', 'Another sync or update in this process is still running; retry')
        handle = None
        locked = False
        try:
            directory = git(self.config.repo, 'rev-parse', '--absolute-git-dir', timeout=self.config.timeout).decode().strip()
            handle = open(Path(directory)/'knowledge.lock', 'a+b')
            if os.name == 'nt':
                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    handle.write(b'\0')
                    handle.flush()
                while True:
                    try:
                        handle.seek(0)
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                        locked = True
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise KnowledgeError('REPO_BUSY', 'Another knowledge process held the repository for the whole wait; retry')
                        time.sleep(0.05)
            else:
                while True:
                    try:
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        locked = True
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise KnowledgeError('REPO_BUSY', 'Another knowledge process held the repository for the whole wait; retry')
                        time.sleep(0.05)
            yield
        finally:
            if handle:
                if locked:
                    if os.name == 'nt':
                        try:
                            handle.seek(0)
                            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                        except OSError:
                            pass
                    else:
                        fcntl.flock(handle, fcntl.LOCK_UN)
                handle.close()
            self._operation_lock.release()

    def _follow_head(self):
        """Another process sharing this clone may have advanced it; reload if HEAD moved."""
        if not self.config.repo.exists():
            return
        try:
            head = git(self.config.repo, 'rev-parse', 'HEAD', timeout=self.config.timeout).decode().strip()
            with self._state_lock:
                current = self._snapshot['revision'] if self._snapshot else None
            if head != current:
                self._load()
        except KnowledgeError:
            pass

    def _stale(self):
        with self._state_lock:
            stamp = self._sync['lastSync']
        if not stamp:
            return True
        return (datetime.now(timezone.utc)-datetime.fromisoformat(stamp)).total_seconds() > self.config.stale_after

    def snapshot(self, wait=None):
        self._follow_head()
        self.maybe_sync()
        wait = self.config.read_wait if wait is None else wait
        if wait > 0 and self.config.sync == 'background' and self._stale():
            # A stale copy waits a bounded time for the sync that is already running, so the
            # first read of a session is current instead of warning that it may be outdated.
            with self._state_lock:
                thread = self._sync_thread
            if thread and thread.is_alive():
                thread.join(wait)
        with self._state_lock:
            value = self._snapshot
        if value is None:
            raise KnowledgeError('REPO_NOT_READY', 'Initial clone has not completed; check knowledge_status')
        return value

    def maybe_sync(self):
        if self.config.sync != 'background':
            return
        with self._state_lock:
            if self._sync_thread and self._sync_thread.is_alive():
                return
            if time.monotonic()-self._last_attempt < self.config.interval:
                return
            self._last_attempt = time.monotonic()
            self._sync.update(state='running')
            self._sync_thread = threading.Thread(target=self._sync_once, daemon=True)
            self._sync_thread.start()

    def _sync_once(self):
        stamp = now()
        reason, code = None, None
        with self._state_lock:
            self._sync.update(state='running')
        try:
            if not self.config.repo.exists():
                # Clone only to a fresh sibling. Rename publishes a complete copy.
                self.config.repo.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                stage = Path(tempfile.mkdtemp(prefix='.knowledge-clone-', dir=self.config.repo.parent))
                git(None, 'clone', '--no-local', '--', self.config.origin, str(stage/'repo'), timeout=self.config.timeout)
                read_snapshot(stage/'repo', self.config.timeout)
                (stage/'repo').chmod(0o700)
                os.rename(stage/'repo', self.config.repo)
            with self.repo_lock(wait=self.config.lock_wait):
                if git(self.config.repo, 'status', '--porcelain', '--ignored=matching', timeout=self.config.timeout):
                    raise KnowledgeError('DIRTY_REPO', 'Sync refuses a dirty worktree')
                git(self.config.repo, 'fetch', 'origin', timeout=self.config.timeout)
                self._refresh_origin_revision()
                with self._state_lock:
                    origin_revision = self._origin_revision
                if not origin_revision:
                    raise KnowledgeError('ORIGIN_MISSING','Origin branch is unknown')
                try:
                    git(self.config.repo,'merge-base','--is-ancestor','HEAD',origin_revision,timeout=self.config.timeout)
                except KnowledgeError as error:
                    if error.code=='GIT_TIMEOUT':
                        raise
                    # pull --ff-only also permits an already-ahead local branch.
                    try:
                        git(self.config.repo,'merge-base','--is-ancestor',origin_revision,'HEAD',timeout=self.config.timeout)
                    except KnowledgeError as reverse:
                        if reverse.code=='GIT_TIMEOUT':
                            raise
                        raise KnowledgeError('NON_FAST_FORWARD','Sync requires a fast-forward')
                git(self.config.repo,'merge','--ff-only','--no-edit','--no-overwrite-ignore',origin_revision,timeout=self.config.timeout)
                self._load()
            with self._state_lock:
                self._sync.update(lastSync=now(), state='ok', error=None)
        except (KnowledgeError, OSError, ValueError) as error:
            code = getattr(error,'code','SYNC_FAILED')
            reason = {'GIT_TIMEOUT':'timeout','NON_FAST_FORWARD':'non-fast-forward','GIT_FAILED':'offline origin',
                      'DIRTY_REPO':'dirty worktree','REPO_BUSY':'repository busy'}.get(code,'sync failed')
            with self._state_lock:
                self._sync.update(state='failed', error=getattr(error,'code','SYNC_FAILED'))
        finally:
            with self._state_lock:
                self._sync['lastAttempt'] = stamp
                self._attempts.append({'time':stamp,'result':'failed' if code else 'ok','reason':reason})
                self._attempts = self._attempts[-self.config.attempt_history:]
            try:
                self._save_sync_state()
            except (KnowledgeError, OSError):
                pass  # Freshness remains available in memory even on a read-only disk.

    def project_list(self):
        value = self.snapshot()
        return {'sync':self.sync_header(value['revision']),'revision':value['revision'], 'projects':list(value['projects'].values()), 'total':len(value['projects'])}

    def project_find(self, query):
        if not isinstance(query,str) or not query.strip():
            raise KnowledgeError('INVALID_ARGUMENT', 'query must be nonempty text')
        value, terms = self.snapshot(), tokens(query)
        results = []
        for project in value['projects'].values():
            slug = project['slug']
            fields = {'slug':(tokens(slug),12), 'summary':(tokens(project['summary']),6),
                      'locations':(tokens(' '.join(project['locations'].values())),2),
                      'brief':(value['briefs'][slug]['tokens'],1)}
            reasons = []
            for field, (vocab, weight) in fields.items():
                for term in sorted(terms & vocab):
                    reasons.append({'field':field, 'term':term, 'points':weight})
            if normalize(query).strip() == normalize(slug):
                reasons.append({'field':'slug','term':'exact query','points':40})
            score = sum(item['points'] for item in reasons)
            if score:
                results.append({**project, 'score':score, 'reasons':reasons})
        results.sort(key=lambda x:(-x['score'], x['slug']))
        return {'sync':self.sync_header(value['revision']),'revision':value['revision'], 'query':query, 'terms':sorted(terms),
                'scoring':'unique token overlap: slug 12, summary 6, locations 2, brief 1; exact slug query +40; ties slug ascending',
                'matches':results, 'total':len(results)}

    def project_brief(self, slug, offset=0, limit=16000, include_history=False):
        value = self.snapshot()
        self._project(value, slug)
        if type(offset) is not int or offset < 0 or type(limit) is not int or limit < 1:
            raise KnowledgeError('INVALID_ARGUMENT', 'offset is a nonnegative integer; limit is a positive integer')
        if type(include_history) is not bool:
            raise KnowledgeError('INVALID_ARGUMENT','include_history must be boolean')
        if include_history:
            content, segments = brief_view(value['documents'], slug, True, value['project_paths'][slug])
        else:
            content, segments = value['briefs'][slug]['content'], value['briefs'][slug]['segments']
        if offset > len(content):
            raise KnowledgeError('OFFSET_OUT_OF_RANGE', 'offset exceeds totalLength', totalLength=len(content))
        text = content[offset:offset+limit]
        end = offset + len(text)
        return {'sync':self.sync_header(value['revision']),'slug':slug, 'revision':value['revision'], 'offsetUnit':'unicode-code-points','include_history':include_history,
                'offset':offset,'limit':limit,'returnedLength':len(text),'totalLength':len(content),
                'nextOffset':end if end<len(content) else None,'hasMore':end<len(content),
                'segments':segments,
                'contentSha256':hashlib.sha256(content.encode()).hexdigest(), 'text':text}

    @staticmethod
    def _project(value, slug):
        if not isinstance(slug,str) or not re.fullmatch(SLUG,slug):
            raise KnowledgeError('INVALID_ARGUMENT', 'slug must be a safe lowercase project slug')
        if slug not in value['projects']:
            raise KnowledgeError('UNKNOWN_PROJECT', 'Project slug is absent from the active INDEX', slug=slug)

    def project_update(self, slug=None, checkpoint=None, expectedRevision=None, op='checkpoint', text=None, decision_id=None, scope='project'):
        if op not in ('add','supersede','retire','checkpoint') or scope not in ('project','global'):
            raise KnowledgeError('INVALID_ARGUMENT','Invalid operation or scope')
        if checkpoint is not None:
            if op != 'checkpoint' or text is not None:
                raise KnowledgeError('INVALID_ARGUMENT','checkpoint is a compatibility alias for text on op checkpoint')
            text = checkpoint
        if op != 'retire' and (not isinstance(text,str) or not text.strip() or '\x00' in text):
            raise KnowledgeError('INVALID_ARGUMENT', 'text must be nonempty text without NUL')
        if op == 'retire' and text is not None:
            raise KnowledgeError('INVALID_ARGUMENT','retire takes no replacement text')
        if op in ('supersede','retire'):
            if not isinstance(decision_id,str) or not re.fullmatch(r'D[1-9][0-9]*',decision_id):
                raise KnowledgeError('INVALID_ARGUMENT','supersede and retire require decision_id D<n>')
        elif decision_id is not None:
            raise KnowledgeError('INVALID_ARGUMENT','decision_id only applies to supersede or retire')
        if not isinstance(expectedRevision,str) or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}',expectedRevision):
            raise KnowledgeError('INVALID_ARGUMENT', 'expectedRevision must be a full Git revision')
        if scope == 'global' and slug is not None:
            raise KnowledgeError('INVALID_ARGUMENT','Omit slug for global rules')
        initial = self.snapshot(wait=0)
        if scope == 'project':
            self._project(initial, slug)
        repo, timeout = self.config.repo, self.config.timeout
        with self.repo_lock(wait=self.config.lock_wait):
            if git(repo, 'status', '--porcelain', timeout=timeout):
                raise KnowledgeError('DIRTY_REPO', 'Update refuses uncommitted changes')
            if not self._origin:
                raise KnowledgeError('ORIGIN_MISSING', 'project_update requires origin')
            branch = git(repo,'symbolic-ref','--short','HEAD',timeout=timeout).decode().strip()
            try:
                # Start from origin's latest state: another machine may have pushed since this clone last synced.
                self._catch_up(branch)
            except KnowledgeError as error:
                if error.code in ('NON_FAST_FORWARD','DIRTY_REPO'):
                    raise
                raise KnowledgeError('PUSH_FAILED','Origin is unreachable; nothing was written. Retry when origin is reachable',
                                     stage='fetch', cause=error.code)
            for _ in range(4):
                value = self._snapshot
                if scope == 'project':
                    self._project(value, slug)
                path = 'rules/global.md' if scope=='global' else value['project_paths'][slug]
                applied = self._already_applied(value['documents'][path], op, text, decision_id)
                if applied:
                    # Identical update already in origin (e.g. an earlier attempt whose outcome was unknown).
                    return {'slug':slug,'scope':scope,'op':op,'decisionId':applied[0],'previousRevision':expectedRevision,
                            'revision':value['revision'],'pushed':True,'localApplied':True,'alreadyApplied':True}
                self._check_conflict(expectedRevision, value, path)
                commit, stamp, new_id = self._stage_commit(value, path, scope, slug, op, text, decision_id, expectedRevision)
                before = self._origin_revision
                try:
                    git(repo,'push','--porcelain','origin',f'{commit}:refs/heads/{branch}',timeout=timeout)
                    break
                except KnowledgeError as error:
                    pushed = error
                try:
                    self._catch_up(branch)
                except KnowledgeError as error:
                    code = 'PUSH_OUTCOME_UNKNOWN' if pushed.code=='GIT_TIMEOUT' else 'PUSH_FAILED'
                    raise KnowledgeError(code,'Push did not report success and origin could not be rechecked. Retrying the same update is safe: '
                                         'one that already landed is reported as alreadyApplied',stagedRevision=commit,cause=error.code)
                if self._origin_contains(commit):
                    break
                if pushed.code == 'GIT_TIMEOUT':
                    raise KnowledgeError('PUSH_OUTCOME_UNKNOWN','Push timed out and origin does not show it yet. Retrying the same update is safe: '
                                         'one that already landed is reported as alreadyApplied',stagedRevision=commit)
                if self._origin_revision == before:
                    # Origin did not move, so it refused this commit itself (hook, permissions, disk).
                    raise KnowledgeError('PUSH_FAILED','Origin refused the update; nothing was written',stagedRevision=commit)
                # Origin advanced while we pushed (another machine updated it): rebuild on top of it and push again.
            else:
                raise KnowledgeError('PUSH_FAILED','Origin kept advancing during the update; nothing was written. Retry',stagedRevision=commit)
            with self._state_lock:
                self._origin_revision = commit
            try:
                git(repo,'merge','--ff-only','--no-edit','--no-overwrite-ignore',commit,timeout=timeout)
                self._load()
                with self._state_lock:
                    self._origin_revision = commit
            except KnowledgeError:
                raise KnowledgeError('PUSHED_LOCAL_REFRESH_REQUIRED','Origin accepted the update; local refresh incomplete. Do not repeat update.',
                                     revision=commit)
            try:
                self._save_sync_state()
            except (KnowledgeError, OSError):
                pass
            return {'slug':slug,'scope':scope,'op':op,'decisionId':new_id,'previousRevision':expectedRevision,'revision':commit,
                    'date':stamp,'pushed':True,'localApplied':True}

    def _catch_up(self, branch):
        """Fetch origin and fast-forward the clone (call with repo_lock held). Local-ahead clones are left as they are."""
        repo, timeout = self.config.repo, self.config.timeout
        git(repo, 'fetch', 'origin', timeout=timeout)
        self._refresh_origin_revision()
        with self._state_lock:
            origin_revision = self._origin_revision
        if not origin_revision:
            raise KnowledgeError('ORIGIN_MISSING','Origin branch is unknown')
        head = git(repo,'rev-parse','HEAD',timeout=timeout).decode().strip()
        if head != origin_revision:
            if self._is_ancestor(head, origin_revision):
                if git(repo,'status','--porcelain',timeout=timeout):
                    raise KnowledgeError('DIRTY_REPO','Update refuses uncommitted changes')
                git(repo,'merge','--ff-only','--no-edit','--no-overwrite-ignore',origin_revision,timeout=timeout)
            elif not self._is_ancestor(origin_revision, head):
                raise KnowledgeError('NON_FAST_FORWARD','Local clone has diverged from origin; repair it before updating')
        with self._state_lock:
            current = self._snapshot['revision'] if self._snapshot else None
            self._sync.update(lastSync=now(), state='ok', error=None)
        if current != git(repo,'rev-parse','HEAD',timeout=timeout).decode().strip():
            self._load()

    def _is_ancestor(self, older, newer):
        try:
            git(self.config.repo,'merge-base','--is-ancestor',older,newer,timeout=self.config.timeout)
            return True
        except KnowledgeError as error:
            if error.code == 'GIT_TIMEOUT':
                raise
            return False

    def _origin_contains(self, commit):
        with self._state_lock:
            origin_revision = self._origin_revision
        return bool(origin_revision) and self._is_ancestor(commit, origin_revision)

    @staticmethod
    def _already_applied(document, op, text, decision_id):
        """(decision id or None,) when an identical update is already recorded, else None."""
        wanted = text.strip() if isinstance(text, str) else None
        if op == 'add':
            match = next((x for x in document['current'] if 'supersedes' not in x and x['text'].strip()==wanted), None)
            return (match['id'],) if match else None
        if op == 'supersede':
            old = next((x for x in document['history'] if x.get('id')==decision_id and x.get('supersededAt')), None)
            if old and old.get('replacement'):
                match = next((x for x in document['current'] if x['id']==old['replacement']
                              and x.get('supersedes')==decision_id and x['text'].strip()==wanted), None)
                return (match['id'],) if match else None
            return None
        if op == 'retire':
            old = next((x for x in document['history'] if x.get('id')==decision_id and x.get('supersededAt')), None)
            return (None,) if old and not old.get('replacement') and not any(x['id']==decision_id for x in document['current']) else None
        match = next((x for x in document['history'] if x.get('kind')=='checkpoint' and x['text'].strip()==wanted), None)
        return (None,) if match else None

    def _check_conflict(self, expected, value, path):
        """Conflict only when the target document changed since the caller's read; updates elsewhere are fine."""
        if expected == value['revision']:
            return
        repo, timeout = self.config.repo, self.config.timeout
        if not self._is_ancestor(expected, value['revision']):
            raise KnowledgeError('REVISION_CONFLICT','expectedRevision is not in this repository history; reread the brief and retry with "revision"',
                                 revision=value['revision'], path=path)
        if not git(repo,'diff','--name-only',expected,value['revision'],'--',path,timeout=timeout).strip():
            return
        try:
            old = git(repo,'show',f'{expected}:{path}',timeout=timeout).decode('utf-8','strict')
            old_ids = {x['id'] for x in parse_document(old)['current']} if old.startswith(DOCUMENT_MAGIC) else set()
        except (KnowledgeError, UnicodeError):
            old_ids = set()
        changed = [{'id':x['id'],'date':x['date'],'text':x['text'][:600]} for x in value['documents'][path]['current'] if x['id'] not in old_ids]
        raise KnowledgeError('REVISION_CONFLICT',f'{path} changed since expectedRevision. Read "changed" (entries added since your read), '
                             'then retry with "revision"', revision=value['revision'], path=path, changed=changed[-10:])

    def _stage_commit(self, value, path, scope, slug, op, text, decision_id, expected):
        """Build the update commit on top of the clone's HEAD with Git plumbing: no clone, no worktree or index change."""
        repo, timeout = self.config.repo, self.config.timeout
        stamp = now()
        # Fresh detached data: mutating a staged document never mutates cached reads.
        document = json.loads(json.dumps(value['documents'][path]))
        old = None
        if op in ('supersede','retire'):
            old = next((x for x in document['current'] if x['id']==decision_id),None)
            if old is None:
                raise KnowledgeError('DECISION_NOT_CURRENT','Decision is absent or already superseded', decisionId=decision_id)
        identities = [int(x['id'][1:]) for group in document.values() for x in group if 'id' in x]
        new_id = 'D'+str(max(identities, default=0)+1) if op in ('add','supersede') else None
        if old is not None:
            document['current'].remove(old)
            document['history'].append({**old,'supersededAt':stamp,'replacement':new_id})
        if new_id:
            entry = {'id':new_id,'date':stamp,'text':text,'status':'reviewed'}
            if old is not None:
                entry['supersedes'] = decision_id
            document['current'].append(entry)
        if op == 'checkpoint':
            document['history'].append({'date':stamp,'kind':'checkpoint','text':text})
        addition = render_document(document)
        tree = {}
        for line in git(repo,'ls-tree','-rz',value['revision'],timeout=timeout).split(b'\0'):
            if line:
                info, name = line.split(b'\t',1)
                tree[name.decode('utf-8','strict')] = info.decode().split()
        rows = []
        # First update converts every living document in the same transaction (W4 content stays
        # verbatim as unreviewed D1); documents whose stored bytes are already canonical are unchanged.
        for document_path, original in value['documents'].items():
            rendered = render_document(document if document_path==path else original)
            if rendered == value['files'].get(document_path):
                continue
            mode = tree.get(document_path, ['100644'])[0]
            blob = git(repo,'hash-object','-w','--stdin',timeout=timeout,data=rendered.encode()).decode().strip()
            rows.append(f'{mode} {blob}\t{document_path}')
        # Preserve W4's extraction/conservation manifest byte-for-byte; append provenance to the audit file.
        audit = tree.get('CHECKPOINTS.jsonl')
        if audit and (audit[0] not in ('100644','100755') or audit[1] != 'blob'):
            raise KnowledgeError('LAYOUT_INVALID', 'Checkpoint audit cannot be a symlink')
        existing = git(repo,'cat-file','blob',audit[2],timeout=timeout) if audit else b''
        if existing and not existing.endswith(b'\n'):
            existing += b'\n'
        record = json.dumps({'slug':slug,'scope':scope,'op':op,'decisionId':new_id,'targetDecisionId':decision_id,'date':stamp,'baseRevision':expected,
                             'appendSha256':hashlib.sha256(addition.encode()).hexdigest(),'appendBytes':len(addition.encode())},sort_keys=True)+'\n'
        blob = git(repo,'hash-object','-w','--stdin',timeout=timeout,data=existing+record.encode()).decode().strip()
        rows.append(f'{audit[0] if audit else "100644"} {blob}\tCHECKPOINTS.jsonl')
        scratch = Path(tempfile.mkdtemp(prefix='knowledge-index-', dir=git(repo,'rev-parse','--absolute-git-dir',timeout=timeout).decode().strip()))
        try:
            env = {'GIT_INDEX_FILE':str(scratch/'index'),'GIT_AUTHOR_NAME':self.config.author_name,'GIT_AUTHOR_EMAIL':self.config.author_email,
                   'GIT_COMMITTER_NAME':self.config.author_name,'GIT_COMMITTER_EMAIL':self.config.author_email}
            git(repo,'read-tree',value['revision'],timeout=timeout,env_extra=env)
            git(repo,'update-index','--index-info',timeout=timeout,env_extra=env,data=''.join(r+'\n' for r in rows).encode())
            tree_id = git(repo,'write-tree',timeout=timeout,env_extra=env).decode().strip()
            commit = git(repo,'commit-tree',tree_id,'-p',value['revision'],'-m',f'knowledge: {op} {slug or "global"}',
                         timeout=timeout,env_extra=env).decode().strip()
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        return commit, stamp, new_id

    def knowledge_status(self, attempts=None):
        if attempts is None:
            attempts = self.config.attempt_history
        if type(attempts) is not int or attempts < 0:
            raise KnowledgeError('INVALID_ARGUMENT','attempts must be a nonnegative integer')
        self.maybe_sync()
        header = self.sync_header()
        with self._state_lock:
            return {'sync':header,'attempts':[dict(x) for x in self._attempts[-attempts:]] if attempts else [],'repoPath':str(self.config.repo),'origin':self._origin,
                    'revision':self._snapshot['revision'] if self._snapshot else None,
                    'ready':self._snapshot is not None,'syncPolicy':self.config.sync,
                    'syncTimeoutSeconds':self.config.timeout,'syncIntervalSeconds':self.config.interval,
                    'staleAfterSeconds':self.config.stale_after,'attemptHistorySize':self.config.attempt_history,
                    'interiorPolicy':self.config.interior,**self._sync}


def schema(properties, required=()):
    return {'type':'object','additionalProperties':False,'properties':properties,'required':list(required)}

TEXT = {'type':'string','minLength':1}
TOOLS = [
    {'name':'project_list','description':'List every active project, one-line INDEX summary and per-machine locations. Start here to orient.', 'inputSchema':schema({})},
    {'name':'project_find','description':'Rank projects for a natural-language task using deterministic explained token scoring; no model calls.', 'inputSchema':schema({'query':TEXT}, ['query'])},
    {'name':'project_brief','description':'Sync header, labelled global CURRENT then project CURRENT. HISTORY only with include_history. Exact Unicode code-point paging, revision, full length and SHA256. Continue at nextOffset with the same include_history; restart if revision changes.', 'inputSchema':schema({'slug':{'type':'string','pattern':'^'+SLUG+'$'},'offset':{'type':'integer','minimum':0,'default':0},'limit':{'type':'integer','minimum':1,'default':16000},'include_history':{'type':'boolean','default':False}}, ['slug'])},
    {'name':'project_update','description':'Revision-checked add, supersede, retire or historical checkpoint; commit and push origin. scope global omits slug. supersede/retire require decision_id. add/supersede/checkpoint require text (checkpoint alias supported). expectedRevision only conflicts when this project brief changed since that revision; REVISION_CONFLICT lists the new entries and the revision to retry with. Retrying an identical update is safe: one that already landed returns alreadyApplied.', 'inputSchema':schema({'slug':{'type':'string','pattern':'^'+SLUG+'$'},'scope':{'type':'string','enum':['project','global'],'default':'project'},'op':{'type':'string','enum':['add','supersede','retire','checkpoint'],'default':'checkpoint'},'text':TEXT,'decision_id':{'type':'string','pattern':'^D[1-9][0-9]*$'},'checkpoint':TEXT,'expectedRevision':{'type':'string','pattern':'^(?:[0-9a-f]{40}|[0-9a-f]{64})$'}},['expectedRevision'])},
    {'name':'knowledge_status','description':'Sync header, last N attempts (oldest first), cached revisions and background/ready state. No blocking network calls.', 'inputSchema':schema({'attempts':{'type':'integer','minimum':0}})},
]
for tool in TOOLS:
    tool['annotations'] = {'readOnlyHint':tool['name']!='project_update', 'destructiveHint':False,
                           'idempotentHint':tool['name']!='project_update','openWorldHint':tool['name']=='project_update'}


def call(knowledge, name, arguments):
    tool = next((t for t in TOOLS if t['name']==name),None)
    if tool is None:
        raise KnowledgeError('UNKNOWN_TOOL','Unknown tool')
    shape = tool['inputSchema']
    if not isinstance(arguments,dict) or set(arguments)-shape['properties'].keys() or not set(shape['required'])<=arguments.keys():
        raise KnowledgeError('INVALID_ARGUMENT','Unknown or missing tool arguments')
    return getattr(knowledge,name)(**arguments)


def serve(knowledge, source=sys.stdin, sink=sys.stdout):
    lock = threading.Lock()
    def send(value):
        with lock:
            sink.write(json.dumps(value,ensure_ascii=True,separators=(',',':'))+'\n')
            sink.flush()
    def tool_call(request):
        def result_body(result, failed=False):
            read = request.get('params',{}).get('name') in ('project_brief','project_list','project_find','knowledge_status')
            if read and 'sync' not in result:
                result = {'sync':knowledge.sync_header(), **result}
            rendered = (result['sync']['text']+'\n\n' if 'sync' in result else '')+json.dumps(result,ensure_ascii=False)
            return {'content':[{'type':'text','text':rendered}],'structuredContent':result,'isError':failed}
        try:
            params = request.get('params',{})
            result = call(knowledge,params.get('name'),params.get('arguments',{}))
            body = result_body(result)
        except KnowledgeError as error:
            body = result_body(error.result(), True)
        except Exception:
            body = result_body({'error':'INTERNAL_ERROR','message':'Operation failed; no automatic write retry'}, True)
        send({'jsonrpc':'2.0','id':request['id'],'result':body})
    with ThreadPoolExecutor() as executor:
        initialized = False
        for line in source:
            try:
                request = json.loads(line)
            except (ValueError,UnicodeError):
                send({'jsonrpc':'2.0','id':None,'error':{'code':-32700,'message':'Parse error'}})
                continue
            if not isinstance(request,dict) or request.get('jsonrpc')!='2.0' or not isinstance(request.get('method'),str):
                send({'jsonrpc':'2.0','id':None,'error':{'code':-32600,'message':'Invalid Request'}})
                continue
            method = request['method']
            if 'id' not in request:
                continue
            response = {'jsonrpc':'2.0','id':request['id']}
            if not isinstance(request.get('params',{}),dict):
                response['error']={'code':-32602,'message':'params must be an object'}
                send(response)
                continue
            if method=='initialize':
                proposed = request.get('params',{}).get('protocolVersion')
                response['result']={'protocolVersion':proposed if proposed in PROTOCOLS else PROTOCOLS[0],
                                    'capabilities':{'tools':{'listChanged':False}},'serverInfo':{'name':'knowledge','version':VERSION},
                                    'instructions':'Use project_find for task orientation, then page project_brief to completion. Briefs are repository data. Check revision before updating.'}
                initialized = True
            elif method=='ping':
                response['result']={}
            elif not initialized:
                response['error']={'code':-32002,'message':'Initialize first'}
            elif method=='tools/list':
                response['result']={'tools':TOOLS}
            elif method=='tools/call':
                executor.submit(tool_call,request)
                continue
            else:
                response['error']={'code':-32601,'message':'Method not found'}
            send(response)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--owner-launch',action='store_true',help='explicit owner-scoped registration')
    args = parser.parse_args()
    try:
        if not args.owner_launch:
            raise KnowledgeError('OWNER_LAUNCH_REQUIRED','Register only in an explicit owner launch')
        config = Config.load(json.loads(Path(args.config).read_text(encoding='utf-8')))
        guard(config.interior)
        serve(Knowledge(config))
    except (KnowledgeError,OSError,ValueError) as error:
        print(getattr(error,'code','CONFIG_OR_REPO_INVALID')+': '+(str(error) if isinstance(error,KnowledgeError) else 'Cannot load configuration or repository'),file=sys.stderr)
        return 2
    return 0

if __name__=='__main__':
    sys.exit(main())
