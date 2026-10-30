#!/usr/bin/python3
"""Bounded Firefox-only AT-SPI UI; no profile or credential-store access."""
import base64
import io
import fcntl
import secrets
import select
from xml.sax.saxutils import escape as xml_escape
import tempfile
import json
import os
import shutil
import stat
import subprocess
import sys
import time
import uuid
from collections import Counter
from pathlib import Path
import importlib.util
_secret_spec = importlib.util.spec_from_file_location('toolsengine_firefox_secrets', Path(__file__).with_name('firefox_secrets.py'))
_secret_module = importlib.util.module_from_spec(_secret_spec)
_secret_spec.loader.exec_module(_secret_module)
secret_vault = _secret_module.SecretVault()
sensitive_sources = set()
# Hidden mode keeps the agent Firefox off the person's desktop session bus.
# There it would hand its file chooser, print dialog, notifications and
# external links to the desktop portal and the notifier, which draw them on
# the person's screen. Instead it gets a session bus of its own, shared only
# with this helper, on which nothing can be started: no portal, no notifier,
# no other service. Its accessibility bus is private too (AT-SPI must reach
# Firefox there): the desktop's accessibility bus launcher is not used, since
# it may start services through the person's systemd session. What the
# accessibility bus starts (its registry) has no display or Wayland connection
# and a private runtime folder. Like the private display, the buses stay up
# after this helper exits; a receipt in the profile lets the next helper
# rejoin them, and buses whose daemon has gone are replaced.
BUS_VARIABLES = ('DBUS_SESSION_BUS_ADDRESS', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE', 'AT_SPI_BUS_ADDRESS')
BUS_PREFIX = 'toolsengine-bus-'
ACCESSIBILITY_CONFIGS = ('/etc/at-spi2/accessibility.conf', '/usr/share/defaults/at-spi2/accessibility.conf')
SESSION_CONFIG = """<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>{listen}</listen>
  <auth>EXTERNAL</auth>
  <!-- The standard session bus policy; AT-SPI does not work without it. -->
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
"""
private_bus = {'address': None, 'accessibility': None, 'error': None}
# The bus daemons outlive this helper on purpose; holding them here keeps
# Python from reporting them as abandoned subprocesses.
_bus_daemons = []

def _private_folder(path):
    info = Path(path).lstat()
    return stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077

def _bus_bases(profile):
    runtime = os.environ.get('XDG_RUNTIME_DIR', '')
    bases = []
    try:
        if runtime and os.path.isabs(runtime) and _private_folder(runtime):
            bases.append(Path(runtime))
    except OSError:
        pass
    return bases + [profile]

def _own_bus_folder(folder, profile):
    # Only a folder this helper made: named so, private, directly in a base.
    try:
        folder = Path(folder)
        return (folder.is_absolute() and folder.name.startswith(BUS_PREFIX)
                and folder.parent in _bus_bases(profile) and _private_folder(folder))
    except (OSError, TypeError, ValueError):
        return False

def _live_daemon(entry, socket):
    try:
        if not isinstance(entry, dict) or not isinstance(entry.get('pid'), int) or entry.get('address') != 'unix:path=' + str(socket):
            return False
        proc = Path('/proc', str(entry['pid']))
        args = (proc / 'cmdline').read_bytes().decode().split('\0')
        return (proc.stat().st_uid == os.getuid() and process_birth(entry['pid']) == entry.get('birth')
                and Path(os.readlink(proc / 'exe')).name == 'dbus-daemon'
                and '--address=' + entry['address'] in args and stat.S_ISSOCK(socket.lstat().st_mode))
    except (OSError, UnicodeError, IndexError, TypeError):
        return False

def _live_buses(saved, profile):
    if not isinstance(saved, dict) or not _own_bus_folder(saved.get('folder'), profile):
        return False
    folder = Path(saved['folder'])
    return _live_daemon(saved.get('session'), folder / 'bus') and _live_daemon(saved.get('accessibility'), folder / 'a11y')

def _start_daemon(daemon, config, socket, env, folder, started):
    address = 'unix:path=' + str(socket)
    proc = subprocess.Popen([daemon, '--config-file=' + str(config), '--nofork', '--nopidfile', '--address=' + address, '--print-address=1'],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env=env, cwd=str(folder), start_new_session=True, text=True)
    started.append(proc)
    _bus_daemons.append(proc)
    ready = proc.stdout.readline().strip() if select.select([proc.stdout], [], [], 5)[0] else ''
    proc.stdout.close()
    if not ready.startswith(address):
        raise ValueError('A private Firefox bus could not be started; the desktop session bus was not used.')
    return {'pid': proc.pid, 'birth': process_birth(proc.pid), 'address': address}

def start_private_bus():
    """Hidden mode: join or start the agent Firefox's own session and accessibility buses."""
    profile = Path(AGENT_PROFILE)
    if not profile.is_dir() or profile.is_symlink() or profile.stat().st_uid != os.getuid():
        raise ValueError('The dedicated Firefox profile must be a plain directory owned by this account.')
    daemon = shutil.which('dbus-daemon')
    accessibility = next((path for path in ACCESSIBILITY_CONFIGS if os.path.isfile(path)), None)
    if not daemon or not accessibility:
        raise ValueError('Hidden Firefox requires dbus-daemon and AT-SPI (at-spi2-core) for its private buses; it was not started on the desktop session bus.')
    lock = profile / '.toolsengine-bus.lock'
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not private_regular(lock):
            raise ValueError('The private Firefox bus lock is unsafe.')
        fcntl.flock(fd, fcntl.LOCK_EX)
        receipt = profile / '.toolsengine-bus.json'
        saved = None
        try:
            if private_regular(receipt):
                saved = json.loads(receipt.read_text())
        except (OSError, ValueError):
            saved = None
        if _live_buses(saved, profile):
            return saved['session']['address'], saved['accessibility']['address']
        if isinstance(saved, dict):
            for key in ('session', 'accessibility'):
                entry = saved.get(key)
                if _own_bus_folder(saved.get('folder'), profile) and _live_daemon(entry, Path(saved['folder']) / ('bus' if key == 'session' else 'a11y')):
                    os.kill(entry['pid'], 15)
            if _own_bus_folder(saved.get('folder'), profile):
                shutil.rmtree(saved['folder'], ignore_errors=True)
        folder = Path(tempfile.mkdtemp(prefix=BUS_PREFIX, dir=_bus_bases(profile)[0]))
        (folder / 'session.conf').write_text(SESSION_CONFIG.replace('{listen}', xml_escape('unix:path=' + str(folder / 'bus'))))
        env = {key: value for key, value in os.environ.items()
               if key not in BUS_VARIABLES + SERVICE_VARIABLES + ('DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY')}
        env['XDG_RUNTIME_DIR'] = str(folder)
        env['GTK_USE_PORTAL'] = '0'
        started = []
        try:
            session = _start_daemon(daemon, folder / 'session.conf', folder / 'bus', env, folder, started)
            # The registry it starts finds this bus through AT_SPI_BUS_ADDRESS.
            a11y = _start_daemon(daemon, accessibility, folder / 'a11y', {**env, 'DBUS_SESSION_BUS_ADDRESS': session['address'],
                                 'AT_SPI_BUS_ADDRESS': 'unix:path=' + str(folder / 'a11y')}, folder, started)
        except BaseException:
            for proc in started:
                if proc.poll() is None:
                    proc.terminate()
                    proc.wait(timeout=3)
            shutil.rmtree(folder, ignore_errors=True)
            raise
        saved = {'folder': str(folder), 'session': session, 'accessibility': a11y}
        with tempfile.NamedTemporaryFile(mode='w', dir=profile, delete=False) as stream:
            json.dump(saved, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(stream.name, receipt)
        return session['address'], a11y['address']
    finally:
        os.close(fd)

def require_private_bus():
    if private_bus['error'] or not private_bus['address']:
        raise ValueError(private_bus['error'] or 'The private Firefox session bus is not available; the desktop session bus is never used.')
    return private_bus['address'], private_bus['accessibility']

def foreign_bus_firefox():
    # An agent Firefox that an earlier ToolsEngine started on another session
    # bus (the desktop's) cannot be driven here, and its dialogs would reach
    # the person's screen. It is reported, not reused or closed.
    for proc in Path('/proc').iterdir():
        try:
            if not proc.name.isdigit() or not firefox_pid(proc.name):
                continue
            found = dict(item.split('=', 1) for item in (proc / 'environ').read_bytes().decode().split('\0') if '=' in item)
        except (OSError, UnicodeError, ValueError):
            continue
        if found.get('DBUS_SESSION_BUS_ADDRESS') != private_bus['address']:
            return int(proc.name)
    return None

def agent_bus_ready():
    require_private_bus()
    stale = foreign_bus_firefox()
    if stale:
        raise ValueError(f'The hidden Firefox (process {stale}) was started by an earlier ToolsEngine on another session bus, '
                         'where its dialogs can reach the person\'s screen. Quit that Firefox; the next browser call starts it on its private bus.')

def use_private_bus():
    # Before AT-SPI is loaded: this helper and the agent Firefox both use the
    # private buses. Without them, no bus is used at all, never the desktop's.
    for name in BUS_VARIABLES:
        os.environ.pop(name, None)
    try:
        private_bus['address'], private_bus['accessibility'] = start_private_bus()
        os.environ['DBUS_SESSION_BUS_ADDRESS'] = private_bus['address']
        os.environ['AT_SPI_BUS_ADDRESS'] = private_bus['accessibility']
    except Exception as error:
        private_bus['error'] = str(error)[:500] or 'The private Firefox session bus could not be started.'
        os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'disabled:'
        os.environ['AT_SPI_BUS_ADDRESS'] = 'disabled:'

receipts = {}
selected = None
tab_receipts = {}
# The owner's signed-in browser. Used only when this helper was NOT asked to
# drive the agent's hidden window. Snap gives it its own systemd scope, so it
# outlives this helper.
FIREFOX = ('/snap/bin/firefox', '-P', 'default')
AGENT_TARGET = os.environ.get('TOOLSENGINE_BROWSER_TARGET', '')
AGENT_PROFILE = os.environ.get('TOOLSENGINE_FIREFOX_PROFILE', '')
VISIBLE_DISPLAY = os.environ.get('TOOLSENGINE_VISIBLE_DISPLAY', '')
AGENT_MODE = AGENT_TARGET == 'hidden-window' and bool(AGENT_PROFILE)
_agent_display_ready = False
# gnome-shell runs as a systemd service; these describe that unit, not a desktop app.
SERVICE_VARIABLES = ('INVOCATION_ID', 'JOURNAL_STREAM', 'MANAGERPID', 'MEMORY_PRESSURE_WATCH',
                     'MEMORY_PRESSURE_WRITE', 'NOTIFY_SOCKET', 'SYSTEMD_EXEC_PID', 'WATCHDOG_PID',
                     'WATCHDOG_USEC', 'LISTEN_FDS', 'LISTEN_PID', 'LISTEN_FDNAMES')
# Snap Firefox shows file choosers through the desktop portal, not its own UI.
PORTALS = ('xdg-desktop-portal-gnome', 'xdg-desktop-portal-gtk')
# Seconds to wait for a started Firefox's window, for a running Firefox to
# expose one, for a file chooser the page is opening, for a chooser to close
# after Enter, and for the tab of a URL handed to Firefox.
LAUNCH_WAIT, EXPOSE_WAIT, CHOOSER_WAIT, CLOSE_WAIT, TAB_WAIT = 45, 10, 5, 10, 15
OPTION_ROLES = ('menu item', 'option', 'list item')
ACTIONS = ('click', 'press', 'activate', 'jump', 'switch', 'select', 'check', 'uncheck',
           'toggle', 'expand', 'collapse', 'open', 'close', 'clickancestor')
# Text goes out CHUNK characters at a time, keys TYPE_DELAY ms apart (SLOW_DELAY
# when asked to type slowly, or for the rest of the text once a chunk had to be
# retried). Before each chunk Firefox must be the foreground window and the
# control focused; after it the control must show everything typed so far within
# CHUNK_WAIT seconds plus 50 ms a character. A control that stops changing for
# STALL seconds has taken all it will; before a retry it must stay unchanged for
# QUIET seconds. src/firefox.js sizes its request timeout from these bounds.
CHUNK, CHUNK_WAIT, STALL, QUIET, TYPE_DELAY, SLOW_DELAY = 150, 5.0, 3.0, 4.0, 5, 25
# xdotool types "\n" as the Linefeed key, which web editors ignore, so each line
# break is a real key press: Enter, or Shift+Enter where Enter sends or submits.
NEWLINE_KEYS = {'Enter': 'Return', 'Shift+Enter': 'shift+Return'}
# xdotool only queues keys; Firefox applies them later. Before focus moves,
# wait this long after any key, and for `watch` (the control the last
# unconfirmed keys went to) to stop changing.
SETTLE = 0.25
# `commits` counts input that a repeat would duplicate: a click, a key press,
# Enter, a URL handed to Firefox. Once such input has gone out, a failed check
# is reported as such and never as an error, so no caller repeats a submit.
last_input = {'at': 0.0, 'watch': None, 'until': 0.0, 'commits': 0}

class Performed(Exception):
    """The action reached Firefox; the message says what could not be confirmed."""

def run(argv, timeout=5):
    return subprocess.check_output(argv, text=True, timeout=timeout).strip()

def run_status(argv, timeout=5):
    # wmctrl and windowactivate fail on a bare Xvfb. Callers that have a
    # hidden-display fallback need the failure, not an exception.
    try:
        return 0, subprocess.check_output(argv, stderr=subprocess.DEVNULL, text=True, timeout=timeout).strip()
    except subprocess.CalledProcessError as error:
        return error.returncode, (error.output or '').strip()
    except (OSError, subprocess.TimeoutExpired) as error:
        return 1, str(error)

def owner(pid, names=('firefox',)):
    p = Path('/proc') / str(pid)
    return (p.stat().st_uid == os.getuid()
            and Path(os.readlink(p / 'exe')).name in names)

def process_cmdline(pid):
    try:
        return Path('/proc', str(pid), 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf-8', 'replace')
    except OSError:
        return ''

def browser_main_command(command):
    # crashhelper and gfxtest live under the Firefox directory and inherit the
    # agent environment. They are not a second browser, and neither is a
    # content process.
    if not command or '-contentproc' in command:
        return False
    name = Path(command.split(None, 1)[0]).name if command.split(None, 1) else ''
    return name not in ('crashhelper', 'gfxtest', 'plugin-container', 'updater', 'crashreporter')

def firefox_pid(pid):
    # Agent mode only counts the Firefox this helper owns: its command line
    # carries the dedicated agent profile, the same ownership rule as the
    # 1.0.50 owned browser. The user's visible Firefox is left alone.
    if not owner(pid):
        return False
    command = process_cmdline(pid)
    if not browser_main_command(command):
        return False
    if not AGENT_MODE:
        return True
    try:
        args = Path('/proc', str(pid), 'cmdline').read_bytes().decode().split('\0')
    except (OSError, UnicodeError):
        return False
    return any(args[i] == '--profile' and args[i+1] == AGENT_PROFILE for i in range(len(args)-1))

def display_number(value):
    if not value or not str(value).startswith(':'):
        return None
    number = str(value)[1:].split('.')[0]
    return number if number.isdigit() else None

def process_birth(pid):
    return Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[19]

def private_regular(path):
    info = Path(path).lstat()
    return stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and not info.st_mode & 0o077

if AGENT_MODE:
    use_private_bus()

import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, GLib

Atspi.set_timeout(1500, 1500)

def claim_hidden_display(disp, auth):
    os.environ['DISPLAY'] = disp
    os.environ['XAUTHORITY'] = str(auth)
    os.environ.pop('MOZ_HEADLESS', None)
    global _agent_display_ready
    _agent_display_ready = True
    return disp

def display_lock_pid(number):
    # The X server writes its process id into the display's lock file.
    try:
        return int(Path(f'/tmp/.X{number}-lock').read_text().strip())
    except (OSError, ValueError):
        return None

def ensure_agent_display():
    """Use only a live Xvfb attested for this profile, with private Xauthority."""
    global _agent_display_ready
    if not AGENT_MODE:
        return os.environ.get('DISPLAY')
    if _agent_display_ready:
        return os.environ.get('DISPLAY')
    profile = Path(AGENT_PROFILE)
    if not profile.is_dir() or profile.is_symlink() or profile.stat().st_uid != os.getuid():
        raise ValueError('The dedicated Firefox profile must be a plain directory owned by this account.')
    lock = profile / '.toolsengine-display.lock'
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not private_regular(lock):
            raise ValueError('The private Firefox display lock is unsafe.')
        fcntl.flock(fd, fcntl.LOCK_EX)
        receipt = profile / '.toolsengine-display.json'
        try:
            if not private_regular(receipt):
                raise ValueError('Display receipt is unsafe.')
            saved = json.loads(receipt.read_text())
            if (not isinstance(saved, dict) or not isinstance(saved.get('pid'), int)
                    or not isinstance(saved.get('auth'), str)
                    or not saved['auth'].startswith('.toolsengine-xauthority-')
                    or Path(saved['auth']).name != saved['auth']
                    or display_number(saved.get('display')) is None):
                raise ValueError('Display receipt does not identify a private display.')
            proc = Path('/proc', str(saved['pid']))
            args = (proc / 'cmdline').read_bytes().decode().split('\0')
            auth = profile / saved['auth']
            expected_auth = ['-auth', str(auth)]
            safe = (proc.stat().st_uid == os.getuid()
                    and process_birth(saved['pid']) == saved['birth']
                    and Path(os.readlink(proc / 'exe')).name == 'Xvfb'
                    and saved['display'] in args
                    and any(args[i:i+2] == expected_auth for i in range(len(args)-1))
                    and display_number(saved['display']) != display_number(VISIBLE_DISPLAY)
                    and private_regular(auth))
            if safe:
                env = {**os.environ, 'DISPLAY': saved['display'], 'XAUTHORITY': str(auth)}
                result = subprocess.run(['xdotool', 'getdisplaygeometry'], env=env,
                                        capture_output=True, timeout=2)
                if result.returncode == 0:
                    return claim_hidden_display(saved['display'], auth)
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
            pass
        xvfb = shutil.which('Xvfb')
        xauth = shutil.which('xauth')
        if not xvfb or not xauth:
            raise ValueError('Hidden Firefox requires Xvfb and xauth. No visible-screen or unsandboxed fallback was started.')
        for number in range(97, 80, -1):
            disp = f':{number}'
            if display_number(disp) == display_number(VISIBLE_DISPLAY) or os.path.exists(f'/tmp/.X11-unix/X{number}') or os.path.exists(f'/tmp/.X{number}-lock'):
                continue
            auth = profile / ('.toolsengine-xauthority-' + secrets.token_hex(8))
            auth_fd = os.open(auth, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(auth_fd)
            cookie = secrets.token_hex(16)
            subprocess.run([xauth, '-f', str(auth)], input=f'add {disp} . {cookie}\n',
                           text=True, capture_output=True, check=True, timeout=3)
            proc = subprocess.Popen([xvfb, disp, '-screen', '0', '1280x800x24',
                                     '-nolisten', 'tcp', '-auth', str(auth)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    start_new_session=True)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and proc.poll() is None:
                # Another helper may start an Xvfb on the same free number at
                # the same moment; the display is ours only when its lock
                # names our Xvfb. The other Xvfb exits and the next number is tried.
                if os.path.exists(f'/tmp/.X11-unix/X{number}') and display_lock_pid(number) == proc.pid:
                    saved = {'pid': proc.pid, 'birth': process_birth(proc.pid),
                             'display': disp, 'auth': auth.name}
                    with tempfile.NamedTemporaryFile(mode='w', dir=profile, delete=False) as stream:
                        json.dump(saved, stream)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(stream.name, receipt)
                    return claim_hidden_display(disp, auth)
                time.sleep(.05)
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=3)
        raise ValueError('A private Firefox display could not be started; no visible display was used.')
    finally:
        os.close(fd)

def firefox_binary():
    for candidate in ('/snap/bin/firefox', '/usr/bin/firefox', '/usr/bin/firefox-esr'):
        if os.access(candidate, os.X_OK):
            return candidate
    return None

SNAP_ROOT = '/snap/firefox/current'
SNAP_FIREFOX = SNAP_ROOT + '/usr/lib/firefox/firefox'

def agent_firefox_command():
    # Use the same vendor Firefox binary in the private display. Its launch
    # below requires Ubuntu's installed Firefox user-namespace profile when
    # using the snap-mounted binary; the content sandbox is never disabled.
    if os.access(SNAP_FIREFOX, os.X_OK):
        libs = ':'.join((
            f'{SNAP_ROOT}/usr/lib/firefox',
            f'{SNAP_ROOT}/lib/x86_64-linux-gnu',
            f'{SNAP_ROOT}/usr/lib/x86_64-linux-gnu',
        ))
        return SNAP_FIREFOX, {
            'LD_LIBRARY_PATH': libs,
            'SNAP': SNAP_ROOT,
            'SNAP_NAME': 'firefox',
            'SNAP_INSTANCE_NAME': 'firefox',
        }
    return firefox_binary(), {}

# AT-SPI 2.62 names the button role "button" where earlier releases said
# "push button". Every role this helper reads comes through here, so
# snapshots, the actionable-role checks and browser.find_control use the one
# established name on either version.
ROLE_NAMES = {'button': 'push button'}

def role_of(obj):
    role = obj.get_role_name()
    return ROLE_NAMES.get(role, role)

def children(obj):
    return [obj.get_child_at_index(i) for i in range(min(obj.get_child_count(), 2000))]

def pump(seconds=0.0):
    # Deliver queued accessibility events so cached states are current.
    context = GLib.MainContext.default()
    until = time.monotonic() + seconds
    while True:
        while context.pending():
            context.iteration(False)
        if time.monotonic() >= until:
            return
        time.sleep(0.01)

def fresh_states(obj):
    pump()
    obj.clear_cache()
    return obj.get_state_set()

def windows():
    result = []
    for app in children(Atspi.get_desktop(0)):
        try:
            pid = app.get_process_id()
            if not firefox_pid(pid):
                continue
            for index, frame in enumerate(children(app)):
                if role_of(frame) in ('frame', 'dialog'):
                    result.append((f'{pid}:{index}', frame, pid))
        except Exception:
            continue
    return result

def firefox_running():
    for proc in Path('/proc').iterdir():
        try:
            if proc.name.isdigit() and firefox_pid(proc.name):
                return True
        except OSError:
            continue
    return False

def desktop_session():
    # The owner's graphical session, read from gnome-shell as terminal-browser does.
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if proc.stat().st_uid != os.getuid() or (proc / 'comm').read_text().strip() != 'gnome-shell':
                continue
            return dict(item.split('=', 1) for item in (proc / 'environ').read_bytes().decode().split('\0') if '=' in item)
        except (OSError, UnicodeError):
            continue
    return None

# The agent Firefox keeps its dialogs to itself, on its private display, where
# browser.show shows them with the page: its own file chooser and print
# preview instead of the desktop portal's, its own notification windows instead
# of the desktop notifier, downloads saved without a prompt, and no hand-off of
# a link or a downloaded file to another application.
HIDDEN_DIALOG_PREFS = tuple(f'user_pref("{name}", {value});\n' for name, value in (
    ('widget.use-xdg-desktop-portal.file-picker', 0),
    ('widget.use-xdg-desktop-portal.mime-handler', 0),
    ('widget.use-xdg-desktop-portal.open-uri', 0),
    ('widget.use-xdg-desktop-portal.settings', 0),
    ('widget.use-xdg-desktop-portal.location', 0),
    ('widget.use-xdg-desktop-portal.native-messaging', 0),
    ('alerts.useSystemBackend', 'false'),
    ('print.prefer_system_dialog', 'false'),
    ('print.tab_modal.enabled', 'true'),
    ('network.protocol-handler.external-default', 'false'),
    ('browser.download.useDownloadDir', 'true'),
    ('browser.download.always_ask_before_handling_new_types', 'false'),
    ('browser.download.open_pdf_attachments_inline', 'true'),
))

def ensure_agent_accessibility(profile):
    # A fresh profile does not expose a window to AT-SPI until this is forced.
    # The pref lives only in the agent profile, never the user's Firefox profile.
    path = Path(profile)
    path.mkdir(parents=True, exist_ok=True)
    pref = path / 'user.js'
    wanted = (
        'user_pref("accessibility.force_disabled", -1);\n',
        'user_pref("browser.sessionstore.resume_from_crash", false);\n',
        'user_pref("browser.sessionstore.max_resumed_crashes", 0);\n',
        'user_pref("browser.sessionstore.resume_session_once", false);\n',
        'user_pref("browser.startup.page", 0);\n',
        'user_pref("browser.aboutwelcome.enabled", false);\n',
        'user_pref("toolkit.startup.max_resumed_crashes", -1);\n',
        *HIDDEN_DIALOG_PREFS,
    )
    try:
        current = pref.read_text() if pref.exists() else ''
    except OSError:
        current = ''
    missing = ''.join(line for line in wanted if line.split('"')[1] not in current)
    if missing:
        pref.write_text(current + missing)
    prefs_js = path / 'prefs.js'
    try:
        stored = prefs_js.read_text()
    except OSError:
        stored = ''
    if 'toolkit.startup.recent_crashes' in stored:
        kept = [line for line in stored.splitlines(True) if 'toolkit.startup.recent_crashes' not in line]
        prefs_js.write_text(''.join(kept))
    # Crash recovery would select about:sessionrestore over the requested page.
    # Only this agent profile is cleared.
    root = path.resolve()
    for name in ('sessionstore.jsonlz4', 'sessionstore.json', 'sessionCheckpoints.json'):
        target = root / name
        try:
            if target.is_file() and target.resolve().is_relative_to(root):
                target.unlink()
        except OSError:
            pass
    backups = root / 'sessionstore-backups'
    if backups.is_dir() and backups.resolve().is_relative_to(root):
        for child in backups.iterdir():
            try:
                if child.is_file() and child.resolve().is_relative_to(root):
                    child.unlink()
            except OSError:
                pass

def start_agent_firefox(*arguments, purpose):
    # Dedicated profile on an owned private display. Missing display support
    # is an error; the user's visible screen is never a fallback.
    binary, extra = agent_firefox_command()
    if binary is None:
        raise ValueError(f'Firefox is not available, so the agent hidden window was not {purpose}.')
    if os.environ.get('MOZ_DISABLE_CONTENT_SANDBOX') or os.environ.get('MOZ_DISABLE_RDD_SANDBOX'):
        raise ValueError('Firefox sandbox opt-outs are set in the caller environment; no browser was started.')
    ensure_agent_accessibility(AGENT_PROFILE)
    display = ensure_agent_display()
    if VISIBLE_DISPLAY and display == VISIBLE_DISPLAY:
        raise ValueError('Refusing to start the agent Firefox on the user visible display.')
    env = {key: value for key, value in os.environ.items() if key not in SERVICE_VARIABLES}
    env.update(extra)
    if extra.get('LD_LIBRARY_PATH') and os.environ.get('LD_LIBRARY_PATH'):
        env['LD_LIBRARY_PATH'] = extra['LD_LIBRARY_PATH'] + ':' + os.environ['LD_LIBRARY_PATH']
    if VISIBLE_DISPLAY and env.get('DISPLAY') == VISIBLE_DISPLAY:
        env.pop('DISPLAY', None)
    env.pop('WAYLAND_DISPLAY', None)
    env['MOZ_ENABLE_WAYLAND'] = '0'
    env['GDK_BACKEND'] = 'x11'
    if display:
        env['DISPLAY'] = display
        env.pop('MOZ_HEADLESS', None)
    else:
        env.pop('DISPLAY', None)
        env['MOZ_HEADLESS'] = '1'
    env['GNOME_ACCESSIBILITY'] = '1'
    env['ACCESSIBILITY_ENABLED'] = '1'
    env['GTK_MODULES'] = 'gail:atk-bridge'
    env.pop('NO_AT_BRIDGE', None)
    env['MOZ_APP_REMOTINGNAME'] = 'toolsengine-agent-firefox'
    env['MOZ_DISABLE_AUTO_SAFE_MODE'] = '1'
    # Only the private session bus (use_private_bus), never the desktop's.
    for name in BUS_VARIABLES:
        env.pop(name, None)
    env['DBUS_SESSION_BUS_ADDRESS'], env['AT_SPI_BUS_ADDRESS'] = require_private_bus()
    env['GTK_USE_PORTAL'] = '0'
    # Ubuntu's installed Firefox AppArmor profile grants the user namespace
    # permission required by Firefox's own content sandbox. Keep that sandbox
    # on even when using the same vendor binary from its snap mount.
    prefix = []
    if binary == SNAP_FIREFOX:
        aa_exec = shutil.which('aa-exec')
        if not aa_exec or subprocess.run([aa_exec, '-p', 'firefox', '--', '/usr/bin/true'],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            raise ValueError('A sandboxed Firefox launch is unavailable; install a supported native Firefox or its AppArmor profile.')
        prefix = [aa_exec, '-p', 'firefox', '--']
    argv = [*prefix, binary, '--profile', AGENT_PROFILE]
    if not firefox_running():
        argv.append('--new-instance')
    argv.extend(arguments)
    subprocess.run(['/usr/bin/setsid', '-f', *argv], env=env,
                   cwd=env.get('HOME') or str(Path.home()),
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=10, check=True)

def start_firefox(*arguments, purpose):
    if AGENT_MODE:
        return start_agent_firefox(*arguments, purpose=purpose)
    # Firefox gets the desktop session's environment, never this agent's:
    # ToolsEngine's TMPDIR and client variables do not belong in the owner's browser.
    session = desktop_session()
    if session is None:
        raise ValueError(f'The owner desktop session (gnome-shell) was not found, so Firefox was not {purpose}.')
    if session.get('DISPLAY') != os.environ.get('DISPLAY'):
        raise ValueError(f'ToolsEngine uses DISPLAY {os.environ.get("DISPLAY")!r} but the owner desktop is {session.get("DISPLAY")!r}, so Firefox was not {purpose}; fix the MCP environment.')
    if not os.access(FIREFOX[0], os.X_OK):
        raise ValueError(f'{FIREFOX[0]} is not available, so Firefox was not {purpose}.')
    env = {key: value for key, value in session.items() if key not in SERVICE_VARIABLES}
    env['GNOME_ACCESSIBILITY'] = '1'
    subprocess.run(['/usr/bin/setsid', '-f', *FIREFOX, *arguments], env=env, cwd=env.get('HOME') or str(Path.home()),
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=10, check=True)

def page_tabs_in(frames):
    found = []
    for wid, frame, _pid in frames:
        def collect(obj, level=0):
            if level > 8:
                return
            try:
                role = role_of(obj)
            except Exception:
                return
            if role == 'page tab':
                try:
                    found.append((wid, obj, obj.get_name() or '', obj.get_state_set().contains(Atspi.StateType.SELECTED)))
                except Exception:
                    return
                return
            if role in ('document web', 'document frame'):
                return
            for child in children(obj):
                collect(child, level + 1)
        collect(frame)
    return found

def firefox_windows():
    if not AGENT_MODE:
        ws = windows()
        if ws:
            return ws
        started = not firefox_running()
        if started:
            start_firefox(purpose='started')
        deadline = time.monotonic() + (LAUNCH_WAIT if started else EXPOSE_WAIT)
        while time.monotonic() < deadline:
            pump(0.5)
            ws = windows()
            if ws:
                return ws
        if started:
            raise ValueError(f"Started the owner's Firefox (default profile), but no window appeared in the accessibility tree within {LAUNCH_WAIT} seconds.")
        raise ValueError('Firefox is running, but no same-owner Firefox window is exposed through AT-SPI. Firefox accessibility must be available in this desktop session.')
    # The hidden window is usable when its selected tab is the requested page,
    # not Firefox's crash-restore tab. This does not start a second process
    # when that Firefox is already running.
    agent_bus_ready()
    started = not firefox_running()
    if started:
        start_firefox(purpose='started')
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        pump(0.4)
        ws = windows()
        if not ws:
            continue
        tabs = page_tabs_in(ws)
        ready = [tab for tab in tabs if page_tab_ready(tab[2])]
        selected_ready = [tab for tab in ready if tab[3]]
        if selected_ready:
            return ws
        if ready:
            switch_to_tab(ready[0][1])
            continue
        if tabs:
            return ws
    ws = windows()
    if ws:
        return ws
    if started:
        raise ValueError('Started the agent Firefox in a hidden window, but no window appeared in the accessibility tree within 90 seconds.')
    raise ValueError('Firefox is running, but no same-owner Firefox window is exposed through AT-SPI. Firefox accessibility must be available in this desktop session.')

def window():
    global selected
    ws = firefox_windows()
    match = next((w for w in ws if w[0] == selected), None)
    if selected is not None and match is None:
        raise ValueError('Selected Firefox window no longer exists; list windows again.')
    match = match or ws[0]
    selected = match[0]
    return match

def protected(obj):
    return role_of(obj) == 'password text'

def x_windows(pid):
    candidates = []
    code, listing = run_status(['wmctrl', '-lp'])
    if code == 0:
        for line in listing.splitlines():
            parts = line.split(None, 4)
            if len(parts) == 5 and parts[2].isdigit() and int(parts[2]) == pid:
                candidates.append((parts[0], parts[4]))
    if candidates or not AGENT_MODE:
        return candidates
    # The hidden display is Xvfb with no window manager, so there is no EWMH
    # client list. xdotool search reads _NET_WM_PID from the X tree instead.
    code, listing = run_status(['xdotool', 'search', '--pid', str(pid), '--onlyvisible'])
    if code != 0:
        return []
    found = []
    for line in listing.splitlines():
        decimal = line.strip()
        if not decimal.isdigit():
            continue
        xid = '0x' + format(int(decimal), 'x')
        name_code, name = run_status(['xdotool', 'getwindowname', decimal])
        found.append((xid, name if name_code == 0 else ''))
    return found

def xid_for(frame, pid):
    candidates = x_windows(pid)
    name = frame.get_name() or ''
    exact = [x for x, title in candidates if title == name]
    if len(exact) == 1:
        return exact[0]
    if len(candidates) == 1:
        return candidates[0][0]
    titled = [x for x, title in candidates if title and name and (name in title or title in name)]
    if len(titled) == 1:
        return titled[0]
    raise ValueError('Firefox window cannot be identified uniquely on X11.')

def note_input(watch=None, limit=0.0, commit=False):
    last_input.update(at=time.monotonic(), watch=watch, until=time.monotonic() + limit)
    if commit:
        last_input['commits'] += 1

def send(argv, timeout=5, commit=False):
    # Recorded before xdotool runs: a failed or timed-out run may still have delivered keys.
    note_input(commit=commit)
    run(argv, timeout)
    last_input['at'] = time.monotonic()

def drain():
    # Let Firefox apply keys already sent before focus moves anywhere else.
    wait = SETTLE - (time.monotonic() - last_input['at'])
    if wait > 0:
        pump(wait)
    watch, last_input['watch'] = last_input['watch'], None
    if watch is None:
        return
    previous, steady = None, time.monotonic()
    while time.monotonic() < last_input['until']:
        pump()
        try:
            current = watch()
        except Exception:
            return
        now = time.monotonic()
        if current != previous:
            previous, steady = current, now
        elif now - steady >= 1.0:
            return
        time.sleep(0.05)

def foreground():
    # getactivewindow asks the window manager. A hidden Xvfb has none, so the
    # agent display uses X input focus, which windowfocus can set.
    if AGENT_MODE:
        code, out = run_status(['xdotool', 'getwindowfocus'])
        if code == 0 and out.strip().isdigit():
            return int(out.strip())
    return int(run(['xdotool', 'getactivewindow']))

def activate(frame, pid, what='Firefox'):
    xid = xid_for(frame, pid)
    activated, _out = run_status(['xdotool', 'windowactivate', '--sync', xid])
    if activated != 0:
        if not AGENT_MODE:
            raise ValueError(f'{what} could not be activated; nothing was done.')
        focused, _focus_out = run_status(['xdotool', 'windowfocus', '--sync', xid])
        if focused != 0:
            raise ValueError(f'{what} could not take input focus on the hidden display; nothing was done.')
    if foreground() != int(xid, 16):
        raise ValueError(f'{what} is not the foreground window: another window kept focus, so nothing was done.')
    return xid

def focus():
    drain()
    _, frame, pid = window()
    return activate(frame, pid)

def give_focus(obj):
    # Keys go to whatever has focus. Confirm it is this control before typing.
    xid = focus()
    if fresh_states(obj).contains(Atspi.StateType.FOCUSED):
        return xid
    component = obj.get_component_iface()
    if component is None or not component.grab_focus():
        raise ValueError('Firefox control could not receive focus; no keys were sent.')
    deadline = time.monotonic() + 2
    while not fresh_states(obj).contains(Atspi.StateType.FOCUSED):
        if time.monotonic() > deadline:
            raise ValueError('Firefox did not confirm focus on this control; no keys were sent.')
        pump(0.03)
    return xid

def interrupted(obj, xid):
    # Keys reach the X foreground window and Firefox's focused control. Check
    # both before every batch, so none lands in another window or field.
    if foreground() != int(xid, 16):
        return 'Firefox stopped being the foreground window'
    if not fresh_states(obj).contains(Atspi.StateType.FOCUSED):
        return 'the control lost focus'
    return None

def keys(key, commit=True):
    allowed = {'Enter':'Return', 'Return':'Return', 'Tab':'Tab', 'Escape':'Escape',
               'Backspace':'BackSpace', 'Delete':'Delete', 'ArrowDown':'Down',
               'ArrowUp':'Up', 'ArrowLeft':'Left', 'ArrowRight':'Right',
               'PageDown':'Next', 'PageUp':'Prior', 'Home':'Home', 'End':'End',
               'Control+a':'ctrl+a', 'Control+l':'ctrl+l', 'Control+t':'ctrl+t',
               'Control+Tab':'ctrl+Tab', 'Control+Shift+Tab':'ctrl+shift+Tab',
               'Alt+Left':'alt+Left', 'F5':'F5', 'space':'space'}
    if key not in allowed:
        raise ValueError('Key combination is not offered by the Firefox adapter.')
    xid = focus()
    send(['xdotool', 'key', '--clearmodifiers', allowed[key]], commit=commit)
    if foreground() != int(xid, 16):
        raise ValueError(f'{key} was pressed, but Firefox was not the foreground window right afterwards, so it may have reached another window')
    return xid

def press_enter(obj):
    # Enter acts on whatever has focus: confirm it is still this control.
    if not fresh_states(obj).contains(Atspi.StateType.FOCUSED):
        raise ValueError('the control lost focus, so Enter was not pressed')
    keys('Enter')

def text_of(obj, depth=0):
    # Rich editors expose paragraphs as embedded children (U+FFFC), in order.
    ti = obj.get_text_iface()
    if ti is None:
        return '', False
    text = Atspi.Text.get_text(ti, 0, min(Atspi.Text.get_character_count(ti), 40000)) or ''
    if '￼' not in text or depth > 3:
        return text, False
    kids = iter(children(obj))
    parts = []
    for char in text:
        child = next(kids, None) if char == '￼' else None
        parts.append(text_of(child, depth + 1)[0] if child is not None else char)
    return ''.join(parts), True

def plain(text):
    return text.replace('\r\n', '\n').replace(' ', ' ')

def squeeze(text):
    return ''.join(text.split())

def excerpt(text):
    return json.dumps(text if len(text) <= 200 else text[:90] + ' … ' + text[-90:], ensure_ascii=False)

def difference(shown, want):
    shown, want = plain(shown), plain(want)
    breaks = want.count('\n')
    if squeeze(shown) == squeeze(want):
        lost = breaks - shown.count('\n')
        if lost > 0 and shown.replace('\n', '') == want.replace('\n', ''):
            return f'the page dropped {lost} of {breaks} line breaks; every other character matches'
        return 'only spaces or line breaks differ'
    if squeeze(want).startswith(squeeze(shown)):
        return f'it holds only the first {len(shown)} of {len(want)} characters'
    return f'it holds {len(shown)} characters that differ from the {len(want)} requested'

def confirm_text(obj, text, limit):
    # Returning before Firefox shows the text lets queued keys land in
    # whichever control the next action focuses.
    want = plain(text)
    deadline = time.monotonic() + limit
    shown, changed, moved = None, time.monotonic(), False
    while True:
        pump()
        current, rich = text_of(obj)
        current = plain(current)
        # Paragraph breaks of rich editors are structure, not characters.
        if current == want or (rich and squeeze(current) == squeeze(want)):
            return None
        now = time.monotonic()
        if current != shown:
            moved = moved or shown is not None
            shown, changed = current, now
        elif moved and now - changed > STALL:
            return shown
        if now > deadline:
            return shown
        time.sleep(0.05)

def shows(obj, prefix, limit):
    # 'shown' once the control shows everything typed so far; otherwise
    # 'stalled' if it changed and then stopped, or 'idle' if it never changed.
    # Spacing is ignored here, since pages may drop blank lines; the final
    # check reports that. Address bars and file choosers may append a
    # selected completion.
    want = squeeze(plain(prefix))
    deadline = time.monotonic() + limit
    shown, changed, moved = None, time.monotonic(), False
    while True:
        pump()
        current = squeeze(plain(text_of(obj)[0]))
        if current.startswith(want):
            return 'shown'
        now = time.monotonic()
        if current != shown:
            moved = moved or shown is not None
            shown, changed = current, now
        elif moved and now - changed > STALL:
            return 'stalled'
        if now > deadline:
            return 'stalled' if moved else 'idle'
        time.sleep(0.03)

def settled(obj, prefix):
    # A retry is safe only once no more of the keys can be arriving: wait for a
    # QUIET window without any change ('quiet'), at most three windows.
    for _ in range(3):
        outcome = shows(obj, prefix, QUIET)
        if outcome != 'stalled':
            return 'shown' if outcome == 'shown' else 'quiet'
    return 'busy'

def landed(current, intended):
    # How much of the intended text the control holds as a prefix, or None if
    # it holds something else. Rich editors show paragraphs without their line
    # breaks, and may end with a placeholder break or space.
    i = 0
    for j, char in enumerate(current):
        while i < len(intended) and intended[i] == '\n' and char != '\n':
            i += 1
        if i < len(intended) and intended[i] == char:
            i += 1
        elif not current[j:].strip():
            return i
        else:
            return None
    return i

def pieces(text, position):
    # (start, end, chunk) spans of text from position; chunk is None for a line break.
    for number, line in enumerate(text[position:].split('\n')):
        if number:
            yield position, position + 1, None
            position += 1
        for offset in range(0, len(line), CHUNK):
            chunk = line[offset:offset + CHUNK]
            yield position, position + len(chunk), chunk
            position += len(chunk)

def type_into(obj, text, xid, delay, newline='Enter'):
    # report['stopped'] is None once everything shows in the control, else
    # (characters sent, reason). A chunk the control does not show is retried
    # once, more slowly, from what the control actually holds, so nothing it
    # already shows is typed twice.
    report = {'stopped': None, 'breaks': 0, 'retries': 0}
    position, retried = 0, False
    while position < len(text):
        start, end, chunk = next(pieces(text, position))
        reason = interrupted(obj, xid)
        if reason:
            report['stopped'] = (start, reason)
            return report
        if chunk is None:
            send(['xdotool', 'key', '--clearmodifiers', NEWLINE_KEYS[newline]])
            report['breaks'] += 1
            position = end
            continue
        send(['xdotool', 'type', '--clearmodifiers', '--delay', str(delay), '--', chunk],
             timeout=5 + len(chunk) * (0.02 + delay / 1000))
        outcome = shows(obj, text[:end], CHUNK_WAIT + len(chunk) * 0.05)
        if outcome != 'shown' and not retried:
            outcome = settled(obj, text[:end])
            held = landed(plain(text_of(obj)[0]), plain(text)) if outcome == 'quiet' else None
            if held is not None and held < end:
                position, retried, delay = held, True, SLOW_DELAY
                report['retries'] += 1
                continue
        if outcome != 'shown':
            report['stopped'] = (end, 'Firefox did not show the typed characters in the control')
            return report
        position, retried = end, False
    return report

def submitted(obj, text):
    # After Enter was sent for a line break: why it may have sent or submitted
    # instead (the control no longer holds what was typed before it), or None.
    try:
        current = plain(text_of(obj)[0])
    except Exception:
        return 'could no longer be read'
    return None if landed(current, plain(text)) is not None else 'no longer shows the text typed before it'

def enter_text(obj, text, submit, delay=TYPE_DELAY, newline='Enter'):
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    if 'EditableText' not in obj.get_interfaces():
        raise ValueError('This control is not editable.')
    if newline not in NEWLINE_KEYS:
        raise ValueError('newline must be "Enter" or "Shift+Enter"; nothing was typed.')
    if '\t' in text:
        raise ValueError('The text contains a tab character, which would move focus to another control; nothing was typed.')
    if any(char < ' ' and char != '\n' for char in text):
        raise ValueError('The text contains control characters other than line breaks; nothing was typed.')
    if '\n' in text and obj.get_state_set().contains(Atspi.StateType.SINGLE_LINE):
        raise ValueError('This is a single-line control: a line break would press Enter and may submit the form; nothing was typed.')
    drain()
    if plain(text_of(obj)[0]) == plain(text):
        # Typing it again could leave keys queued after a match that was already there.
        done = 'The control already shows exactly that text; nothing was typed.'
        if submit:
            give_focus(obj)
    else:
        # Firefox reports success for set_text_contents without updating XUL
        # controls. Enter text through the focused, verified non-password UI.
        xid = give_focus(obj)
        send(['xdotool', 'key', '--clearmodifiers', 'ctrl+a'])
        if not text:
            send(['xdotool', 'key', '--clearmodifiers', 'BackSpace'])
        typed = type_into(obj, text, xid, delay, newline)
        stopped = typed['stopped']
        shown = None if stopped else confirm_text(obj, text, CHUNK_WAIT)
        if stopped or shown is not None:
            note_input(lambda: text_of(obj)[0], CHUNK_WAIT + STALL)
            why = typed['breaks'] and submitted(obj, text)
            if why:
                raise Performed(f'Line breaks were sent with {newline}, and then the control {why}: {newline} may have '
                                'sent the message or submitted the form. Nothing more was typed. Do not type it again; '
                                'read a fresh snapshot. Where Enter sends, use newline "Shift+Enter".')
            if stopped:
                current = plain(text_of(obj)[0])
                raise ValueError(f'Typing stopped after {stopped[0]} of {len(text)} characters: {stopped[1]}. '
                                 f'The control shows {len(current)} characters: {excerpt(current)}. Nothing more was '
                                 'typed; read a fresh snapshot. Typing again replaces the text.')
            raise ValueError(f'All {len(text)} characters were typed, but the control does not show them exactly: '
                             f'{difference(shown, text)}. It shows {excerpt(shown)}. Read a fresh snapshot; typing '
                             'again replaces the text.')
        done = 'Text entered and confirmed in the control' + (
            f' ({typed["retries"]} chunk{"s" if typed["retries"] > 1 else ""} retried more slowly).' if typed['retries'] else '.')
    if not submit:
        return done + ' Inspect a fresh snapshot.'
    commits = last_input['commits']
    try:
        press_enter(obj)
    except Exception as error:
        if last_input['commits'] != commits:
            raise Performed(f'{done} Enter was pressed; post-check failed: {error}. Do not press it again; read a fresh snapshot.')
        raise ValueError(f'{done} Enter was NOT pressed: {error}.')
    return done + ' Enter pressed; inspect a fresh snapshot.'

def label(text):
    return ' '.join((text or '').split())

def option_list(control):
    # A native <select>: drop-down lists keep their options in a menu child.
    role = role_of(control)
    if role == 'combo box':
        holder = next((c for c in children(control) if role_of(c) == 'menu'), None)
    elif role == 'list box' and control.get_attributes().get('tag') == 'select':
        holder = control
    else:
        holder = None
    if holder is None:
        return None
    items = []
    def collect(obj, level):
        for child in children(obj):
            if role_of(child) in OPTION_ROLES:
                items.append(child)
            elif level < 2:  # <optgroup>
                collect(child, level + 1)
    collect(holder, 0)
    return holder, items

def chosen(holder, items):
    si = holder.get_selection_iface()
    if si is not None and Atspi.Selection.get_n_selected_children(si) > 0:
        child = Atspi.Selection.get_selected_child(si, 0)
        for index, item in enumerate(items):
            if item is child or item == child:
                return index
    for index, item in enumerate(items):
        if item.get_state_set().contains(Atspi.StateType.SELECTED):
            return index
    return None

def usable(item):
    return item.get_state_set().contains(Atspi.StateType.ENABLED)

def moves(items, current, target):
    # Arrow keys skip disabled options; count only the ones a key can land on.
    start = -1 if current is None else current
    span = range(start + 1, target + 1) if target > start else range(target, start)
    return sum(1 for index in span if usable(items[index]))

def settle_choice(holder, items, start, target, limit):
    # Wait for Firefox to apply the keys already sent, so none accumulate.
    deadline = time.monotonic() + limit
    previous, steady = start, time.monotonic()
    while time.monotonic() < deadline:
        pump()
        current = chosen(holder, items)
        if current == target:
            return True
        now = time.monotonic()
        if current != previous:
            previous, steady = current, now
        elif current != start and now - steady > 0.6:
            return True
        time.sleep(0.03)
    return False

def select_option(control, name):
    listing = option_list(control)
    if listing is None:
        raise ValueError('browser.select_option sets native drop-down lists. For a page-made list, click the control, then click the option in a fresh snapshot.')
    holder, items = listing
    if control.get_state_set().contains(Atspi.StateType.MULTISELECTABLE):
        raise ValueError('Multiple-selection lists are not offered.')
    names = [label(item.get_name()) for item in items]
    want = label(name)
    matches = ([i for i, n in enumerate(names) if n == want]
               or [i for i, n in enumerate(names) if n.casefold() == want.casefold()])
    if not matches:
        near = [n for n in names if want.casefold() in n.casefold()][:20] or names[:60]
        raise ValueError(f'No option is named {json.dumps(want, ensure_ascii=False)}. Options: {json.dumps(near, ensure_ascii=False)}')
    if len(matches) > 1:
        raise ValueError(f'{len(matches)} options are named {json.dumps(names[matches[0]], ensure_ascii=False)}; none was chosen.')
    target = matches[0]
    if not usable(items[target]):
        raise ValueError('That option is disabled.')
    if chosen(holder, items) == target:
        return f'{json.dumps(names[target], ensure_ascii=False)} is selected (verified, unchanged).'
    # Arrow keys on a focused, closed list change it as a user would, so the
    # page receives its input and change events. One batch per round, then
    # wait for Firefox to apply it; a round never starts on stale state.
    xid = give_focus(control)
    for _ in range(4):
        current = chosen(holder, items)
        if current == target:
            break
        steps = moves(items, current, target)
        if not steps:
            break
        reason = interrupted(control, xid)
        if reason:
            raise ValueError(f'{reason}, so no more arrow keys were sent; read a fresh snapshot.')
        key = 'Down' if current is None or target > current else 'Up'
        send(['xdotool', 'key', '--clearmodifiers', *[key] * steps], timeout=5 + steps * 0.05)
        note_input(lambda: chosen(holder, items), 3 + steps * 0.05)
        if not settle_choice(holder, items, current, target, 3 + steps * 0.05):
            break
    if fresh_states(control).contains(Atspi.StateType.EXPANDED):
        send(['xdotool', 'key', '--clearmodifiers', 'Escape'])
        raise ValueError('Firefox opened the list instead of changing it; it was closed with Escape. Read a fresh snapshot.')
    final = chosen(holder, items)
    if final != target:
        shown = names[final] if final is not None else None
        raise ValueError(f'The list shows {json.dumps(shown, ensure_ascii=False)}, not {json.dumps(names[target], ensure_ascii=False)}. No further keys were sent; read a fresh snapshot.')
    last_input['watch'] = None
    return f'Selected {json.dumps(names[target], ensure_ascii=False)} (verified).'

def snapshot(depth=30):
    # Drain accessibility events after browser actions before reading caches.
    drain()
    pump(0.35)
    receipts.clear()
    wid, frame, pid = window()
    lines = [f'Firefox window {wid}: {frame.get_name()}']
    count = 0
    started = time.monotonic()
    def walk(obj, level):
        nonlocal count
        if count >= 1800 or level > depth or time.monotonic() - started > 12:
            return
        try:
            states = obj.get_state_set()
            if states.contains(Atspi.StateType.DEFUNCT):
                return
            role = role_of(obj)
            if role in ('document web', 'document frame', 'menu', 'menu bar') and not states.contains(Atspi.StateType.SHOWING):
                return
            if protected(obj):
                lines.append('  ' * level + '- password field [value omitted]')
                return
            name = obj.get_name() or ''
            interfaces = obj.get_interfaces()
            value = ''
            if 'Text' in interfaces and role not in ('document web', 'document frame'):
                ti = obj.get_text_iface()
                value = Atspi.Text.get_text(ti, 0, min(Atspi.Text.get_character_count(ti), 4000)) or ''
            choices = None
            if role == 'combo box':
                listing = option_list(obj)
                if listing is not None:
                    holder, items = listing
                    current = chosen(holder, items)
                    value = label(items[current].get_name()) if current is not None else ''
                    choices = [label(item.get_name()) for item in items]
            ref = f'f{uuid.uuid4().hex[:12]}'
            actions = []
            if 'Action' in interfaces:
                ai = obj.get_action_iface()
                actions = [ai.get_action_name(i) for i in range(ai.get_n_actions())]
            receipts[ref] = (obj, wid, role, name, time.monotonic())
            detail = json.dumps(name, ensure_ascii=False)
            if value and value != name:
                detail += ' value=' + json.dumps(value, ensure_ascii=False)
            if choices is not None:
                detail += (' options=' + json.dumps(choices, ensure_ascii=False) if len(choices) <= 60
                           else f' options={len(choices)} (browser.select_option takes the visible name)')
            if states.contains(Atspi.StateType.SELECTED):
                detail += ' [selected]'
            if states.contains(Atspi.StateType.CHECKED):
                detail += ' [checked]'
            if role in ('push button', 'radio button', 'toggle button', 'check box', 'entry', 'combo box') and not states.contains(Atspi.StateType.ENABLED):
                detail += ' [disabled]'
            if states.contains(Atspi.StateType.FOCUSED):
                detail += ' [focused]'
            if actions:
                detail += ' actions=' + json.dumps(actions)
            meaningful = name or value.replace('￼', '').strip() or role in ('document web', 'entry', 'push button', 'password text', 'combo box')
            if meaningful:
                lines.append('  ' * min(level, 8) + f'- {role} {detail} [ref={ref}]')
            count += 1
            for child in children(obj):
                walk(child, level + 1)
        except Exception as e:
            if len(lines) < 4:
                lines.append('[Accessibility node unavailable: ' + str(e)[:300] + ']')
            return
    walk(frame, 0)
    if count >= 1800 or time.monotonic() - started > 12:
        lines.append('[snapshot bounded; use a more specific target or depth]')
    return '\n'.join(lines)[:160000]

def resolve(ref):
    if ref not in receipts:
        raise ValueError('Unknown/stale reference; request a fresh snapshot.')
    obj, wid, role, name, at = receipts[ref]
    if (time.monotonic() - at > 90 or window()[0] != wid
            or role_of(obj) != role or obj.get_name() != name
            or protected(obj) or obj.get_state_set().contains(Atspi.StateType.DEFUNCT)):
        raise ValueError('Stale or protected control; request a fresh snapshot.')
    return obj

def actionable(obj):
    # "clickAncestor" clicks this element so the event bubbles to the
    # ancestor's listener, as a real click would. Elements with no supported
    # action defer to their nearest actionable ancestor.
    target = obj
    for _ in range(8):
        ai = target.get_action_iface()
        for i in range(ai.get_n_actions() if ai is not None else 0):
            if ai.get_action_name(i).lower() in ACTIONS:
                return target, ai, i
        target = target.get_parent()
        if target is None or role_of(target) in ('document web', 'document frame', 'frame', 'application'):
            break
    raise ValueError('No supported accessibility action on this element or its ancestors; nothing was done.')

def action(obj):
    if role_of(obj) == 'combo box' and option_list(obj) is not None:
        raise ValueError('This is a drop-down list; set it with browser.select_option and the visible name of the option.')
    target, ai, index = actionable(obj)
    # Described before acting: after a submit, the page and its accessibles may be gone.
    where = '' if target is obj else f' on the nearest actionable ancestor ({role_of(target)} {json.dumps(target.get_name() or "", ensure_ascii=False)})'
    # Popovers can immediately dismiss when an accessibility click is sent
    # to a background window. Activate before delivery, never afterwards.
    xid = focus()
    if foreground() != int(xid, 16):
        raise ValueError('Firefox lost foreground focus before the action; nothing was done.')
    note_input()
    try:
        done = ai.do_action(index)
    except Exception as error:
        raise Performed(f'The action{where} was sent to Firefox, but its reply did not arrive ({error}); it has probably been performed. Do not repeat it; read a fresh snapshot.')
    if not done:
        raise ValueError('Firefox refused the accessibility action; nothing was done.')
    note_input(commit=True)
    return f'Action completed{where}; inspect a fresh snapshot.'

def chrome_entry(frame):
    # The focused editable control of Firefox's own UI (the address bar), never page content.
    stack, seen = [(frame, 0)], 0
    while stack and seen < 4000:
        obj, level = stack.pop()
        seen += 1
        try:
            role = role_of(obj)
            if role in ('document web', 'document frame') or level > 25:
                continue
            obj_states = obj.get_state_set()
            if obj_states.contains(Atspi.StateType.FOCUSED) and 'EditableText' in obj.get_interfaces():
                return obj
            if role in ('menu', 'menu bar') and not obj_states.contains(Atspi.StateType.SHOWING):
                continue
            stack.extend((child, level + 1) for child in children(obj))
        except Exception:
            continue
    return None

def navigate(url):
    xid = keys('Control+l', commit=False)
    _, frame, _ = window()
    deadline = time.monotonic() + 3
    bar = None
    while bar is None:
        pump(0.05)
        bar = chrome_entry(frame)
        if bar is None and time.monotonic() > deadline:
            raise ValueError('Firefox did not focus its address bar; nothing was typed.')
    stopped = type_into(bar, url, xid, TYPE_DELAY)['stopped']
    shown = None if stopped else confirm_text(bar, url, CHUNK_WAIT)
    if shown is not None and shown.startswith(url) and not interrupted(bar, xid):
        # Firefox autofill appends a selected suggestion; Enter would open it.
        send(['xdotool', 'key', '--clearmodifiers', 'Delete'])
        shown = confirm_text(bar, url, CHUNK_WAIT)
    if stopped or shown is not None:
        note_input(lambda: text_of(bar)[0], CHUNK_WAIT + STALL)
        problem = (f'typing stopped after {stopped[0]} of {len(url)} characters: {stopped[1]}' if stopped
                   else f'the address bar shows {excerpt(shown)}')
        raise ValueError(f'The URL was not entered ({problem}); Enter was not pressed. browser.tabs action new with url '
                         'hands a URL of any length to Firefox without typing.')
    commits = last_input['commits']
    try:
        press_enter(bar)
    except Exception as error:
        if last_input['commits'] != commits:
            raise
        raise ValueError(f'The URL was typed, but Enter was not pressed: {error}.')
    return 'Navigation started; inspect a fresh snapshot.'

def tab_list():
    found = []
    for wid, frame, pid in firefox_windows():
        def collect(obj, level=0):
            if level > 10:
                return
            role = role_of(obj)
            if role in ('document web', 'document frame'):
                return
            if role == 'page tab':
                found.append((obj, wid, pid, obj.get_name(), obj.get_state_set().contains(Atspi.StateType.SELECTED)))
                return
            for child in children(obj):
                collect(child, level + 1)
        collect(frame)
    return found

def page_tab_ready(name):
    text = (name or '').strip()
    lowered = text.lower()
    if not text or lowered.startswith('about:') or 'sessionrestore' in lowered:
        return False
    if lowered in ('new tab', 'mozilla firefox', 'firefox', 'about:blank'):
        return False
    if lowered.startswith('welcome to firefox'):
        return False
    if lowered.startswith('http://') or lowered.startswith('https://'):
        return False
    return True

def switch_to_tab(obj):
    # Select the page tab through AT-SPI. focus() uses the window manager, and
    # the hidden display does not have one.
    interface = obj.get_action_iface()
    if interface is None:
        return False
    for index in range(interface.get_n_actions()):
        if (interface.get_action_name(index) or '').lower() == 'switch':
            return bool(interface.do_action(index))
    return False

def open_tab(url):
    global selected
    # Firefox's own command line takes the URL: nothing is typed, any length
    # works, and no key can land in the address bar or the page.
    if not url.startswith(('http://', 'https://', 'about:')):
        raise ValueError('Only HTTP(S) and about: URLs are handed to Firefox.')
    # A blank start leaves the welcome page selected and the requested URL on
    # another tab. The hidden window's first process has to open the URL itself.
    if AGENT_MODE and not firefox_running():
        start_firefox('--new-window', url, purpose='given the URL')
        note_input(commit=True)
        deadline = time.monotonic() + max(TAB_WAIT, 25)
        while time.monotonic() < deadline:
            pump(0.3)
            frames = windows()
            if not frames:
                continue
            tabs = tab_list()
            ready = [tab for tab in tabs if page_tab_ready(tab[3])]
            chosen = next((tab for tab in ready if tab[4]), None)
            if chosen is None:
                if ready:
                    switch_to_tab(ready[0][0])
                continue
            selected = chosen[1]
            return f'Opened the URL in a new tab of Firefox window {selected}, which is now selected; inspect a fresh snapshot.'
        raise Performed(f'The URL was handed to Firefox, but the hidden window did not show that page within {max(TAB_WAIT, 25)} seconds. Do not repeat it; list tabs to find it.')
    before = Counter(tab[1] for tab in tab_list())  # starts Firefox first if none runs
    start_firefox('--new-tab', url, purpose='given the URL')
    note_input(commit=True)
    deadline = time.monotonic() + TAB_WAIT
    while True:
        pump(0.3)
        after = Counter(tab[1] for tab in tab_list())
        grown = [wid for wid in after if after[wid] > before[wid]]
        if grown:
            selected = grown[0]
            return f'Opened the URL in a new tab of Firefox window {selected}, which is now selected; inspect a fresh snapshot.'
        if time.monotonic() > deadline:
            raise Performed(f'The URL was handed to Firefox, but no new tab appeared within {TAB_WAIT} seconds. Do not repeat it; list tabs to find it.')

def upload_path(value):
    path = Path(value)
    if (not path.is_absolute() or os.path.normpath(value) != value
            or any(part.startswith('.') for part in path.parts[1:]) or any(c in value for c in '\0\n\r\t')):
        raise ValueError('Upload paths must be explicit, normalized absolute paths without hidden components.')
    if not stat.S_ISREG(os.lstat(value).st_mode):
        raise ValueError('Upload paths must name existing regular files; links and directories are refused.')
    return value

def choosers():
    found = []
    for app in children(Atspi.get_desktop(0)):
        try:
            pid = app.get_process_id()
            portal = owner(pid, PORTALS)
            if not portal and not (firefox_pid(pid) if AGENT_MODE else owner(pid)):
                continue
            for frame in children(app):
                role = role_of(frame)
                if (role == 'file chooser' or (portal and role in ('dialog', 'frame', 'window'))) \
                        and not frame.get_state_set().contains(Atspi.StateType.DEFUNCT):
                    found.append((frame, pid))
        except Exception:
            continue
    return found

def open_chooser():
    # Only an X11-mapped window counts as open; GTK may keep hidden ones.
    deadline = time.monotonic() + CHOOSER_WAIT
    while True:
        live = {}
        for frame, pid in choosers():
            mapped = x_windows(pid)
            exact = [x for x, title in mapped if title == frame.get_name()]
            xid = exact[0] if len(exact) == 1 else mapped[0][0] if len(mapped) == 1 else None
            if xid and (xid not in live or exact):
                live[xid] = (frame, pid, xid)
        live = list(live.values())
        if len(live) == 1:
            return live[0]
        if len(live) > 1:
            raise ValueError('More than one file chooser is open; nothing was typed.')
        if time.monotonic() > deadline:
            raise ValueError('No file chooser is open. Click the page\'s upload control first, then call browser.file_upload.')
        pump(0.2)

def chooser_gone(frame, pid, xid):
    try:
        if frame.get_state_set().contains(Atspi.StateType.DEFUNCT):
            return True
        return all(line.split(None, 1)[0] != xid for line in run(['wmctrl', '-lp']).splitlines() if line.strip())
    except Exception:
        return True

def focused_text(frame):
    stack, seen = [(frame, 0)], 0
    while stack and seen < 3000:
        obj, level = stack.pop()
        seen += 1
        try:
            role = role_of(obj)
            # The location entry is never inside the file list.
            if level > 30 or role in ('list', 'list box', 'table', 'tree', 'tree table', 'grid'):
                continue
            if obj.get_state_set().contains(Atspi.StateType.FOCUSED) and 'Text' in obj.get_interfaces():
                return obj
            stack.extend((child, level + 1) for child in children(obj))
        except Exception:
            continue
    return None

def upload(path):
    if path is not None:
        upload_path(path)
    drain()
    if AGENT_MODE:
        agent_bus_ready()
    frame, pid, xid = open_chooser()
    activate(frame, pid, 'The file chooser')
    if path is None:
        send(['xdotool', 'key', '--clearmodifiers', 'Escape'], commit=True)
    else:
        send(['xdotool', 'key', '--clearmodifiers', 'ctrl+l'])
        deadline = time.monotonic() + 3
        entry = None
        while entry is None:
            pump(0.05)
            entry = focused_text(frame)
            if entry is None and time.monotonic() > deadline:
                raise ValueError('The file chooser did not show its location field; nothing was typed. The chooser is still open.')
        send(['xdotool', 'key', '--clearmodifiers', 'ctrl+a'])
        stopped = type_into(entry, path, xid, TYPE_DELAY)['stopped']
        shown = None if stopped else confirm_text(entry, path, CHUNK_WAIT)
        if shown is not None and shown.startswith(path) and not interrupted(entry, xid):
            # Location completion appends a selected suggestion; drop it.
            send(['xdotool', 'key', '--clearmodifiers', 'Delete'])
            shown = confirm_text(entry, path, 3)
        if stopped or shown is not None:
            problem = f'typing stopped: {stopped[1]}' if stopped else f'it shows {excerpt(shown)}'
            raise ValueError(f'The file chooser location does not hold the path ({problem}); Enter was not pressed. The chooser is still open.')
        reason = interrupted(entry, xid)
        if reason:
            raise ValueError(f'{reason}, so Enter was not pressed. The chooser is still open.')
        send(['xdotool', 'key', '--clearmodifiers', 'Return'], commit=True)
    deadline = time.monotonic() + CLOSE_WAIT
    while not chooser_gone(frame, pid, xid):
        if time.monotonic() > deadline:
            pressed = 'Escape' if path is None else 'Enter'
            raise Performed(f'{pressed} was pressed in the file chooser, but it is still open after {CLOSE_WAIT} seconds, '
                            'so it probably did not take effect. Read a fresh snapshot; call browser.file_upload without paths to cancel the chooser.')
        pump(0.1)
    if path is None:
        return 'File chooser cancelled (verified closed).'
    return f'File chooser accepted {json.dumps(Path(path).name, ensure_ascii=False)} and closed; confirm in a fresh snapshot that the page shows the file.'

def require_hidden_action(req):
    # Click, type, and screenshot stay on the agent session. A request that
    # names the user's visible display, or a profile other than the agent
    # profile, is refused before any input is sent.
    if not AGENT_MODE:
        return
    if req.get('sessionTarget') != 'hidden-window':
        raise ValueError('The Firefox request must name the private hidden session.')
    display = req.get('display')
    if VISIBLE_DISPLAY and (display == VISIBLE_DISPLAY or os.environ.get('DISPLAY') == VISIBLE_DISPLAY):
        raise ValueError('Refusing to drive Firefox on the user visible display.')
    profile = req.get('profile')
    if profile and os.path.normpath(str(profile)) != os.path.normpath(AGENT_PROFILE):
        raise ValueError('Refusing a Firefox profile other than the agent hidden-window profile.')


class CredentialFailure(ValueError):
    """Fixed public diagnostic with no provider text or credential value."""


def _credential_document_once(expected_origin):
    """Identify only the visible top-level document of this owned Firefox window."""
    expected = _secret_module.exact_origin(expected_origin)
    _, frame, _ = window()
    found, stack, count = [], [(frame, 0)], 0
    while stack and count < 4000:
        obj, depth = stack.pop()
        count += 1
        if depth > 30:
            continue
        role = role_of(obj)
        if role == 'document frame':
            # Firefox chrome includes a visible about:blank document frame
            # (for example its sidebar). It is not the selected web document.
            continue
        if role == 'document web':
            if fresh_states(obj).contains(Atspi.StateType.SHOWING):
                doc = obj.get_document_iface()
                url = doc.get_document_attribute_value('DocURL') if doc else None
                try:
                    actual = _secret_module.origin(url)
                except ValueError:
                    scheme = _secret_module.urlsplit(url or '').scheme
                    scheme = scheme if scheme in ('about', 'file', 'data', 'moz-extension') else 'unavailable'
                    raise CredentialFailure('The selected document has no supported web origin (scheme: ' + scheme + ').') from None
                if actual != expected:
                    raise CredentialFailure('The selected page origin does not match; no credential was read or entered.')
                found.append(obj)
            # Never cross into subframes, hidden tabs or Firefox chrome.
            continue
        stack.extend((child, depth + 1) for child in children(obj))
    if len(found) != 1:
        raise CredentialFailure('Exactly one visible top-level web document is required.')
    return found[0]


def credential_document(expected_origin, wait=0):
    # Navigation returns after Enter, before Firefox commits its new document.
    # Only initial capture/fill may wait; every subsequent delivery check fails
    # immediately on a changed origin or document.
    deadline = time.monotonic() + wait
    while True:
        try:
            return _credential_document_once(expected_origin)
        except ValueError:
            if time.monotonic() >= deadline:
                raise
            pump(0.1)


def credential_nodes(document):
    stack, count, started = [(document, 0)], 0, time.monotonic()
    while stack:
        if count >= 4000 or time.monotonic() - started > 8:
            raise CredentialFailure('Credential page inspection exceeded its bounds; no input was sent.')
        obj, depth = stack.pop()
        count += 1
        if depth > 35:
            continue
        role = role_of(obj)
        if obj is not document and role in ('document web', 'document frame'):
            continue
        if fresh_states(obj).contains(Atspi.StateType.DEFUNCT):
            continue
        yield obj
        stack.extend((child, depth + 1) for child in reversed(children(obj)))


def credential_text(obj, seen, depth=0):
    # Firefox represents inline DOM children as U+FFFC. Resolve them locally,
    # preserving document order without ever reading a password control.
    if obj in seen or depth > 4 or protected(obj):
        return ''
    if not fresh_states(obj).contains(Atspi.StateType.SHOWING):
        return ''
    ti = obj.get_text_iface() if 'Text' in obj.get_interfaces() else None
    if ti is None:
        return ''
    seen.add(obj)
    text = Atspi.Text.get_text(ti, 0, min(Atspi.Text.get_character_count(ti), 40000)) or ''
    if '\uFFFC' not in text:
        return text
    kids = iter(children(obj))
    parts = []
    for char in text:
        child = next(kids, None) if char == '\uFFFC' else None
        if child is not None and role_of(child) not in ('document web', 'document frame'):
            parts.append(credential_text(child, seen, depth + 1))
        else:
            parts.append(char if child is None else '')
    return ''.join(parts)


def capture_credential(req):
    drain()
    pump(0.35)
    document = credential_document(req['sourceOrigin'], wait=3)
    texts, size, seen = [], 0, set()
    for obj in credential_nodes(document):
        if protected(obj) or not fresh_states(obj).contains(Atspi.StateType.SHOWING):
            continue
        text = credential_text(obj, seen)
        size += len(text)
        if size > 200000:
            raise CredentialFailure('Credential source exceeded its text bound.')
        texts.append(text)
    # Revalidate origin after collection, before retaining anything.
    if credential_document(req['sourceOrigin']) != document:
        raise CredentialFailure('Credential source changed; capture cancelled.')
    sensitive_sources.add((req['sourceOrigin'], document.get_document_iface().get_document_attribute_value('DocURL')))
    return secret_vault.capture(texts, req['label'], req['destinationOrigin'], req.get('expiresInSeconds', 120))


def find_named_control(req):
    """Locate a known non-sensitive action without observing private page text."""
    if req['role'] not in ('push button', 'toggle button', 'link'):
        raise CredentialFailure('Only named button and link actions are offered by private control lookup.')
    drain()
    pump(0.35)
    document = credential_document(req['origin'], wait=3)
    deadline = time.monotonic() + 3
    while True:
        matches = []
        for obj in credential_nodes(document):
            if role_of(obj) != req['role']:
                continue
            if fresh_states(obj).contains(Atspi.StateType.SHOWING) and obj.get_name() == req['name']:
                obj.get_interfaces()
                matches.append(obj)
        if len(matches) != 1:
            raise CredentialFailure('Exactly one visible control must match the supplied name and role.')
        try:
            # Firefox can expose the name before its action interface is ready.
            # Wait for an actionable reference without revealing a page snapshot
            # or issuing any input. Never retry a click here.
            actionable(matches[0])
            break
        except ValueError:
            if time.monotonic() >= deadline:
                raise CredentialFailure('The matching control has no supported accessibility action.') from None
            pump(0.1)
            if credential_document(req['origin']) != document:
                raise CredentialFailure('The private source changed during control lookup.') from None
    wid, _, _ = window()
    ref = 'f' + uuid.uuid4().hex[:12]
    receipts[ref] = (matches[0], wid, req['role'], req['name'], time.monotonic())
    return {'ref': ref, 'found': True}


def credential_source_visible():
    for source_origin, url in sensitive_sources:
        try:
            document = credential_document(source_origin)
        except ValueError:
            continue
        if document.get_document_iface().get_document_attribute_value('DocURL') == url:
            return True
    return False


def fill_credential(req):
    # One-use even on wrong origin, focus loss or failed delivery. No auto-submit.
    value = secret_vault.consume(req['handle'], req['destinationOrigin'])
    sent = False
    try:
        drain()
        pump(0.35)
        document = credential_document(req['destinationOrigin'], wait=3)
        fields = [obj for obj in credential_nodes(document) if protected(obj)
                  and fresh_states(obj).contains(Atspi.StateType.SHOWING)
                  and fresh_states(obj).contains(Atspi.StateType.ENABLED)]
        if len(fields) != 1:
            raise CredentialFailure('Exactly one visible enabled password field is required; no credential was entered.')
        field = fields[0]
        xid = give_focus(field)
        if interrupted(field, xid) or credential_document(req['destinationOrigin']) != document:
            raise CredentialFailure('Credential target lost focus or changed; no credential was entered.')
        # Typed via stdin: never argv, environment, a file, clipboard or MCP text.
        # No value readback. Clear the selected password field before input.
        send(['xdotool', 'key', '--clearmodifiers', 'ctrl+a', 'BackSpace'])
        if interrupted(field, xid) or credential_document(req['destinationOrigin']) != document:
            raise CredentialFailure('Credential target changed after clearing; no credential was entered.')
        note_input(commit=True)
        sent = True
        offset = 0
        failed = False
        while offset < len(value):
            if (not protected(field) or interrupted(field, xid)
                    or credential_document(req['destinationOrigin']) != document):
                failed = True
                break
            end = min(offset + 16, len(value))
            while end < len(value) and value[end] & 0xC0 == 0x80:
                end += 1
            chunk = value[offset:end]
            try:
                result = subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '5', '--file', '-'],
                                        input=chunk, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            finally:
                secret_vault.wipe(chunk)
            if result.returncode:
                failed = True
                break
            offset = end
        # An OS delivery result is not a claim that the website accepted a login.
        if failed or interrupted(field, xid):
            return {'entered': None, 'submitted': False, 'handleConsumed': True,
                    'outcome': 'Input delivery uncertain; inspect the page before any new credential attempt.'}
        return {'entered': True, 'submitted': False, 'handleConsumed': True,
                'outcome': 'Credential input delivered without reading its value. Sign-in acceptance remains unverified.'}
    except Exception:
        # Providers/process errors can include sensitive text. Never propagate it.
        if sent:
            return {'entered': None, 'submitted': False, 'handleConsumed': True,
                    'outcome': 'Input delivery uncertain; inspect the page before any new credential attempt.'}
        raise CredentialFailure('Credential target could not be verified; handle consumed and no credential input sent.') from None
    finally:
        secret_vault.wipe(value)


def operate(req):
    global selected
    op = req['op']
    secret_vault.expire()
    if AGENT_MODE:
        require_hidden_action(req)
        ensure_agent_display()
    if op == 'windows':
        return [{'id': w, 'title': f.get_name(), 'pid': pid} for w, f, pid in firefox_windows()]
    if op == 'display':
        # browser.show attaches its viewer to this private display. Only the
        # agent's own attested Xvfb is named, never the user's visible display.
        if not AGENT_MODE:
            raise ValueError('Only the hidden Firefox display can be shown.')
        display, auth = os.environ.get('DISPLAY', ''), os.environ.get('XAUTHORITY', '')
        if (display_number(display) is None or display_number(display) == display_number(VISIBLE_DISPLAY)
                or not Path(auth).name.startswith('.toolsengine-xauthority-')
                or Path(auth).parent != Path(AGENT_PROFILE) or not private_regular(auth)):
            raise ValueError('The hidden Firefox display could not be identified.')
        return {'display': display, 'xauthority': auth}
    if op == 'select_window':
        selected = req['target']
        window()
        receipts.clear()
        return 'Selected Firefox window ' + selected
    if op == 'tabs':
        tab_receipts.clear()
        result = []
        for obj, wid, pid, name, is_selected in tab_list():
            ref = uuid.uuid4().hex
            tab_receipts[ref] = (obj, wid, name, time.monotonic())
            result.append({'id': ref, 'window': wid, 'pid': pid, 'title': name, 'selected': is_selected})
        return result
    if op == 'select_tab':
        obj, wid, name, at = tab_receipts.get(req['target'], (None, None, None, 0))
        if obj is None or time.monotonic() - at > 90 or obj.get_name() != name:
            raise ValueError('Stale tab inventory; list tabs again.')
        selected = wid
        window()
        action(obj)
        return 'Selected Firefox tab ' + name
    if op == 'open_tab':
        return open_tab(req['url'])
    if op == 'snapshot':
        if credential_source_visible():
            receipts.clear()
            return 'The selected page is a captured credential source; its content is withheld for this connection.'
        return secret_vault.redact(snapshot(req.get('depth', 30)))
    if op == 'capture_credential':
        try:
            return capture_credential(req)
        except (CredentialFailure, _secret_module.SecretError):
            raise
        except Exception:
            # Accessibility providers may embed source text in their exceptions.
            raise ValueError('Private credential capture failed: source origin, page readiness or unique label could not be verified. No value was returned.') from None
    if op == 'find_control':
        try:
            return find_named_control(req)
        except CredentialFailure:
            raise
        except Exception:
            raise ValueError('Private control lookup failed; no page contents were returned.') from None
    if op == 'fill_credential':
        return fill_credential(req)
    if op == 'revoke_credential':
        return secret_vault.revoke(req['handle'])
    if op == 'click':
        return action(resolve(req['ref']))
    if op == 'type':
        return enter_text(resolve(req['ref']), req['text'], req.get('submit'),
                          SLOW_DELAY if req.get('slowly') else TYPE_DELAY, req.get('newline') or 'Enter')
    if op == 'select_option':
        return select_option(resolve(req['ref']), req['option'])
    if op == 'key':
        keys(req['key'])
        return 'Key pressed; inspect a fresh snapshot.'
    if op == 'navigate':
        return navigate(req['url'])
    if op == 'upload':
        return upload(req.get('path'))
    if op == 'screenshot':
        if secret_vault.redactions or credential_source_visible():
            raise ValueError('Screenshots are unavailable while captured credentials remain sensitive; wait for their lifetime to end.')
        focus()
        _, frame, _ = window()
        rect = frame.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        if rect.width < 1 or rect.height < 1:
            raise ValueError('Firefox window has no visible geometry.')
        from PIL import ImageGrab
        out = io.BytesIO()
        ImageGrab.grab(bbox=(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height)).save(out, format='PNG')
        return {'image': base64.b64encode(out.getvalue()).decode()}
    raise ValueError('Operation is not offered.')

def dispatch(req):
    # Any keys or actions invalidate references, whether or not the call succeeded.
    sent, commits = last_input['at'], last_input['commits']
    try:
        return operate(req)
    except Performed as done:
        return str(done)
    except Exception as error:
        if last_input['commits'] == commits:
            raise
        # A click, key or URL reached Firefox: an error now could make the caller repeat a submit.
        return f'Action performed; post-check failed: {str(error)[:1500]}. Do not repeat the action; read a fresh snapshot to see its effect.'
    finally:
        if last_input['at'] != sent:
            receipts.clear()

def main():
    for line in sys.stdin:
        request = None
        try:
            if len(line) > 100000:
                raise ValueError('Request too large.')
            request = json.loads(line)
            response = {'id': request.get('id'), 'result': dispatch(request)}
        except Exception as e:
            response = {'id': request.get('id') if isinstance(request, dict) else None,
                        'error': str(e)[:2000]}
        print(json.dumps(secret_vault.sanitize(response), ensure_ascii=False), flush=True)
    secret_vault.clear()

if __name__ == '__main__':
    main()
