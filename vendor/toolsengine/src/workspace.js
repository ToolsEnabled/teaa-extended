import { folderContains, PROGRAM_FOLDER } from './config.js';
import { restrictedPluginPath } from './plugin-policy.js';
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";

const MAX_PATH_BYTES = 4_096;
const MAX_FILE_BYTES = 1_048_576;
const MAX_LIST_RESULTS = 1_000;
const MAX_LIST_SCANNED_ENTRIES = 2_000;
const MAX_QUERY_BYTES = 1_024;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILES = 1_000;
const MAX_SEARCHED_ENTRIES = 5_000;
const MAX_SEARCH_FILE_BYTES = 262_144;
const MAX_SEARCH_TOTAL_BYTES = 8_388_608;
const MAX_SNIPPET_CHARACTERS = 320;

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_FORBIDDEN_CHARACTERS = /[:*?"<>|]/;

class WorkspaceToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceToolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkspaceToolError(code, message);
}

function assertObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_INPUT", "Tool arguments must be an object.");
  }
}

function assertKnownKeys(value, keys) {
  const known = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      fail("INVALID_INPUT", `Unknown argument: ${key}`);
    }
  }
}

function integerArgument(value, name, defaultValue, minimum, maximum) {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_INPUT", `${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function booleanArgument(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    fail("INVALID_INPUT", `${name} must be a boolean.`);
  }
  return value;
}

function portableSegments(input, { allowRoot = false } = {}) {
  if (typeof input !== "string") {
    fail("INVALID_PATH", "path must be a string.");
  }
  if (Buffer.byteLength(input, "utf8") > MAX_PATH_BYTES) {
    fail("INVALID_PATH", `path exceeds the ${MAX_PATH_BYTES}-byte limit.`);
  }
  if (input.includes("\0")) {
    fail("INVALID_PATH", "path contains a NUL byte.");
  }

  const portable = input.replaceAll("\\", "/");
  if (
    portable.startsWith("/") ||
    portable.startsWith("//") ||
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(input) ||
    /^[a-z]:/i.test(portable)
  ) {
    fail("PATH_OUTSIDE_WORKSPACE", "Absolute and drive-relative paths are not allowed.");
  }

  const rawSegments = portable.split("/");
  if (rawSegments.includes("..")) {
    fail("PATH_OUTSIDE_WORKSPACE", "Parent traversal is not allowed.");
  }

  const segments = rawSegments.filter((segment) => segment !== "" && segment !== ".");
  for (const segment of segments) {
    if (
      WINDOWS_FORBIDDEN_CHARACTERS.test(segment) ||
      WINDOWS_DEVICE_NAME.test(segment) ||
      segment.endsWith(".") ||
      segment.endsWith(" ")
    ) {
      fail("INVALID_PATH", `path segment is not portable: ${JSON.stringify(segment)}`);
    }
  }

  if (!allowRoot && segments.length === 0) {
    fail("INVALID_PATH", "path must name a file or directory inside the workspace.");
  }
  return segments;
}

function samePath(left, right) {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function relativePortable(root, filename) {
  return path.relative(root, filename).split(path.sep).join("/") || ".";
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

// A name longer than the file system allows (255 bytes on most), said with
// the workspace-relative path instead of the system's ENAMETOOLONG text,
// which names the workspace's full path.
function refuseLongName(error, shown) {
  if (error?.code === "ENAMETOOLONG") {
    fail("NAME_TOO_LONG", `${shown} has a name that is longer than this file system allows (most allow 255 bytes per name).`);
  }
}

async function initializeRoot(workspace) {
  if (typeof workspace !== "string" || workspace.length === 0) {
    fail("INVALID_WORKSPACE", "workspace must be a non-empty path string.");
  }

  const requestedRoot = path.resolve(workspace);
  let rootInfo;
  try {
    rootInfo = await lstat(requestedRoot);
  } catch (error) {
    if (isMissing(error)) {
      fail("INVALID_WORKSPACE", "workspace does not exist.");
    }
    throw error;
  }
  if (rootInfo.isSymbolicLink()) {
    fail("SYMLINK_REJECTED", "workspace itself cannot be a symlink or junction.");
  }
  if (!rootInfo.isDirectory()) {
    fail("INVALID_WORKSPACE", "workspace must be a directory.");
  }

  const canonicalRoot = await realpath(requestedRoot);
  if (!samePath(requestedRoot, canonicalRoot)) {
    fail("SYMLINK_REJECTED", "workspace must be addressed through its canonical path.");
  }
  return canonicalRoot;
}

async function verifyRoot(root) {
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("WORKSPACE_CHANGED", "workspace root is no longer the original directory.");
  }
  const canonical = await realpath(root);
  if (!samePath(root, canonical)) {
    fail("WORKSPACE_CHANGED", "workspace root no longer resolves canonically.");
  }
}

// The browser keeps folders of its own inside the workspace: its temporary
// files and temporary profile under .toolsengine-runtime, and the dedicated
// profile when --profile-dir names a folder in the workspace. A profile
// holds the browser's settings, cookies and sign-ins. The workspace tools do
// not read, list, search or write there: an assistant that could edit the
// profile's settings, or read its cookie store, would have a way around the
// browser tools. The layout itself is allowed; only these tools stay out.
export const BROWSER_RUNTIME_FOLDER = ".toolsengine-runtime";
const BROWSER_FOLDERS_NOTE =
  "Paths inside the browser's own folders in the workspace are refused: .toolsengine-runtime, and the profile folder when --profile-dir names one there. The ToolsEngine program folder is excluded from file access, listing and search.";

async function insideProgramFolder(candidate, { existing = false } = {}) {
  const program = await realpath(PROGRAM_FOLDER);
  return isContained(program, candidate) || existing && await folderContains(program, candidate);
}
async function refuseProgramFolder(candidate, options) {
  if (await insideProgramFolder(candidate, options))
    fail('PROGRAM_FOLDER', 'The ToolsEngine program folder is reserved for the installed runtime. Workspace tools do not read or change it.');
}

async function browserFoldersIn(root, profileDir) {
  const folders = [path.join(root, BROWSER_RUNTIME_FOLDER)];
  if (typeof profileDir === "string" && profileDir.length > 0) {
    let profile = path.resolve(profileDir);
    try {
      profile = await realpath(profile);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    folders.push(profile); // Include every spelling, even outside the lexical workspace.
  }
  return folders;
}

// What the file system says a folder is: its device and file number. On a
// mount that ignores the case of letters one folder has several spellings,
// and comparing paths as text would let "Profile" through where "profile" is
// refused. Null where there is no such folder or the file system numbers
// nothing.
async function insideBrowserFolder(candidate, browserFolders = [], { existing = false } = {}) {
  if (browserFolders.some(folder => isContained(folder,candidate))) return true;
  if (!existing) return false;
  for (const folder of browserFolders) if (await folderContains(folder,candidate)) return true;
  return false;
}

async function refuseBrowserFolder(candidate, browserFolders, options) {
  if (await insideBrowserFolder(candidate, browserFolders, options)) {
    fail(
      "BROWSER_FOLDER",
      "This path is inside a folder the browser keeps for itself (its profile or its temporary files). The workspace tools do not read or change it.",
    );
  }
}

async function resolveExisting(root, input, options = {}) {
  const segments = portableSegments(input, { allowRoot: options.allowRoot });
  await verifyRoot(root);
  await refuseProgramFolder(root, { existing: true });

  let candidate = root;
  const walked = [];
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    walked.push(segment);
    if (!isContained(root, candidate)) {
      fail("PATH_OUTSIDE_WORKSPACE", "Resolved path leaves the workspace.");
    }
    await refuseBrowserFolder(candidate, options.browserFolders);
    await refuseProgramFolder(candidate);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (isMissing(error)) notFound(segments.join("/"), walked.join("/"), options.missingFolder);
      refuseLongName(error, walked.join("/"));
      throw error;
    }
    if (info.isSymbolicLink()) {
      fail("SYMLINK_REJECTED", "Symlinks and junctions are not allowed.");
    }
    // Each folder on the way exists by now: one that is a browser folder
    // under another spelling is refused as well.
    await refuseBrowserFolder(candidate, options.browserFolders, { existing: true });
    await refuseProgramFolder(candidate, { existing: true });
  }

  const canonical = await realpath(candidate);
  if (!isContained(root, canonical) || !samePath(candidate, canonical)) {
    fail("PATH_OUTSIDE_WORKSPACE", "Resolved path is not canonically contained in the workspace.");
  }

  const info = await lstat(candidate);
  if (info.isSymbolicLink()) {
    fail("SYMLINK_REJECTED", "Symlinks and junctions are not allowed.");
  }
  if (options.type === "file" && !info.isFile()) {
    fail("NOT_A_FILE", "path must identify a regular file.");
  }
  if (options.type === "file" && info.nlink > 1) {
    fail("HARDLINK_REJECTED", "Files with multiple hard links are not allowed.");
  }
  if (options.type === "directory" && !info.isDirectory()) {
    fail("NOT_A_DIRECTORY", "path must identify a directory.");
  }
  return { candidate, info, segments };
}

// What a path that is not there is called, in the workspace's own words and
// without the system's error text (which names the workspace's full path).
function notFound(whole, missing, folderToWriteIn) {
  const first = missing === whole ? "" : ` (${missing} is missing)`;
  if (folderToWriteIn) {
    fail(
      "FOLDER_NOT_FOUND",
      `The folder ${whole} does not exist in the workspace${first}. workspace.write_file does not create folders: write the file into a folder that exists (workspace.list shows them), or have the person create this folder first.`,
    );
  }
  fail("NOT_FOUND", `${whole} does not exist in the workspace${first}.`);
}

async function resolveWriteTarget(root, input, browserFolders) {
  const segments = portableSegments(input);
  const filename = segments.at(-1);
  const parentInput = segments.slice(0, -1).join("/") || ".";
  const { candidate: parent } = await resolveExisting(root, parentInput, {
    allowRoot: true,
    type: "directory",
    browserFolders,
    missingFolder: true,
  });
  const candidate = path.join(parent, filename);
  if (!isContained(root, candidate)) {
    fail("PATH_OUTSIDE_WORKSPACE", "Resolved path leaves the workspace.");
  }
  await refuseBrowserFolder(candidate, browserFolders);
  await refuseProgramFolder(candidate);

  let info = null;
  try {
    info = await lstat(candidate);
  } catch (error) {
    refuseLongName(error, segments.join("/"));
    if (!isMissing(error)) throw error;
  }
  if (info?.isSymbolicLink()) {
    fail("SYMLINK_REJECTED", "Symlinks and junctions are not allowed.");
  }
  if (info && !info.isFile()) {
    fail("NOT_A_FILE", "Existing write target must be a regular file.");
  }
  if (info?.nlink > 1) {
    fail("HARDLINK_REJECTED", "Files with multiple hard links are not allowed.");
  }
  if (info) {
    const canonical = await realpath(candidate);
    if (!isContained(root, canonical) || !samePath(candidate, canonical)) {
      fail("PATH_OUTSIDE_WORKSPACE", "Write target is not canonically contained.");
    }
  }
  return { candidate, parent, info };
}

async function readBoundedBuffer(filename, limit) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(filename, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ELOOP") {
      fail("SYMLINK_REJECTED", "Symlinks and junctions are not allowed.");
    }
    throw error;
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      fail("NOT_A_FILE", "path must identify a regular file.");
    }
    if (before.nlink > 1) {
      fail("HARDLINK_REJECTED", "Files with multiple hard links are not allowed.");
    }
    if (before.size > limit) {
      fail("FILE_TOO_LARGE", `File exceeds the ${limit}-byte limit.`);
    }

    const buffer = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset <= limit) {
      const { bytesRead } = await handle.read(buffer, offset, limit + 1 - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) {
      fail("FILE_TOO_LARGE", `File exceeds the ${limit}-byte limit.`);
    }
    if ((await handle.stat()).nlink > 1) {
      fail("HARDLINK_REJECTED", "File gained another hard link while it was being read.");
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail("INVALID_UTF8", "File content is not valid UTF-8.");
  }
}

// The temporary file has a short name of its own in the target's folder. It
// was named after the target before 0.1.6, which added 42 bytes to the name
// and made names of about 214 to 255 bytes fail.
async function writeTemporary(parent, buffer, mode) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = randomBytes(12).toString("hex");
    const temp = path.join(parent, `.toolsengine-${suffix}.tmp`);
    try {
      const handle = await open(temp, "wx", mode);
      try {
        await handle.writeFile(buffer);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return temp;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  fail("TEMPORARY_FILE_COLLISION", "Could not reserve an atomic temporary file.");
}

async function removeTemporary(temp) {
  if (!temp) return;
  try {
    await unlink(temp);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function snippetFor(line, index, queryLength) {
  if (line.length <= MAX_SNIPPET_CHARACTERS) return line;
  const radius = Math.floor((MAX_SNIPPET_CHARACTERS - queryLength) / 2);
  const start = Math.max(0, Math.min(index - radius, line.length - MAX_SNIPPET_CHARACTERS));
  const end = start + MAX_SNIPPET_CHARACTERS;
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

// Every hint is stated. Nothing here reaches outside the workspace, so
// openWorldHint is false throughout; only write_file changes anything, and it
// can replace a file, so it is the one destructive tool.
const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export function createWorkspaceTools({ workspace, profileDir, pluginProfile } = {}) {
  const strict = pluginProfile === 'openai';
  const restricted = value => strict && restrictedPluginPath(value);
  let rootPromise;
  const getRoot = () => {
    rootPromise ??= initializeRoot(workspace).then(root => {
      if (restricted(root)) fail('PLUGIN_FILE_REFUSED', 'The plugin workspace cannot be inside hidden state or a protected profile folder.');
      return root;
    });
    return rootPromise;
  };
  // The folders of the browser inside this workspace, which these tools stay out of.
  let browserFoldersPromise;
  const getBrowserFolders = async () => {
    browserFoldersPromise ??= getRoot().then((root) => browserFoldersIn(root, profileDir));
    return browserFoldersPromise;
  };

  const list = {
    name: "workspace.list",
    title: "List a workspace folder",
    description:
      `List one folder of the workspace: names, types and file sizes, hidden entries included. Symlinks and junctions are not followed and are left out. Returns at most 1,000 entries and scans at most 2,000. ${BROWSER_FOLDERS_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory; defaults to the root." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_RESULTS, default: 200 },
      },
      additionalProperties: false,
    },
    annotations: { title: "List a workspace folder", ...READ_ONLY },
    async handler(args = {}) {
      assertObject(args);
      assertKnownKeys(args, ["path", "limit"]);
      const root = await getRoot();
      const inputPath = args.path ?? ".";
      const limit = integerArgument(args.limit, "limit", 200, 1, MAX_LIST_RESULTS);
      const { candidate } = await resolveExisting(root, inputPath, {
        allowRoot: true,
        type: "directory",
        browserFolders: await getBrowserFolders(),
      });

      const found = [];
      let scanned = 0;
      let skippedSymlinks = 0;
      let skippedChangedEntries = 0;
      let skippedProtectedEntries = 0;
      let skippedProgramFolders = 0;
      const directory = await opendir(candidate);
      try {
        for await (const entry of directory) {
          if (scanned >= MAX_LIST_SCANNED_ENTRIES) break;
          scanned += 1;
          const entryPath = path.join(candidate, entry.name);
          if (restricted(relativePortable(root, entryPath))) { skippedProtectedEntries += 1; continue; }
          let info;
          try {
            info = await lstat(entryPath);
          } catch (error) {
            if (isMissing(error)) {
              skippedChangedEntries += 1;
              continue;
            }
            throw error;
          }
          if (entry.isSymbolicLink() || info.isSymbolicLink()) {
            skippedSymlinks += 1;
            continue;
          }
          if (await insideProgramFolder(entryPath, { existing: true })) { skippedProgramFolders++; continue; }
          found.push({
            name: entry.name,
            type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
            size: info.isFile() ? info.size : null,
          });
        }
      } finally {
        await directory.close().catch(() => {});
      }

      found.sort((left, right) => left.name.localeCompare(right.name));
      const entries = found.slice(0, limit);
      return {
        path: relativePortable(root, candidate),
        entries,
        truncated: found.length > limit || scanned >= MAX_LIST_SCANNED_ENTRIES,
        scannedEntries: scanned,
        scanLimit: MAX_LIST_SCANNED_ENTRIES,
        skippedSymlinks,
        skippedChangedEntries,
        skippedProgramFolders,
        ...(strict ? { skippedProtectedEntries, protectedEntryRule: 'OpenAI plugin protected-path policy; names and contents withheld.' } : {}),
      };
    },
  };

  const readFile = {
    name: "workspace.read_file",
    title: "Read a workspace file",
    description:
      `Read one UTF-8 text file from the workspace, up to 1 MiB, with its SHA-256. Any regular file inside the workspace can be read, hidden files such as .env included, so the content can contain secrets that are stored there. Symlinks, junctions and files with more than one hard link are refused, and so are names that Windows cannot use (a colon or another character that Windows forbids, a trailing dot or space, a device name such as aux). ${BROWSER_FOLDERS_NOTE}`,
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { title: "Read a workspace file", ...READ_ONLY },
    async handler(args = {}) {
      assertObject(args);
      assertKnownKeys(args, ["path"]);
      const root = await getRoot();
      const { candidate } = await resolveExisting(root, args.path, { type: "file", browserFolders: await getBrowserFolders() });
      const buffer = await readBoundedBuffer(candidate, MAX_FILE_BYTES);
      return {
        path: relativePortable(root, candidate),
        content: decodeUtf8(buffer),
        bytes: buffer.length,
        sha256: sha256(buffer),
      };
    },
  };

  const writeFile = {
    name: "workspace.write_file",
    title: "Create or replace a workspace file",
    description:
      `Create a new UTF-8 text file in the workspace, or replace the entire content of an existing one. Replacing destroys the previous content (ToolsEngine keeps no copy) and is allowed only when expectedSha256 equals the SHA-256 that workspace.read_file reports for the file as it is now, so read it first. At most 1 MiB; there is no append or partial edit. The folder must already exist: workspace.write_file does not create folders, so that a mistyped or invented path cannot grow a tree of folders in the person's workspace (workspace.list shows the folders that exist; a new one is for the person to create). Hidden files can be written; symlinks, junctions and files with more than one hard link are refused, and so are names that Windows cannot use (a colon or another character that Windows forbids, a trailing dot or space, a device name such as aux). ${BROWSER_FOLDERS_NOTE}`,
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expectedSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Create or replace a workspace file",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async handler(args = {}) {
      assertObject(args);
      assertKnownKeys(args, ["path", "content", "expectedSha256"]);
      if (typeof args.content !== "string") {
        fail("INVALID_INPUT", "content must be a string.");
      }
      if (
        args.expectedSha256 !== undefined &&
        (typeof args.expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(args.expectedSha256))
      ) {
        fail("INVALID_INPUT", "expectedSha256 must be a lowercase SHA-256 hex digest.");
      }

      const buffer = Buffer.from(args.content, "utf8");
      if (buffer.length > MAX_FILE_BYTES) {
        fail("FILE_TOO_LARGE", `content exceeds the ${MAX_FILE_BYTES}-byte limit.`);
      }

      const root = await getRoot();
      const browserFolders = await getBrowserFolders();
      const initial = await resolveWriteTarget(root, args.path, browserFolders);
      if (initial.info && args.expectedSha256 === undefined) {
        fail("PRECONDITION_REQUIRED", "expectedSha256 is required to replace an existing file.");
      }
      if (!initial.info && args.expectedSha256 !== undefined) {
        fail("STALE_WRITE", "The expected file no longer exists.");
      }
      if (initial.info) {
        const current = await readBoundedBuffer(initial.candidate, MAX_FILE_BYTES);
        if (sha256(current) !== args.expectedSha256) {
          fail("STALE_WRITE", "Existing file does not match expectedSha256.");
        }
      }

      const digest = sha256(buffer);
      const mode = initial.info ? initial.info.mode & 0o777 : 0o600;
      let temp;
      try {
        temp = await writeTemporary(initial.parent, buffer, mode);
        const finalCheck = await resolveWriteTarget(root, args.path, browserFolders);
        if (initial.info) {
          if (!finalCheck.info) {
            fail("STALE_WRITE", "Existing file disappeared before replacement.");
          }
          const current = await readBoundedBuffer(finalCheck.candidate, MAX_FILE_BYTES);
          if (sha256(current) !== args.expectedSha256) {
            fail("STALE_WRITE", "Existing file changed before replacement.");
          }
          await rename(temp, finalCheck.candidate);
          temp = null;
        } else {
          if (finalCheck.info) {
            fail("STALE_WRITE", "A file appeared before creation completed.");
          }
          try {
            await link(temp, finalCheck.candidate);
          } catch (error) {
            if (error?.code === "EEXIST") {
              fail("STALE_WRITE", "A file appeared before creation completed.");
            }
            throw error;
          }
          await unlink(temp);
          temp = null;
        }
      } finally {
        await removeTemporary(temp);
      }

      return {
        path: relativePortable(root, initial.candidate),
        bytes: buffer.length,
        sha256: digest,
        created: !initial.info,
      };
    },
  };

  const search = {
    name: "workspace.search",
    title: "Search workspace files",
    description:
      "Search the workspace's UTF-8 text files for a literal string (not a pattern) and return the matching lines. Folders whose name starts with a dot are skipped; hidden files inside searched folders are not. Symlinks, junctions and multiply-linked files are skipped and counted, and so are the browser's own folders and names that Windows cannot use (a colon or another character that Windows forbids, a trailing dot or space, a device name such as aux). Bounded to 200 results, 1,000 files, 256 KiB per file and 8 MiB in all.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        path: { type: "string", default: "." },
        query: { type: "string", minLength: 1 },
        caseSensitive: { type: "boolean", default: true },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, default: 100 },
        maxFiles: { type: "integer", minimum: 1, maximum: MAX_SEARCH_FILES, default: 500 },
        maxFileBytes: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_FILE_BYTES,
          default: MAX_SEARCH_FILE_BYTES,
        },
      },
      additionalProperties: false,
    },
    annotations: { title: "Search workspace files", ...READ_ONLY },
    async handler(args = {}) {
      assertObject(args);
      assertKnownKeys(args, ["path", "query", "caseSensitive", "maxResults", "maxFiles", "maxFileBytes"]);
      if (typeof args.query !== "string" || args.query.length === 0) {
        fail("INVALID_INPUT", "query must be a non-empty string.");
      }
      if (Buffer.byteLength(args.query, "utf8") > MAX_QUERY_BYTES) {
        fail("INVALID_INPUT", `query exceeds the ${MAX_QUERY_BYTES}-byte limit.`);
      }

      const inputPath = args.path ?? ".";
      const inputSegments = portableSegments(inputPath, { allowRoot: true });
      if (inputSegments.some((segment) => segment.startsWith("."))) {
        fail("HIDDEN_DIRECTORY", "Search cannot start inside a hidden directory.");
      }
      const caseSensitive = booleanArgument(args.caseSensitive, "caseSensitive", true);
      const maxResults = integerArgument(args.maxResults, "maxResults", 100, 1, MAX_SEARCH_RESULTS);
      const maxFiles = integerArgument(args.maxFiles, "maxFiles", 500, 1, MAX_SEARCH_FILES);
      const maxFileBytes = integerArgument(
        args.maxFileBytes,
        "maxFileBytes",
        MAX_SEARCH_FILE_BYTES,
        1,
        MAX_SEARCH_FILE_BYTES,
      );

      const root = await getRoot();
      const browserFolders = await getBrowserFolders();
      const { candidate: start } = await resolveExisting(root, inputPath, {
        allowRoot: true,
        type: "directory",
        browserFolders,
      });
      const directories = [start];
      const matches = [];
      const skipped = {
        ...(strict ? { protectedEntries: 0 } : {}),
        hiddenDirectories: 0,
        browserFolders: 0,
        symlinks: 0,
        oversizedFiles: 0,
        invalidUtf8Files: 0,
        changedEntries: 0,
        hardlinkedFiles: 0,
        nonRegularFiles: 0,
        nonPortableNames: 0,
      };
      const truncationReasons = new Set();
      let scannedEntries = 0;
      let searchedFiles = 0;
      let searchedBytes = 0;
      // Case-insensitive matching runs on the line as written, so a column is
      // a position in that line even where lower case is longer ("İ").
      const pattern = caseSensitive ? null : new RegExp(args.query.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&"), "giu");

      searchLoop: while (directories.length > 0) {
        const directoryPath = directories.pop();
        const directoryRelative = relativePortable(root, directoryPath);
        let checkedDirectory;
        try {
          ({ candidate: checkedDirectory } = await resolveExisting(root, directoryRelative, {
            allowRoot: true,
            type: "directory",
            browserFolders,
          }));
        } catch (error) {
          // A folder whose name Windows cannot use (a colon, a trailing dot
          // or space, a device name such as aux) is passed by, not a reason
          // to lose the whole search.
          if (error?.code === "INVALID_PATH" && directoryPath !== start) {
            skipped.nonPortableNames += 1;
            continue;
          }
          throw error;
        }
        const directory = await opendir(checkedDirectory);
        try {
          for await (const entry of directory) {
            if (scannedEntries >= MAX_SEARCHED_ENTRIES) {
              truncationReasons.add("entry_limit");
              break searchLoop;
            }
            scannedEntries += 1;
            const entryPath = path.join(checkedDirectory, entry.name);
            if (restricted(relativePortable(root, entryPath))) { skipped.protectedEntries += 1; continue; }
            let info;
            try {
              info = await lstat(entryPath);
            } catch (error) {
              if (isMissing(error)) {
                skipped.changedEntries += 1;
                continue;
              }
              throw error;
            }

            if (entry.isSymbolicLink() || info.isSymbolicLink()) {
              skipped.symlinks += 1;
              continue;
            }
            if (info.isDirectory()) {
              if (await insideProgramFolder(entryPath, { existing: true })) {
                skipped.programFolders = (skipped.programFolders || 0) + 1;
              } else if (entry.name.startsWith(".")) {
                skipped.hiddenDirectories += 1;
              } else if (await insideBrowserFolder(entryPath, browserFolders, { existing: true })) {
                skipped.browserFolders += 1;
              } else {
                directories.push(entryPath);
              }
              continue;
            }
            if (!info.isFile()) {
              skipped.nonRegularFiles += 1;
              continue;
            }
            if (info.nlink > 1) {
              skipped.hardlinkedFiles += 1;
              continue;
            }
            if (searchedFiles >= maxFiles) {
              truncationReasons.add("file_limit");
              break searchLoop;
            }
            if (info.size > maxFileBytes) {
              skipped.oversizedFiles += 1;
              continue;
            }
            if (searchedBytes + info.size > MAX_SEARCH_TOTAL_BYTES) {
              truncationReasons.add("byte_limit");
              break searchLoop;
            }

            const relativeFile = relativePortable(root, entryPath);
            let checkedFile;
            try {
              ({ candidate: checkedFile } = await resolveExisting(root, relativeFile, { type: "file", browserFolders }));
            } catch (error) {
              if (error?.code === "HARDLINK_REJECTED") {
                skipped.hardlinkedFiles += 1;
                continue;
              }
              if (error?.code === "INVALID_PATH") {
                skipped.nonPortableNames += 1;
                continue;
              }
              throw error;
            }
            let buffer;
            try {
              buffer = await readBoundedBuffer(checkedFile, maxFileBytes);
            } catch (error) {
              if (error?.code === "FILE_TOO_LARGE") {
                skipped.oversizedFiles += 1;
                continue;
              }
              if (error?.code === "HARDLINK_REJECTED") {
                skipped.hardlinkedFiles += 1;
                continue;
              }
              throw error;
            }
            searchedFiles += 1;
            searchedBytes += buffer.length;

            let content;
            try {
              content = decodeUtf8(buffer);
            } catch (error) {
              if (error?.code === "INVALID_UTF8") {
                skipped.invalidUtf8Files += 1;
                continue;
              }
              throw error;
            }

            const lines = content.split(/\r?\n/);
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
              const line = lines[lineIndex];
              let from = 0;
              while (from < line.length) {
                let index;
                let length;
                if (caseSensitive) {
                  index = line.indexOf(args.query, from);
                  length = args.query.length;
                } else {
                  pattern.lastIndex = from;
                  const found = pattern.exec(line);
                  index = found ? found.index : -1;
                  length = found ? found[0].length : 0;
                }
                if (index === -1) break;
                matches.push({
                  path: relativeFile,
                  line: lineIndex + 1,
                  column: index + 1,
                  text: snippetFor(line, index, length),
                });
                if (matches.length >= maxResults) {
                  truncationReasons.add("result_limit");
                  break searchLoop;
                }
                from = index + Math.max(length, 1);
              }
            }
          }
        } finally {
          await directory.close().catch(() => {});
        }
      }

      return {
        path: relativePortable(root, start),
        query: args.query,
        caseSensitive,
        matches,
        truncated: truncationReasons.size > 0,
        truncationReasons: [...truncationReasons].sort(),
        searchedFiles,
        searchedBytes,
        scannedEntries,
        limits: {
          maxResults,
          maxFiles,
          maxFileBytes,
          maxTotalBytes: MAX_SEARCH_TOTAL_BYTES,
          maxScannedEntries: MAX_SEARCHED_ENTRIES,
        },
        skipped,
        ...(strict ? { protectedEntryRule: 'OpenAI plugin protected-path policy; names and contents withheld.' } : {}),
      };
    },
  };

  const tools = [list, readFile, writeFile, search];
  if (!strict) return tools;
  const descriptions = {
    'workspace.list': 'List ordinary project entries in one workspace folder, up to 1,000 entries after scanning at most 2,000.',
    'workspace.read_file': 'Read one ordinary UTF-8 project file up to 1 MiB, with its SHA-256.',
    'workspace.write_file': 'Create or replace one ordinary UTF-8 project file using the existing hash checks. Replacing changes the file contents.',
    'workspace.search': 'Search ordinary UTF-8 project files for literal text within the configured workspace and bounded search limits.',
  };
  return tools.map(tool => ({
    ...tool,
    description: `${descriptions[tool.name]} Hidden entries, known credential-store filenames, private-key files, agent instruction files and protected profile folders are refused. Listing and search report counts of protected entries they omit. File content access refuses symlinks, junctions and multiply linked files. Use only for task-relevant project data; do not supply authentication secrets, payment-card data, health records or government identifiers. ${BROWSER_FOLDERS_NOTE}`,
    async handler(args = {}) {
      assertObject(args);
      const segments = portableSegments(args.path ?? '.', { allowRoot: true });
      if (restricted(segments.join('/'))) fail('PLUGIN_FILE_REFUSED', 'The plugin does not access hidden state, credentials or agent configuration.');
      return tool.handler(args);
    },
  }));
}
