const base = require("./electron-builder.js");
const path = require("node:path");
const repositoryRoot = path.resolve(__dirname, "..");
const authoritativeOfflineMode =
  process.env.DICEKEYS_BUILD_OFFLINE ?? process.env.DICEKEYS_BUILD_RELEASE_OFFLINE;
const offlineRequested = /^(?:1|true)$/i.test(
  authoritativeOfflineMode ??
    process.env.npm_config_offline ??
    process.env.NPM_CONFIG_OFFLINE ??
    "",
);

for (const environmentName of Object.keys(process.env)) {
  if (
    /^NPM_CONFIG_/i.test(environmentName) ||
    /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|GH_TOKEN|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/i.test(
      environmentName,
    ) ||
    /^NPM_CONFIG_.*(?:AUTH|TOKEN|PASSWORD|USERNAME|CERT|KEY|ELECTRON|PLATFORM|ARCH)/i.test(
      environmentName,
    ) ||
    /^(?:ELECTRON_SKIP_BINARY_DOWNLOAD|ELECTRON_OVERRIDE_DIST_PATH|ELECTRON_USE_REMOTE_CHECKSUMS|ELECTRON_MIRROR|ELECTRON_NIGHTLY_MIRROR|ELECTRON_CUSTOM_DIR|ELECTRON_CUSTOM_FILENAME|ELECTRON_CUSTOM_VERSION|FORCE_NO_CACHE)$/i.test(
      environmentName,
    ) ||
    /^(?:CSC_|WIN_CSC_|APPLE_(?:ID|APP|TEAM|API|KEYCHAIN)|AC_(?:USERNAME|PASSWORD|PROVIDER)|SIGNING_|SIGNTOOL_)/i.test(
      environmentName,
    ) ||
    /^(?:MACOS|WINDOWS|WIN)_.*(?:CERT|SIGN|P12|PFX|KEY)/i.test(environmentName)
  ) {
    delete process.env[environmentName];
  }
}
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
Object.assign(process.env, {
  npm_config_userconfig: path.join(repositoryRoot, ".cache", "npmrc-user-empty"),
  npm_config_globalconfig: path.join(repositoryRoot, ".cache", "npmrc-global-empty"),
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_cache: path.join(repositoryRoot, ".cache", "npm"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_ignore_scripts: "false",
  ...(offlineRequested ? { npm_config_offline: "true" } : {}),
});

const { afterSign: _legacyAfterSign, ...baseWithoutAfterSign } = base;
const { provisioningProfile: _legacyProvisioningProfile, ...baseMacWithoutProfile } = base.mac;
const {
  certificateSha1: _legacyCertificateSha1,
  certificateSubjectName: _legacyCertificateSubjectName,
  ...baseWinWithoutCertificates
} = base.win;

const unsigned = {
  ...baseWithoutAfterSign,
  electronDist: "../.cache/native-inputs/electron",
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  artifactName: "${productName}-${version}-${os}-${arch}-unsigned.${ext}",
  forceCodeSigning: false,
  files: [
    ...(base.files ?? []),
    "!electron-builder.unsigned.js",
    "!electron-builder.env",
    "!scripts",
    "!.env",
    "!.env.*",
    "!**/.npmrc",
    "!**/.yarnrc",
    "!**/.yarnrc.yml",
    "!**/.pnpmrc",
    "!**/pnpm-workspace.yaml",
    "!**/.nvmrc",
    "!**/.node-version",
    "!**/*.pem",
    "!**/*.p8",
    "!**/*.key",
    "!**/*.crt",
    "!**/*.p12",
    "!**/*.pfx",
    "!**/*.cer",
    "!**/*.mobileprovision",
    "!**/*.provisionprofile",
  ],
  directories: {
    ...base.directories,
    output: "out/unsigned",
  },
  mac: {
    ...baseMacWithoutProfile,
    identity: null,
  },
  dmg: {
    ...base.dmg,
    sign: false,
  },
  win: {
    ...baseWinWithoutCertificates,
    signAndEditExecutable: false,
  },
};

module.exports = unsigned;
