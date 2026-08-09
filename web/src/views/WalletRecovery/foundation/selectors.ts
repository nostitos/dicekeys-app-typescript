import type {
  RecoveryFlowState,
  RecoveryWordEntry,
  RecoveryWordPosition,
} from "./types";

export const selectRecoveryWordEntries = (
  state: RecoveryFlowState,
): readonly RecoveryWordEntry[] | undefined => {
  switch (state.kind) {
    case "revealed":
      return state.wordEntries;
    default:
      return undefined;
  }
};

export const selectRecoveryCheckCode = (
  state: RecoveryFlowState,
): string | undefined => {
  switch (state.kind) {
    case "concealed":
    case "revealed":
    case "backup-choice":
    case "six-word-challenge":
    case "full-entry":
    case "verified":
      return state.checkCode;
    default:
      return undefined;
  }
};

export const selectChallengePositions = (
  state: RecoveryFlowState,
): readonly RecoveryWordPosition[] | undefined =>
  state.kind === "six-word-challenge" ? state.positions : undefined;
