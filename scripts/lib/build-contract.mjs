import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const requiredNodeVersion = "22.23.2";
export const requiredNpmVersion = "10.9.8";
export const cacheRoot = join(repositoryRoot, ".cache");
export const vendorCacheRoot = join(cacheRoot, "vendor");
export const vendorArtifactsDirectory = join(vendorCacheRoot, "artifacts");
export const vendorDownloadsDirectory = join(vendorCacheRoot, "downloads");
export const nativeInputsDirectory = join(cacheRoot, "native-inputs");
export const electronRuntimeDirectory = join(nativeInputsDirectory, "electron");
export const buildToolsDirectory = join(repositoryRoot, "vendor", "build-tools");
export const recipesPath = join(repositoryRoot, "vendor", "recipes", "packages.json");
export const emptyUserNpmrc = join(cacheRoot, "npmrc-user-empty");
export const emptyGlobalNpmrc = join(cacheRoot, "npmrc-global-empty");
export const buildHomeDirectory = join(cacheRoot, "home");
export const buildTemporaryDirectory = join(cacheRoot, "tmp");
export const cleanupQuarantineRoot = join(cacheRoot, "quarantine");

const isRetainedInheritedEnvironmentKey = (key) => {
  const normalized = key.toUpperCase();
  return (
    /^(?:PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|OS|SYSTEMDRIVE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|NUMBER_OF_PROCESSORS)$/.test(
      normalized,
    ) ||
    /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/.test(normalized) ||
    /^(?:NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(normalized) ||
    /^(?:SOURCE_DATE_EPOCH|REPOSITORY_ROOT|OFFLINE)$/.test(normalized) ||
    /^(?:DICEKEYS_BUILD_OFFLINE|DICEKEYS_RELEASE_BUILD|DICEKEYS_BUILD_RELEASE_OFFLINE|DICEKEYS_BUILD_RELEASE_ALLOW_DIRTY_EVALUATION|DICEKEYS_BUILD_RELEASE_SOURCE_STATE_SHA256)$/.test(
      normalized,
    )
  );
};

const minimalInheritedEnvironment = (source = process.env) => {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && isRetainedInheritedEnvironmentKey(key)) env[key] = value;
  }
  return env;
};

export const isAllowedBuildEnvironmentKey = (key) => {
  const normalized = key.toUpperCase();
  return (
    isRetainedInheritedEnvironmentKey(key) ||
    /^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|PWD|OLDPWD|SHLVL|_|__CF_USER_TEXT_ENCODING)$/.test(
      normalized,
    ) ||
    /^(?:CI|NO_UPDATE_NOTIFIER|LC_ALL|LANG|TZ|XDG_CACHE_HOME|XDG_CONFIG_HOME|UV_USE_IO_URING)$/.test(
      normalized,
    ) ||
    /^(?:ELECTRON_CONFIG_CACHE|ELECTRON_CACHE|ELECTRON_BUILDER_CACHE)$/.test(normalized) ||
    /^(?:CSC_IDENTITY_AUTO_DISCOVERY)$/.test(normalized) ||
    /^(?:NPM_CONFIG_(?:AUDIT|FUND|UPDATE_NOTIFIER|REGISTRY|USERCONFIG|GLOBALCONFIG|CACHE|OFFLINE|IGNORE_SCRIPTS))$/.test(
      normalized,
    )
  );
};

export const isWindowsRuntimeEnvironmentKey = (key) => {
  const normalized = key.toUpperCase();
  return normalized === "MSYSTEM" || normalized === "COMMONPROGRAMFILES(X86)";
};

export const isCanonicalRuntimeEnvironmentEntry = (
  key,
  value,
  platform = process.platform,
) => {
  const normalized = key.toUpperCase();
  if (normalized === "UV_USE_IO_URING") return platform === "linux" && value === "0";
  if (platform !== "win32") return false;
  if (normalized === "MSYSTEM") return value === "MINGW64";
  if (normalized === "COMMONPROGRAMFILES(X86)") {
    return value === "C:\\Program Files (x86)\\Common Files";
  }
  return false;
};

const baseBuildEnvironment = () => ({
  ...minimalInheritedEnvironment(),
  HOME: buildHomeDirectory,
  USERPROFILE: buildHomeDirectory,
  APPDATA: join(buildHomeDirectory, "AppData", "Roaming"),
  LOCALAPPDATA: join(buildHomeDirectory, "AppData", "Local"),
  TEMP: buildTemporaryDirectory,
  TMP: buildTemporaryDirectory,
  TMPDIR: buildTemporaryDirectory,
  XDG_CACHE_HOME: join(cacheRoot, "xdg"),
  XDG_CONFIG_HOME: join(cacheRoot, "xdg-config"),
  REPOSITORY_ROOT: repositoryRoot,
  CI: "true",
  NO_UPDATE_NOTIFIER: "1",
  LC_ALL: "C",
  LANG: "C",
  TZ: "UTC",
});

export const isSensitiveEnvironmentKey = (key) => {
  const normalized = key.toUpperCase();
  return (
    /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|GH_TOKEN|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/.test(
      normalized,
    ) ||
    /^NPM_CONFIG_.*(?:AUTH|TOKEN|PASSWORD|USERNAME|CERT|KEY)/.test(normalized) ||
    /^(?:CSC_|WIN_CSC_)/.test(normalized) ||
    /^(?:APPLE_(?:ID|APP|TEAM|API|KEYCHAIN)|AC_(?:USERNAME|PASSWORD|PROVIDER))/.test(normalized) ||
    /^(?:MACOS|WINDOWS|WIN)_.*(?:CERT|SIGN|P12|PFX|KEY)/.test(normalized) ||
    /^(?:SIGNING_|SIGNTOOL_)/.test(normalized)
  );
};

export const isHostileBuildEnvironmentKey = (key) => {
  const normalized = key.toUpperCase();
  return (
    /^(?:ELECTRON_SKIP_BINARY_DOWNLOAD|ELECTRON_OVERRIDE_DIST_PATH|ELECTRON_USE_REMOTE_CHECKSUMS|ELECTRON_MIRROR|ELECTRON_NIGHTLY_MIRROR|ELECTRON_CUSTOM_DIR|ELECTRON_CUSTOM_FILENAME|ELECTRON_CUSTOM_VERSION|ELECTRON_GET_USE_PROXY|FORCE_NO_CACHE)$/.test(
      normalized,
    ) ||
    /^(?:NPM_EXECPATH)$/.test(normalized) ||
    /^NPM_CONFIG_(?:IGNORE_SCRIPTS|PLATFORM|ARCH|TARGET_ARCH|TARGET_PLATFORM|BUILD_FROM_SOURCE)$/.test(
      normalized,
    ) ||
    /^NPM_CONFIG_ELECTRON_/.test(normalized)
  );
};

export const isAuthoritativeNpmEnvironmentKey = (key) =>
  /^(?:NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG|REGISTRY|CACHE|AUDIT|FUND|UPDATE_NOTIFIER|IGNORE_SCRIPTS|OFFLINE))$/i.test(
    key,
  );

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sha512Integrity = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export const sha256File = async (path) => sha256(await readFile(path));
export const sha512FileIntegrity = async (path) => sha512Integrity(await readFile(path));

export const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

export const commandEnvironment = async ({ offline = false } = {}) => {
  await initializeBuildCache();
  const env = {
    ...baseBuildEnvironment(),
    electron_config_cache: join(cacheRoot, "electron"),
    ELECTRON_CACHE: join(cacheRoot, "electron"),
    ELECTRON_BUILDER_CACHE: join(cacheRoot, "electron-builder"),
  };
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  env.npm_config_update_notifier = "false";
  env.npm_config_registry = "https://registry.npmjs.org/";
  env.npm_config_userconfig = emptyUserNpmrc;
  env.npm_config_globalconfig = emptyGlobalNpmrc;
  env.npm_config_cache = join(cacheRoot, "npm");
  if (offline) env.npm_config_offline = "true";
  env.DICEKEYS_BUILD_OFFLINE = offline ? "true" : "false";
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  env.npm_config_ignore_scripts = "false";
  env.CI = "true";
  env.NO_UPDATE_NOTIFIER = "1";
  return env;
};

export const run = (command, args, options = {}) => {
  const completed = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    const detail = options.capture
      ? `\n${completed.stdout ?? ""}${completed.stderr ?? ""}`
      : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${completed.status}${detail}`);
  }
  return options.capture ? (completed.stdout ?? "").trim() : "";
};

export const sanitizedGitEnvironment = (source = process.env) => {
  return {
    ...minimalInheritedEnvironment(source),
    HOME: buildHomeDirectory,
    USERPROFILE: buildHomeDirectory,
    LC_ALL: "C",
    LANG: "C",
    TZ: "UTC",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
};

export const runGitBytes = (args, { cwd = repositoryRoot } = {}) => {
  const completed = spawnSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "core.fsmonitor=false",
      "-c",
      `safe.directory=${resolve(cwd)}`,
      ...args,
    ],
    {
      encoding: null,
      env: sanitizedGitEnvironment(),
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit ${completed.status}: ${completed.stderr?.toString("utf8") ?? ""}`,
    );
  }
  return completed.stdout;
};

export const runGit = (args, options = {}) =>
  runGitBytes(args, options).toString("utf8").trim();

export const resolveNpmCli = () => {
  const executablePath = realpathSync(process.execPath);
  const executableDirectory = dirname(executablePath);
  const nodeInstallRoot =
    process.platform === "win32" ? executableDirectory : resolve(executableDirectory, "..");
  const bundledCandidates = [
    join(nodeInstallRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeInstallRoot, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const allowedCandidates = new Set(
    bundledCandidates.flatMap((candidate) => {
      try {
        return [realpathSync(candidate)];
      } catch {
        return [];
      }
    }),
  );
  const candidates = [
    process.env.npm_execpath,
    process.env.NPM_EXECPATH,
    ...allowedCandidates,
  ].filter((candidate) => typeof candidate === "string" && isAbsolute(candidate));
  for (const candidate of [...new Set(candidates)]) {
    let realCandidate;
    try {
      realCandidate = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!allowedCandidates.has(realCandidate)) continue;
    const relativeToInstall = relative(nodeInstallRoot, realCandidate);
    if (
      relativeToInstall === "" ||
      relativeToInstall === ".." ||
      relativeToInstall.startsWith(`..${sep}`) ||
      isAbsolute(relativeToInstall)
    ) {
      continue;
    }
    const info = lstatSync(realCandidate);
    if (!info.isFile() || realCandidate.split(sep).at(-1) !== "npm-cli.js") continue;
    const npmManifestPath = resolve(dirname(realCandidate), "..", "package.json");
    if (!existsSync(npmManifestPath)) continue;
    const npmManifest = JSON.parse(readFileSync(npmManifestPath, "utf8"));
    if (npmManifest.name === "npm" && npmManifest.version === requiredNpmVersion) {
      return realCandidate;
    }
  }
  throw new Error(
    `cannot locate npm ${requiredNpmVersion} bundled under the active Node installation ${nodeInstallRoot}`,
  );
};

export const runNpm = (args, options = {}) =>
  run(process.execPath, [resolveNpmCli(), ...args], options);

export const requireToolchain = () => {
  const actualNode = process.versions.node;
  const actualNpm = runNpm(["--version"], {
    capture: true,
    env: baseBuildEnvironment(),
  });
  if (actualNode !== requiredNodeVersion || actualNpm !== requiredNpmVersion) {
    throw new Error(
      `toolchain mismatch: required Node ${requiredNodeVersion} and npm ${requiredNpmVersion}; ` +
        `found Node ${actualNode} and npm ${actualNpm}. Run your version manager from the repository root.`,
    );
  }
};

const listFiles = async (root, current = root) => {
  const names = await readdir(current);
  const files = [];
  for (const name of names.sort()) {
    const path = join(current, name);
    const info = await lstat(path);
    if (info.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (info.isFile() || info.isSymbolicLink()) files.push(path);
    else throw new Error(`unsupported non-file package entry: ${path}`);
  }
  return files;
};

export const filesystemManifestEntries = async (root, archivePrefix = "") => {
  const entries = [];
  const walk = async (current, relativeDirectory = "") => {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const archivePath = archivePrefix ? `${archivePrefix}/${relativePath}` : relativePath;
      const info = await lstat(path);
      const mode = (info.mode & 0o7777).toString(8).padStart(4, "0");
      if (info.isDirectory()) {
        entries.push({ mode, path: archivePath, type: "directory" });
        await walk(path, relativePath);
      } else if (info.isFile()) {
        entries.push({
          mode,
          path: archivePath,
          sha256: await sha256File(path),
          size: info.size,
          type: "file",
        });
      } else if (info.isSymbolicLink()) {
        entries.push({
          mode,
          path: archivePath,
          target: await readlink(path),
          type: "symbolic-link",
        });
      } else {
        throw new Error(`unsupported filesystem entry: ${path}`);
      }
    }
  };
  await walk(root);
  return entries;
};

export const filesystemManifestHash = (entries) =>
  sha256(Buffer.from(`${JSON.stringify(entries)}\n`, "utf8"));

export const normalizedTreeHash = async (root) => {
  const lines = [];
  for (const path of await listFiles(root)) {
    const relativePath = relative(root, path).split(sep).join("/");
    const info = await lstat(path);
    const fileHash = info.isSymbolicLink()
      ? sha256(Buffer.from(`symlink:${await readlink(path)}`, "utf8"))
      : await sha256File(path);
    lines.push(`${fileHash}  ${relativePath}\n`);
  }
  return sha256(Buffer.from(lines.join(""), "utf8"));
};

export const packageTreeHash = async (archivePath) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "dicekeys-package-tree-"));
  try {
    run("tar", ["-xzf", archivePath, "-C", temporaryRoot]);
    const packageRoot = join(temporaryRoot, "package");
    if (!existsSync(packageRoot)) throw new Error(`${archivePath} has no package/ root`);
    return await normalizedTreeHash(packageRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

export const verifyPackageArtifact = async (
  archivePath,
  expected,
  { packageTreeHashFunction = packageTreeHash } = {},
) => {
  const sha256Value = await sha256File(archivePath);
  const integrityValue = await sha512FileIntegrity(archivePath);
  if (sha256Value !== expected.sha256 || integrityValue !== expected.integrity) {
    return {
      matches: false,
      phase: "compressed-digest",
      actual: { sha256: sha256Value, integrity: integrityValue },
    };
  }
  const packageTreeSha256 = await packageTreeHashFunction(archivePath);
  return {
    matches: packageTreeSha256 === expected.packageTreeSha256,
    phase: "package-tree",
    actual: { sha256: sha256Value, integrity: integrityValue, packageTreeSha256 },
  };
};

export const assertPathInside = (candidate, parent) => {
  if (relativePathInside(candidate, parent) === null) {
    throw new Error(`refusing path outside ${parent}: ${candidate}`);
  }
};

export const relativePathInside = (
  candidate,
  parent,
  pathImplementation = { resolve, relative, isAbsolute, sep },
) => {
  const parentPath = pathImplementation.resolve(parent);
  const candidatePath = pathImplementation.resolve(candidate);
  const relativePath = pathImplementation.relative(parentPath, candidatePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${pathImplementation.sep}`) ||
    pathImplementation.isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath.split(pathImplementation.sep).join("/");
};

export const assertNoSymlinkPath = async (candidate, parent = repositoryRoot) => {
  assertPathInside(candidate, parent);
  const resolvedParent = await realpath(resolve(parent));
  const relativePath = relative(resolve(parent), resolve(candidate));
  let current = resolvedParent;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`refusing path with symlink ancestor: ${current}`);
    }
  }
};

export const safeRemoveTree = async (
  candidate,
  parent = repositoryRoot,
  {
    renameFunction = rename,
    quarantineRoot = cleanupQuarantineRoot,
    randomBytesFunction = randomBytes,
  } = {},
) => {
  const resolvedCandidate = resolve(candidate);
  await assertNoSymlinkPath(resolvedCandidate, parent);
  let candidateInfo;
  try {
    candidateInfo = await lstat(resolvedCandidate);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) {
    throw new Error(`refusing recursive cleanup of a non-directory: ${resolvedCandidate}`);
  }
  const candidateParent = dirname(resolvedCandidate);
  const resolvedQuarantineRoot = resolve(quarantineRoot);
  await assertNoSymlinkPath(resolvedQuarantineRoot, parent);
  await mkdir(resolvedQuarantineRoot, { recursive: true, mode: 0o700 });
  const quarantineRootInfo = await lstat(resolvedQuarantineRoot);
  if (!quarantineRootInfo.isDirectory() || quarantineRootInfo.isSymbolicLink()) {
    throw new Error(`cleanup quarantine root is not a real directory: ${resolvedQuarantineRoot}`);
  }
  const [sourceParentDevice, quarantineDevice] = await Promise.all([
    stat(candidateParent),
    stat(resolvedQuarantineRoot),
  ]);
  if (sourceParentDevice.dev !== quarantineDevice.dev) {
    throw new Error(
      `cleanup quarantine must share a filesystem with its target: ${resolvedCandidate}`,
    );
  }

  let reservationPath;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidateReservation = join(
      resolvedQuarantineRoot,
      `${basename(resolvedCandidate)}.${process.pid}.${randomBytesFunction(16).toString("hex")}`,
    );
    try {
      await mkdir(candidateReservation, { mode: 0o700 });
      reservationPath = candidateReservation;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (!reservationPath) throw new Error("could not reserve a unique cleanup quarantine path");
  const quarantinePath = join(reservationPath, "tree");

  // Renaming on the same filesystem atomically detaches the validated entry.
  // Never recursively remove the quarantined tree: a nested bind/mount can
  // remain traversable even when the top-level rename succeeds.
  try {
    await renameFunction(resolvedCandidate, quarantinePath);
  } catch (error) {
    await rmdir(reservationPath).catch(() => {});
    throw error;
  }
  const quarantinedInfo = await lstat(quarantinePath);
  if (!quarantinedInfo.isDirectory() || quarantinedInfo.isSymbolicLink()) {
    throw new Error(`cleanup target changed type during quarantine: ${quarantinePath}`);
  }
  return quarantinePath;
};

const safeCacheDirectories = (root) => {
  const rootCache = join(root, ".cache");
  return [
    rootCache,
    join(rootCache, "npm"),
    join(rootCache, "electron"),
    join(rootCache, "electron-builder"),
    join(rootCache, "xdg"),
    join(rootCache, "xdg-config"),
    join(rootCache, "home"),
    join(rootCache, "home", "AppData", "Roaming"),
    join(rootCache, "home", "AppData", "Local"),
    join(rootCache, "tmp"),
    join(rootCache, "quarantine"),
    join(rootCache, "vendor"),
    join(rootCache, "vendor", "downloads"),
    join(rootCache, "vendor", "artifacts"),
    join(rootCache, "native-inputs"),
    join(rootCache, "native-inputs", "electron"),
    join(rootCache, "test-results"),
  ];
};

export const initializeBuildCache = async (root = repositoryRoot) => {
  const resolvedRoot = resolve(root);
  for (const directory of safeCacheDirectories(resolvedRoot)) {
    await assertNoSymlinkPath(directory, resolvedRoot);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`build cache path is not a real directory: ${directory}`);
    }
  }

  for (const npmrcPath of [
    join(resolvedRoot, ".cache", "npmrc-user-empty"),
    join(resolvedRoot, ".cache", "npmrc-global-empty"),
  ]) {
    await assertNoSymlinkPath(npmrcPath, resolvedRoot);
    if (existsSync(npmrcPath)) {
      const existing = await lstat(npmrcPath);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
        throw new Error(`refusing unsafe npmrc cache target: ${npmrcPath}`);
      }
    }
    const handle = await open(
      npmrcPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new Error(`opened npmrc cache target is not a unique regular file: ${npmrcPath}`);
      }
    } finally {
      await handle.close();
    }
    await chmod(npmrcPath, 0o600);
  }
};

export const isUniqueRegularFile = async (path) => {
  if (!existsSync(path)) return false;
  const info = await lstat(path);
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
};

export const publishVerifiedBytes = async (bytes, destination, verify) => {
  const destinationPath = resolve(destination);
  const destinationDirectory = dirname(destinationPath);
  await assertNoSymlinkPath(destinationDirectory);
  const directoryInfo = await lstat(destinationDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`cache publication parent is not a real directory: ${destinationDirectory}`);
  }
  const temporaryPath = join(
    destinationDirectory,
    `.${destinationPath.split(sep).at(-1)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
      if (!bytesWritten) throw new Error(`short write while publishing cache file: ${destinationPath}`);
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (!(await isUniqueRegularFile(temporaryPath))) {
      throw new Error(`cache publication temporary file is unsafe: ${temporaryPath}`);
    }
    if (!(await verify(temporaryPath))) {
      throw new Error(`cache publication verification failed: ${destinationPath}`);
    }
    if (existsSync(destinationPath)) {
      const destinationInfo = await lstat(destinationPath);
      if (destinationInfo.isDirectory() && !destinationInfo.isSymbolicLink()) {
        throw new Error(`refusing to replace cache directory with a file: ${destinationPath}`);
      }
      await unlink(destinationPath);
    }
    await rename(temporaryPath, destinationPath);
    if (!(await isUniqueRegularFile(destinationPath)) || !(await verify(destinationPath))) {
      throw new Error(`published cache file did not retain its verified identity: ${destinationPath}`);
    }
  } finally {
    if (existsSync(temporaryPath)) await unlink(temporaryPath);
  }
};

export const publishVerifiedFile = async (source, destination, verify) =>
  publishVerifiedBytes(await readFile(source), destination, verify);
