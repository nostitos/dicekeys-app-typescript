const releaseBuild = process.env.DICEKEYS_RELEASE_BUILD === "1";
const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;

const buildDate = (() => {
  if (sourceDateEpoch != null) {
    if (!/^[0-9]+$/.test(sourceDateEpoch)) {
      throw new Error("SOURCE_DATE_EPOCH must be an integer number of seconds");
    }
    return new Date(Number(sourceDateEpoch) * 1000).toISOString();
  }
  if (releaseBuild) {
    throw new Error("DICEKEYS_RELEASE_BUILD=1 requires SOURCE_DATE_EPOCH");
  }
  return new Date().toISOString();
})();

export const viteBuildConstants = (runningInElectron: boolean) => ({
  VITE_BUILD_VERSION: JSON.stringify(process.env.npm_package_version ?? "0.0.0-unknown"),
  VITE_BUILD_DATE: JSON.stringify(buildDate),
  VITE_SET_APP_RUNNING_IN_ELECTRON: runningInElectron,
});
