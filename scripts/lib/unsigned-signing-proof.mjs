import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const authenticodeExecutableEnvironmentKey =
  "DICEKEYS_AUTHENTICODE_EXECUTABLE";

export const authenticodeInspectionScript = [
  "$ErrorActionPreference='Stop'",
  `$executable=$env:${authenticodeExecutableEnvironmentKey}`,
  "if([string]::IsNullOrWhiteSpace($executable)){throw 'missing Authenticode executable path'}",
  "$signature=Get-AuthenticodeSignature -LiteralPath $executable -ErrorAction Stop",
  "[pscustomobject]@{Status=[string]$signature.Status;StatusMessage=$signature.StatusMessage;SignerSubject=if($signature.SignerCertificate){$signature.SignerCertificate.Subject}else{$null};SignerThumbprint=if($signature.SignerCertificate){$signature.SignerCertificate.Thumbprint}else{$null}} | ConvertTo-Json -Compress",
].join("; ");

export const createAuthenticodeInspectionInvocation = ({
  applicationExecutable,
  packagedContentRoot,
  sourceEnvironment = process.env,
  pathImplementation = { isAbsolute, relative, resolve, sep },
}) => {
  if (
    typeof applicationExecutable !== "string" ||
    typeof packagedContentRoot !== "string" ||
    !pathImplementation.isAbsolute(applicationExecutable) ||
    !pathImplementation.isAbsolute(packagedContentRoot) ||
    /[\0-\x1f\x7f]/.test(applicationExecutable) ||
    /[\0-\x1f\x7f]/.test(packagedContentRoot)
  ) {
    throw new Error("Authenticode executable and package root must be absolute safe paths");
  }
  const packageRoot = pathImplementation.resolve(packagedContentRoot);
  const executable = pathImplementation.resolve(applicationExecutable);
  const relativeExecutable = pathImplementation.relative(packageRoot, executable);
  if (
    !relativeExecutable ||
    relativeExecutable === ".." ||
    relativeExecutable.startsWith(`..${pathImplementation.sep}`) ||
    pathImplementation.isAbsolute(relativeExecutable) ||
    relativeExecutable.includes(":") ||
    relativeExecutable
      .split(pathImplementation.sep)
      .some((component) => !component || component === "." || component === "..")
  ) {
    throw new Error("Authenticode executable must be strictly inside the packaged content root");
  }
  const env = {};
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (
      value !== undefined &&
      key.toUpperCase() !== authenticodeExecutableEnvironmentKey
    ) {
      env[key] = value;
    }
  }
  env[authenticodeExecutableEnvironmentKey] = executable;
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      authenticodeInspectionScript,
    ],
    options: {
      cwd: packageRoot,
      encoding: "utf8",
      env,
      windowsHide: true,
    },
  };
};

export const parseCodesignDisplay = (output) => {
  const lines = String(output).split(/\r?\n/);
  const field = (name) =>
    lines.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? null;
  const teamIdentifier = field("TeamIdentifier");
  return {
    authorities: lines
      .filter((line) => line.startsWith("Authority="))
      .map((line) => line.slice("Authority=".length).trim()),
    identifier: field("Identifier"),
    signature: field("Signature"),
    teamIdentifier:
      !teamIdentifier || teamIdentifier.toLowerCase() === "not set" ? null : teamIdentifier,
  };
};

export const classifyMacCodeSigningResult = ({ error = null, status, stdout = "", stderr = "" }) => {
  if (error) throw new Error(`codesign inspection could not start: ${error.message ?? error}`);
  if (!Number.isInteger(status)) throw new Error("codesign inspection returned no exit status");
  const output = `${stdout}${stderr}`;
  const signing = parseCodesignDisplay(output);
  if (signing.authorities.length || signing.teamIdentifier) {
    throw new Error(
      `publisher signing identity found: authorities=${signing.authorities.join(",")} team=${signing.teamIdentifier ?? "none"}`,
    );
  }
  if (status === 0 && signing.signature === "adhoc" && signing.identifier) {
    return { ...signing, signingOutcome: "ad-hoc", recognized: true };
  }
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    status === 1 &&
    lines.length === 1 &&
    /^.+: code object is not signed at all$/.test(lines[0])
  ) {
    return { ...signing, signingOutcome: "not-signed", recognized: true };
  }
  throw new Error(
    `codesign inspection result was not a recognized ad-hoc or unsigned outcome (status=${status}): ${output.trim()}`,
  );
};

export const assertExpectedMacMainExecutable = (codeObjects, expectedPath) => {
  if (typeof expectedPath !== "string" || !expectedPath) {
    throw new Error("expected macOS application executable path is missing");
  }
  const matching = codeObjects.filter((entry) => entry.path === expectedPath);
  if (matching.length !== 1) {
    throw new Error(
      `expected macOS application executable was not inspected exactly once: ${expectedPath}`,
    );
  }
  if (matching[0].recognized !== true) {
    throw new Error(`expected macOS application executable has no recognized signing outcome: ${expectedPath}`);
  }
};

export const parseAuthenticodeJson = (output) => {
  let parsed;
  try {
    parsed = JSON.parse(String(output).trim());
  } catch (error) {
    throw new Error(`PowerShell Authenticode output was not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed.Status !== "string") {
    throw new Error("PowerShell Authenticode output has no status");
  }
  for (const field of ["StatusMessage", "SignerSubject", "SignerThumbprint"]) {
    if (
      !Object.hasOwn(parsed, field) ||
      (parsed[field] !== null && typeof parsed[field] !== "string")
    ) {
      throw new Error(`PowerShell Authenticode output has invalid ${field}`);
    }
  }
  return {
    status: parsed.Status,
    statusMessage: parsed.StatusMessage,
    signerSubject: parsed.SignerSubject,
    signerThumbprint: parsed.SignerThumbprint,
  };
};

export const assertAuthenticodeNotSigned = (authenticode) => {
  if (
    !authenticode ||
    authenticode.status !== "NotSigned" ||
    authenticode.signerSubject !== null ||
    authenticode.signerThumbprint !== null
  ) {
    throw new Error(
      `Windows application executable has or may have publisher signing: ${JSON.stringify(authenticode)}`,
    );
  }
  return authenticode;
};

export const inspectUnsignedAuthenticode = (
  input,
  { spawnFunction = spawnSync } = {},
) => {
  const invocation = createAuthenticodeInspectionInvocation(input);
  const completed = spawnFunction(
    invocation.command,
    invocation.args,
    invocation.options,
  );
  if (completed.error || completed.status !== 0) {
    throw new Error(
      `PowerShell Authenticode inspection failed: ${completed.error?.message ?? ""}\n${completed.stdout ?? ""}${completed.stderr ?? ""}`,
    );
  }
  return assertAuthenticodeNotSigned(parseAuthenticodeJson(completed.stdout));
};
