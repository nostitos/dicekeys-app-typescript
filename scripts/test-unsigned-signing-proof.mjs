#!/usr/bin/env node
import {
  assertExpectedMacMainExecutable,
  classifyMacCodeSigningResult,
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

const notSigned = parseAuthenticodeJson(
  JSON.stringify({ Status: "NotSigned", StatusMessage: "The file is not digitally signed.", SignerSubject: null, SignerThumbprint: null }),
);
if (notSigned.status !== "NotSigned" || notSigned.signerSubject !== null) {
  throw new Error("Authenticode parser did not classify an unsigned executable");
}
const valid = parseAuthenticodeJson(
  JSON.stringify({ Status: "Valid", StatusMessage: "Signature verified.", SignerSubject: "CN=Publisher", SignerThumbprint: "ABC123" }),
);
if (valid.status !== "Valid" || valid.signerSubject !== "CN=Publisher") {
  throw new Error("Authenticode parser did not expose a valid publisher signature");
}

console.log("unsigned package signing proof fails closed and binds the expected main executable");
