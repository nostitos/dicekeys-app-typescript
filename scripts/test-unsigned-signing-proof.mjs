#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import {
  assertAuthenticodeNotSigned,
  assertExpectedMacMainExecutable,
  authenticodeExecutableEnvironmentKey,
  authenticodeInspectionScript,
  classifyMacCodeSigningResult,
  createAuthenticodeInspectionInvocation,
  inspectUnsignedAuthenticode,
  parseAuthenticodeJson,
  parseCodesignDisplay,
} from "./lib/unsigned-signing-proof.mjs";

const adHoc = parseCodesignDisplay(
  "Executable=/tmp/DiceKeys\nIdentifier=DiceKeys\nSignature=adhoc\nTeamIdentifier=not set\n",
);
if (
  adHoc.signature !== "adhoc" ||
  adHoc.identifier !== "DiceKeys" ||
  adHoc.teamIdentifier !== null ||
  adHoc.authorities.length !== 0
) {
  throw new Error("codesign parser did not classify ad-hoc signing correctly");
}
const publisherSigned = parseCodesignDisplay(
  "Identifier=org.example.App\nAuthority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n",
);
if (publisherSigned.authorities.length !== 1 || publisherSigned.teamIdentifier !== "ABCDE12345") {
  throw new Error("codesign parser did not expose publisher authority/team identity");
}

const classifiedAdHoc = classifyMacCodeSigningResult({
  status: 0,
  stderr: "Identifier=DiceKeys\nSignature=adhoc\nTeamIdentifier=not set\n",
});
if (classifiedAdHoc.signingOutcome !== "ad-hoc" || classifiedAdHoc.recognized !== true) {
  throw new Error("codesign classifier did not recognize an explicit ad-hoc result");
}
const classifiedUnsigned = classifyMacCodeSigningResult({
  status: 1,
  stderr: "/tmp/DiceKeys: code object is not signed at all\n",
});
if (classifiedUnsigned.signingOutcome !== "not-signed" || classifiedUnsigned.recognized !== true) {
  throw new Error("codesign classifier did not recognize the exact unsigned result");
}
for (const fixture of [
  { status: 1, stderr: "/tmp/DiceKeys: unrecognized codesign failure\n" },
  { status: 2, stderr: "/tmp/DiceKeys: code object is not signed at all\n" },
  { status: null, stderr: "" },
  { status: 0, stderr: "Identifier=DiceKeys\nSignature=adhoc\nAuthority=Publisher\n" },
  { status: 0, error: new Error("spawn failed"), stderr: "" },
]) {
  let rejected = false;
  try {
    classifyMacCodeSigningResult(fixture);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`codesign classifier accepted an unsafe result: ${JSON.stringify(fixture)}`);
}
assertExpectedMacMainExecutable(
  [{ path: "DiceKeys.app/Contents/MacOS/DiceKeys", recognized: true }],
  "DiceKeys.app/Contents/MacOS/DiceKeys",
);
for (const fixture of [
  [],
  [{ path: "DiceKeys.app/Contents/MacOS/Other", recognized: true }],
  [{ path: "DiceKeys.app/Contents/MacOS/DiceKeys", recognized: false }],
]) {
  let rejected = false;
  try {
    assertExpectedMacMainExecutable(fixture, "DiceKeys.app/Contents/MacOS/DiceKeys");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("main executable coverage assertion accepted an incomplete inventory");
}

const notSignedJson = JSON.stringify({
  Status: "NotSigned",
  StatusMessage: "The file is not digitally signed.",
  SignerSubject: null,
  SignerThumbprint: null,
});
const notSigned = parseAuthenticodeJson(notSignedJson);
if (notSigned.status !== "NotSigned" || notSigned.signerSubject !== null) {
  throw new Error("Authenticode parser did not classify an unsigned executable");
}
assertAuthenticodeNotSigned(notSigned);
const valid = parseAuthenticodeJson(
  JSON.stringify({ Status: "Valid", StatusMessage: "Signature verified.", SignerSubject: "CN=Publisher", SignerThumbprint: "ABC123" }),
);
if (valid.status !== "Valid" || valid.signerSubject !== "CN=Publisher") {
  throw new Error("Authenticode parser did not expose a valid publisher signature");
}
for (const output of [
  "",
  "not-json",
  "{}",
  JSON.stringify({ Status: "NotSigned" }),
  JSON.stringify({
    Status: "NotSigned",
    StatusMessage: null,
    SignerSubject: false,
    SignerThumbprint: null,
  }),
]) {
  let rejected = false;
  try {
    parseAuthenticodeJson(output);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`Authenticode parser accepted malformed output: ${output}`);
}
for (const unsafeResult of [
  valid,
  { ...notSigned, status: "UnknownError" },
  { ...notSigned, signerSubject: "CN=Publisher" },
  { ...notSigned, signerThumbprint: "ABC123" },
]) {
  let rejected = false;
  try {
    assertAuthenticodeNotSigned(unsafeResult);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Authenticode unsigned requirement accepted unsafe evidence: ${JSON.stringify(unsafeResult)}`);
  }
}

const windowsPackageRoot = "C:\\packaged output";
const injectedExecutable = win32.join(
  windowsPackageRoot,
  "DiceKeys '; Write-Error injected; $(Get-ChildItem).exe",
);
const hostileTransportEnvironment = {
  PATH: "C:\\Windows\\System32",
  DICEKEYS_AUTHENTICODE_EXECUTABLE: "C:\\hostile.exe",
  dicekeys_authenticode_executable: "C:\\also-hostile.exe",
  RETAINED_SENTINEL: "retained",
};
const invocationInput = {
  applicationExecutable: injectedExecutable,
  packagedContentRoot: windowsPackageRoot,
  sourceEnvironment: hostileTransportEnvironment,
  pathImplementation: win32,
};
const invocation = createAuthenticodeInspectionInvocation(invocationInput);
if (
  invocation.command !== "powershell.exe" ||
  invocation.args.length !== 5 ||
  invocation.args.at(-1) !== authenticodeInspectionScript ||
  invocation.options.cwd !== win32.resolve(windowsPackageRoot) ||
  !authenticodeInspectionScript.includes(
    `$env:${authenticodeExecutableEnvironmentKey}`,
  ) ||
  invocation.args.some((argument) => argument.includes(injectedExecutable))
) {
  throw new Error("PowerShell Authenticode command interpolated or appended the executable path");
}
const transportedPathEntries = Object.entries(invocation.options.env).filter(
  ([key]) => key.toUpperCase() === authenticodeExecutableEnvironmentKey,
);
if (
  transportedPathEntries.length !== 1 ||
  transportedPathEntries[0][0] !== authenticodeExecutableEnvironmentKey ||
  transportedPathEntries[0][1] !== win32.resolve(injectedExecutable) ||
  invocation.options.env.RETAINED_SENTINEL !== "retained"
) {
  throw new Error("PowerShell Authenticode child environment did not bind exactly one executable path");
}

let capturedInvocation;
const inspected = inspectUnsignedAuthenticode(invocationInput, {
  spawnFunction: (command, args, options) => {
    capturedInvocation = { command, args, options };
    return { status: 0, stdout: notSignedJson, stderr: "" };
  },
});
if (
  inspected.status !== "NotSigned" ||
  capturedInvocation.command !== invocation.command ||
  JSON.stringify(capturedInvocation.args) !== JSON.stringify(invocation.args) ||
  capturedInvocation.options.env[authenticodeExecutableEnvironmentKey] !==
    win32.resolve(injectedExecutable)
) {
  throw new Error("Authenticode inspection helper did not use the validated invocation");
}

for (const applicationExecutable of [
  "relative.exe",
  windowsPackageRoot,
  "C:\\packaged output-other\\DiceKeys.exe",
  "D:\\packaged output\\DiceKeys.exe",
  "C:\\packaged output\\DiceKeys.exe:alternate-stream",
  "C:\\packaged output\\bad\nname.exe",
]) {
  let rejected = false;
  try {
    createAuthenticodeInspectionInvocation({
      ...invocationInput,
      applicationExecutable,
    });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Authenticode invocation accepted unsafe executable path: ${applicationExecutable}`);
  }
}

for (const completed of [
  { error: new Error("spawn failed"), status: null, stdout: "", stderr: "" },
  { status: 1, stdout: "", stderr: "inspection failed" },
  { status: 0, stdout: "not-json", stderr: "" },
  {
    status: 0,
    stdout: JSON.stringify({
      Status: "Valid",
      StatusMessage: "Signature verified.",
      SignerSubject: "CN=Publisher",
      SignerThumbprint: "ABC123",
    }),
    stderr: "",
  },
]) {
  let rejected = false;
  try {
    inspectUnsignedAuthenticode(invocationInput, {
      spawnFunction: () => completed,
    });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Authenticode inspection accepted unsafe completion: ${JSON.stringify(completed)}`);
  }
}

if (process.platform === "win32") {
  const integrationRoot = await mkdtemp(join(tmpdir(), "dicekeys-authenticode-"));
  try {
    const integrationExecutable = join(
      integrationRoot,
      "unsigned ; Write-Error injected.exe",
    );
    await writeFile(integrationExecutable, "unsigned fixture\n");
    const integrationResult = inspectUnsignedAuthenticode({
      applicationExecutable: integrationExecutable,
      packagedContentRoot: integrationRoot,
    });
    if (integrationResult.status !== "NotSigned") {
      throw new Error("real PowerShell Authenticode integration did not report NotSigned");
    }
  } finally {
    await rm(integrationRoot, { recursive: true, force: true });
  }
}

console.log("unsigned package signing proof fails closed and binds the expected main executable");
