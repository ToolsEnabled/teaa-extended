"""Short-lived opaque credentials. Values never form part of the MCP protocol."""
import re
import json
import secrets
import time
import threading
import unicodedata
from functools import wraps
from urllib.parse import urlsplit


class SecretError(ValueError):
    """Fixed public diagnostic with no provider text or credential value."""


def locked(method):
    @wraps(method)
    def invoke(self, *args, **kwargs):
        with self.lock:
            return method(self, *args, **kwargs)
    return invoke


def origin(value):
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        port = parsed.port
        if (not host or parsed.username is not None or parsed.password is not None
                or parsed.scheme not in ('https', 'http')
                or parsed.scheme == 'http' and host not in ('localhost', '127.0.0.1', '::1')):
            raise SecretError()
        host = '[' + host + ']' if ':' in host else host.lower()
        return parsed.scheme + '://' + host + (':' + str(port) if port and port != (443 if parsed.scheme == 'https' else 80) else '')
    except (ValueError, TypeError, AttributeError):
        raise SecretError('A valid HTTPS origin is required; HTTP is allowed only for loopback fixtures.') from None


def exact_origin(value):
    result = origin(value)
    if value.rstrip('/') != result:
        raise SecretError('Specify an origin only, without a path, query, fragment or credentials.')
    return result


class SecretVault:
    """One-use, destination-bound handles; bounded, volatile, best-effort erasure."""
    def __init__(self, clock=time.monotonic):
        self.lock = threading.RLock()
        self.clock = clock
        self.entries = {}
        self.redactions = []

    @staticmethod
    def wipe(value):
        value[:] = b'\0' * len(value)

    @locked
    def expire(self):
        now = self.clock()
        for handle, entry in list(self.entries.items()):
            if now >= entry['expires']:
                self.wipe(entry['value'])
                del self.entries[handle]
        retained = []
        for deadline, value in self.redactions:
            if now >= deadline:
                self.wipe(value)
            else:
                retained.append((deadline, value))
        self.redactions = retained

    @locked
    def capture(self, texts, label, destination, ttl=120):
        self.expire()
        destination = exact_origin(destination)
        if not isinstance(label, str) or not 1 <= len(label) <= 100 or any(ord(c) < 32 for c in label):
            raise SecretError('Supply a literal credential label, at most 100 characters.')
        if type(ttl) is not int or not 10 <= ttl <= 300:
            raise SecretError('Credential lifetime must be 10–300 seconds.')
        if len(self.entries) >= 4 or len(self.redactions) >= 8:
            raise SecretError('Credential capacity reached; revoke outstanding handles or wait for expiry.')
        # Literal labels support common field and prose formats. A broad label
        # matching both a credential and an instruction is ambiguous, not a
        # reason to choose the first occurrence or prefer quoted values.
        pattern = re.compile(r'(?<!\w)' + re.escape(label)
                             + r'(?:\s*[:=]\s*|\s+is\b\s*[:=]?\s*)', re.IGNORECASE)
        texts = list(texts)
        texts.append('\n'.join(texts))
        quote_pairs = {'"': '"', "'": "'", '“': '”', '‘': '’', '`': '`'}
        candidates, quoted_values = set(), set()
        for text in texts:
            for match in pattern.finditer(text):
                remainder = text[match.end():]
                if not remainder:
                    continue  # The joined fragments may supply the value.
                if remainder[0] in quote_pairs:
                    closing = quote_pairs[remainder[0]]
                    quoted = re.match(r'\s*([^\s\uFFFC]+?)\s*' + re.escape(closing), remainder[1:])
                    if not quoted:
                        continue
                    value = quoted.group(1)
                    quoted_values.add(value)
                else:
                    token = re.match(r'[^\s\uFFFC]+', remainder)
                    if not token:
                        continue
                    value = token.group(0)
                candidates.add(value)
        if len(candidates) != 1:
            raise SecretError('The credential label must identify exactly one distinct value on the selected page (found ' + str(len(candidates)) + ').')
        value = next(iter(candidates))
        if value in ('...', '…', '***', '•••'):
            raise SecretError('The labelled value is a truncated or masked placeholder. Open the full source message before capture.')
        if all(unicodedata.category(char) == 'Cf' for char in value):
            raise SecretError('The label resolved to display-formatting marks rather than a credential; source extraction must be corrected.')
        encoded = bytearray(value.encode('utf-8'))
        if not 1 <= len(encoded) <= 1024 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            self.wipe(encoded)
            raise SecretError('The credential is outside the supported single-line input bounds.')
        for _ in range(32):
            handle = secrets.token_urlsafe(32)
            if value not in handle and not any(stored.decode('utf-8') in handle for _, stored in self.redactions):
                break
        else:
            self.wipe(encoded)
            raise SecretError('An opaque handle could not be generated; capture cancelled.')
        deadline = self.clock() + ttl
        self.entries[handle] = {'value': encoded, 'origin': destination, 'expires': deadline}
        self.redactions.append((deadline, bytearray(encoded)))
        # Erase expired buffers even while the helper is idle on stdin.
        expiry = threading.Timer(ttl + 0.05, self.expire)
        expiry.daemon = True
        expiry.start()
        return {'handle': handle, 'destinationOrigin': destination, 'expiresInSeconds': ttl,
                'sourceFormat': 'quoted-token' if value in quoted_values else 'single-token'}

    @locked
    def consume(self, handle, destination):
        self.expire()
        entry = self.entries.pop(handle, None)
        if entry is None:
            raise SecretError('Credential handle is absent, expired, consumed or belongs to another connection.')
        try:
            matches = entry['origin'] == exact_origin(destination)
        except ValueError:
            self.wipe(entry['value'])
            raise
        if not matches:
            self.wipe(entry['value'])
            raise SecretError('Credential destination does not match; handle revoked.')
        return entry['value']

    @locked
    def revoke(self, handle):
        self.expire()
        entry = self.entries.pop(handle, None)
        if entry:
            self.wipe(entry['value'])
        return {'revoked': True}

    @locked
    def redact(self, text):
        self.expire()
        for _, value in self.redactions:
            secret = value.decode('utf-8')
            text = text.replace(json.dumps(secret, ensure_ascii=False)[1:-1], '[credential redacted]')
            text = text.replace(secret, '[credential redacted]')
        return text

    @locked
    def sanitize(self, value):
        if isinstance(value, str):
            return self.redact(value)
        if isinstance(value, list):
            return [self.sanitize(item) for item in value]
        if isinstance(value, dict):
            # Protocol keys are fixed program vocabulary, not page content.
            return {key: self.sanitize(item) for key, item in value.items()}
        return value

    @locked
    def clear(self):
        for entry in self.entries.values():
            self.wipe(entry['value'])
        for _, value in self.redactions:
            self.wipe(value)
        self.entries.clear()
        self.redactions.clear()
