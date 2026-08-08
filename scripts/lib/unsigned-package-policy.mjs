const forbiddenBasename = /^(?:\.env(?:\..*)?|electron-builder\.env|electron-builder(?:\.unsigned)?\.js|notarize\.js|\.npmrc|npmrc|\.yarnrc(?:\.yml)?|\.pnpmrc|pnpm-workspace\.yaml|\.nvmrc|\.node-version)$/i;
const forbiddenExtension = /\.(?:pem|p8|key|crt|cer|p12|pfx|mobileprovision|provisionprofile)$/i;

export const isForbiddenPackagedPath = (path) => {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const basename = normalized.split("/").at(-1) ?? "";
  return forbiddenBasename.test(basename) || forbiddenExtension.test(basename);
};

export const requiredUnsignedExclusions = [
  "!electron-builder.env",
  "!**/.npmrc",
  "!**/*.pem",
  "!**/*.p8",
  "!**/*.key",
  "!**/*.crt",
  "!**/*.cer",
  "!**/*.p12",
  "!**/*.pfx",
  "!**/*.mobileprovision",
  "!**/*.provisionprofile",
];
