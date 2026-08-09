import { DK_BIP39_24_V1 } from "../DiceKeyBip39ProfileV1/profile";

export const RECOVERY_PROFILE_CHECK_CODE_V1 = Object.freeze({
  label: "Recovery profile check code v1",
  domain: "DiceKeys/RecoveryProfileCheckCode/v1",
  profileId: DK_BIP39_24_V1.id,
  digestAlgorithm: "SHA-256",
  codeByteLength: 6,
} as const);
