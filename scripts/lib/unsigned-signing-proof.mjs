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
  return {
    status: parsed.Status,
    statusMessage: typeof parsed.StatusMessage === "string" ? parsed.StatusMessage : null,
    signerSubject: typeof parsed.SignerSubject === "string" ? parsed.SignerSubject : null,
    signerThumbprint:
      typeof parsed.SignerThumbprint === "string" ? parsed.SignerThumbprint : null,
  };
};
