/** @jest-environment jsdom */

const mockScanDiceKeyView = jest.fn();

jest.mock("../../images/Scanning a DiceKey.svg", () => "scanning-a-dicekey.svg");
jest.mock("../LoadingDiceKeys/ScanDiceKeyView", () => ({
  ScanDiceKeyView: (props: unknown) => {
    mockScanDiceKeyView(props);
    const ReactActual = jest.requireActual("react") as typeof import("react");
    return ReactActual.createElement(
      "div",
      { "data-testid": "wallet-recovery-scanner" },
      "wallet recovery scanner",
    );
  },
}));
jest.mock("react-dom/server", () => {
  const util = jest.requireActual("util") as typeof import("util");
  if (!("TextEncoder" in globalThis)) {
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: util.TextEncoder,
    });
  }
  if (!("TextDecoder" in globalThis)) {
    Object.defineProperty(globalThis, "TextDecoder", {
      configurable: true,
      value: util.TextDecoder,
    });
  }
  return jest.requireActual("react-dom/server");
});

import React from "react";
import { renderToString } from "react-dom/server";
import { createRoot, Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { observable, runInAction } from "mobx";
import { ServerStyleSheet } from "styled-components";

import type { DiceKeyFaces } from "../../dicekeys/DiceKey";
import type {
  FaceDifference,
  RecoveryDiceKeyFace,
  RecoveryFlowState,
  RecoveryWordEntry,
  RecoveryWordPosition,
} from "./foundation";
import { WalletRecoveryErrorBoundary } from "./WalletRecoveryErrorBoundary";
import { RecoveryRoot } from "./WalletRecoveryStyles";
import { WalletRecoveryView } from "./WalletRecoveryView";
import {
  WalletRecoveryInlineErrorCode,
  WalletRecoverySafeErrorCode,
  WalletRecoveryViewState,
} from "./WalletRecoveryViewState";
import type {
  WalletRecoverySessionCleanupStatus,
} from "./wallet-recovery-session-gate";

type ViewStateSpies = {
  readonly acceptExplanation: jest.Mock<boolean, [unknown]>;
  readonly registerWalletScannerAttempt: jest.Mock<boolean, [unknown]>;
  readonly walletScannerCallbackForCurrentAttempt: jest.Mock<jest.Mock, []>;
  readonly reviewFace: jest.Mock<boolean, [unknown, unknown?]>;
  readonly completeAcquisitionReview: jest.Mock<boolean, []>;
  readonly acknowledgePhysicalBreak: jest.Mock<boolean, []>;
  readonly beginDerivation: jest.Mock<Promise<boolean>, []>;
  readonly reveal: jest.Mock<boolean, []>;
  readonly continueToBackupChoice: jest.Mock<boolean, []>;
  readonly chooseBackupVerification: jest.Mock<boolean, [unknown]>;
  readonly returnToBackupChoice: jest.Mock<boolean, []>;
  readonly submitSixWordChallenge: jest.Mock<boolean, [readonly RecoveryWordEntry[]]>;
  readonly submitFullEntry: jest.Mock<boolean, [readonly RecoveryWordEntry[]]>;
  readonly clear: jest.Mock<void, []>;
  readonly createFresh: jest.Mock;
  readonly mountView: jest.Mock<() => void, []>;
};

const face = Object.freeze({
  letter: "A",
  digit: "1",
  orientationAsLowercaseLetterTrbl: "t",
}) as RecoveryDiceKeyFace;

const secondFace = Object.freeze({
  letter: "B",
  digit: "2",
  orientationAsLowercaseLetterTrbl: "r",
}) as RecoveryDiceKeyFace;

const reviewFaces = Object.freeze(
  Array.from({ length: 25 }, () => face),
) as unknown as DiceKeyFaces;

const wordEntries = Object.freeze(
  Array.from({ length: 24 }, (_, index) => Object.freeze({
    position: index + 1 as RecoveryWordPosition,
    word: `word${String(index + 1).padStart(2, "0")}`,
  })),
);

const difference = Object.freeze({
  position: 1,
  row: 1,
  column: 1,
  fields: Object.freeze(["letter"]),
  firstScanFace: face,
  secondScanFace: secondFace,
}) as FaceDifference;

const makeViewState = (
  flowState: RecoveryFlowState,
  overrides: {
    readonly safeErrorCode?: WalletRecoverySafeErrorCode;
    readonly inlineErrorCode?: WalletRecoveryInlineErrorCode;
    readonly sessionGateStatus?: WalletRecoverySessionCleanupStatus;
    readonly canBeginRecovery?: boolean;
    readonly reviewFaces?: DiceKeyFaces;
    readonly rescanReason?: "ocr-ambiguous";
  } = {},
): {
  readonly viewState: WalletRecoveryViewState;
  readonly spies: ViewStateSpies;
  readonly setFlowState: (nextState: RecoveryFlowState) => void;
  readonly setInlineErrorCode: (
    nextCode: WalletRecoveryInlineErrorCode | undefined,
  ) => void;
} => {
  const flowStateBox = observable.box(flowState, { deep: false });
  const inlineErrorCodeBox = observable.box(overrides.inlineErrorCode, {
    deep: false,
  });
  const scannerCallback = jest.fn();
  const spies: ViewStateSpies = {
    acceptExplanation: jest.fn((_consents: unknown) => true),
    registerWalletScannerAttempt: jest.fn((_handle: unknown) => true),
    walletScannerCallbackForCurrentAttempt: jest.fn(() => scannerCallback),
    reviewFace: jest.fn((_position: unknown, _face?: unknown) => true),
    completeAcquisitionReview: jest.fn(() => true),
    acknowledgePhysicalBreak: jest.fn(() => true),
    beginDerivation: jest.fn(() => Promise.resolve(true)),
    reveal: jest.fn(() => true),
    continueToBackupChoice: jest.fn(() => true),
    chooseBackupVerification: jest.fn((_mode: unknown) => true),
    returnToBackupChoice: jest.fn(() => true),
    submitSixWordChallenge: jest.fn((_entries: readonly RecoveryWordEntry[]) => true),
    submitFullEntry: jest.fn((_entries: readonly RecoveryWordEntry[]) => true),
    clear: jest.fn(),
    createFresh: jest.fn(),
    mountView: jest.fn(() => jest.fn()),
  };
  const viewState = {
    get flowState() { return flowStateBox.get(); },
    get state() { return flowStateBox.get(); },
    reviewFaces: overrides.reviewFaces,
    rescanReason: overrides.rescanReason,
    safeErrorCode: overrides.safeErrorCode,
    get inlineErrorCode() { return inlineErrorCodeBox.get(); },
    sessionGateStatus: overrides.sessionGateStatus ?? "idle",
    canBeginRecovery: overrides.canBeginRecovery ??
      (overrides.sessionGateStatus == null || overrides.sessionGateStatus === "idle"),
    get scannerAttemptKey() {
      const currentState = flowStateBox.get();
      return currentState.kind === "awaiting-first-acquisition" ||
        currentState.kind === "awaiting-second-acquisition"
        ? `${currentState.kind}:${currentState.epoch}`
        : undefined;
    },
    ...spies,
  } as unknown as WalletRecoveryViewState;
  return {
    viewState,
    spies,
    setFlowState: (nextState) => runInAction(() => flowStateBox.set(nextState)),
    setInlineErrorCode: (nextCode) => runInAction(
      () => inlineErrorCodeBox.set(nextCode),
    ),
  };
};

const viewElement = (
  state: RecoveryFlowState,
  overrides: Parameters<typeof makeViewState>[1] = {},
): React.ReactElement => {
  const { viewState } = makeViewState(state, overrides);
  return React.createElement(WalletRecoveryView, {
    state: viewState,
    onExit: jest.fn(),
    onRestart: jest.fn(),
  });
};

const statesAndExpectedCopy: ReadonlyArray<readonly [RecoveryFlowState, string]> = [
  [{ kind: "explain", epoch: 0 }, "Create Bitcoin wallet recovery words"],
  [{ kind: "awaiting-first-acquisition", epoch: 1 }, "Read the complete DiceKey"],
  [{
    kind: "reviewing-first-acquisition",
    epoch: 2,
    reviewRequiredPositions: Object.freeze([1]),
    reviewedPositions: Object.freeze([]),
  }, "Check every flagged face"],
  [{ kind: "releasing-first-acquisition", epoch: 3 }, "Closing the camera safely"],
  [{ kind: "awaiting-physical-break", epoch: 4, firstAcquisitionDisposed: true }, "Move the DiceKey before scan 2"],
  [{ kind: "awaiting-second-acquisition", epoch: 5 }, "Make the independent second reading"],
  [{
    kind: "reviewing-second-acquisition",
    epoch: 6,
    reviewRequiredPositions: Object.freeze([1]),
    reviewedPositions: Object.freeze([]),
  }, "Check every flagged face"],
  [{ kind: "releasing-second-acquisition", epoch: 7 }, "Closing the camera safely"],
  [{ kind: "matched", epoch: 8, rotation: 0 }, "The DiceKey scans match"],
  [{
    kind: "mismatch",
    epoch: 9,
    comparison: {
      kind: "mismatch",
      bestComparison: { rotation: 0, differences: Object.freeze([difference]) },
    },
  }, "Start again with two clean readings"],
  [{
    kind: "alignment-ambiguous",
    epoch: 10,
    comparison: {
      kind: "alignment-ambiguous",
      tiedComparisons: Object.freeze([
        { rotation: 0, differences: Object.freeze([difference]) },
        { rotation: 1, differences: Object.freeze([difference]) },
      ]),
    },
  }, "cannot choose a rotation safely"],
  [{ kind: "deriving", epoch: 11 }, "Creating the recovery material"],
  [{
    kind: "concealed",
    epoch: 12,
    profileId: "DK-BIP39-24-v1",
    checkCode: "1234-5678-9ABC",
  }, "The 24 words are still concealed"],
  [{
    kind: "revealed",
    epoch: 13,
    profileId: "DK-BIP39-24-v1",
    checkCode: "1234-5678-9ABC",
    wordEntries,
  }, "Your 24 recovery words"],
  [{
    kind: "backup-choice",
    epoch: 14,
    profileId: "DK-BIP39-24-v1",
    checkCode: "1234-5678-9ABC",
  }, "Check what you wrote down"],
  [{
    kind: "six-word-challenge",
    epoch: 15,
    profileId: "DK-BIP39-24-v1",
    checkCode: "1234-5678-9ABC",
    positions: Object.freeze([1, 4, 7, 10, 13, 24]),
  }, "Enter the requested words"],
  [{
    kind: "full-entry",
    epoch: 16,
    profileId: "DK-BIP39-24-v1",
    checkCode: "1234-5678-9ABC",
  }, "Enter all 24 words by position"],
  [{
    kind: "verified",
    epoch: 17,
    profileId: "DK-BIP39-24-v1",
    checkCode: "1234-5678-9ABC",
    method: "six-word-challenge",
  }, "Your written recovery backup passed"],
  [{ kind: "failed", epoch: 18, code: "ACQUISITION_FAILED" }, "The scanner attempt failed"],
  [{ kind: "cleared", epoch: 19 }, "Recovery material is no longer available"],
];

describe("WalletRecoveryView", () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    mockScanDiceKeyView.mockClear();
    document.body.replaceChildren();
  });

  it.each(statesAndExpectedCopy)(
    "renders the %s flow state",
    (flowState, expectedCopy) => {
      const html = renderToString(viewElement(
        flowState,
        flowState.kind === "reviewing-first-acquisition" ||
          flowState.kind === "reviewing-second-acquisition"
          ? { reviewFaces }
          : {},
      ));
      expect(html).toContain(expectedCopy);
    },
  );

  it("renders stable row-major numbering for all 24 revealed words", () => {
    const html = renderToString(viewElement({
      kind: "revealed",
      epoch: 1,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
      wordEntries,
    }));
    const host = document.createElement("div");
    host.innerHTML = html;
    const cells = Array.from(host.querySelectorAll(
      'ol[aria-label="Numbered wallet recovery words"] > li',
    ));
    expect(cells).toHaveLength(24);
    cells.forEach((cell, index) => {
      expect(cell.textContent).toContain(`Word ${index + 1}:`);
      expect(cell.textContent).toContain(`word${String(index + 1).padStart(2, "0")}`);
    });
  });

  it("keeps the longest BIP39 words complete and reflows the word grid at narrow or zoomed widths", () => {
    const longestWordEntries = Object.freeze(
      Array.from({ length: 24 }, (_, index) => Object.freeze({
        position: index + 1 as RecoveryWordPosition,
        word: "universe",
      })),
    );
    const sheet = new ServerStyleSheet();
    const html = renderToString(sheet.collectStyles(viewElement({
      kind: "revealed",
      epoch: 1,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
      wordEntries: longestWordEntries,
    })));
    const css = sheet.getStyleTags();
    sheet.seal();
    const host = document.createElement("div");
    host.innerHTML = html;

    expect(host.querySelectorAll("ol[aria-label='Numbered wallet recovery words'] li"))
      .toHaveLength(24);
    expect(host.textContent?.match(/universe/g)).toHaveLength(24);
    expect(css).toContain("overflow-wrap:anywhere");
    expect(css).toContain("white-space:normal");
    expect(css).toContain("@media (min-width: 30rem)");
    expect(css).toContain("grid-template-columns:minmax(0, 1fr)");
  });

  it("exposes labeled mobile steps with exactly one current step", () => {
    const html = renderToString(viewElement({
      kind: "backup-choice",
      epoch: 14,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
    }));
    const host = document.createElement("div");
    host.innerHTML = html;
    const progress = host.querySelector(
      'ol[aria-label="Recovery step 4 of 5"]',
    );
    const steps = Array.from(progress?.querySelectorAll("li") ?? []);
    expect(steps).toHaveLength(5);
    expect(steps.map((step) => step.textContent)).toEqual([
      "Step 1: Prepare",
      "Step 2: Scan twice",
      "Step 3: Reveal",
      "Step 4: Verify backup",
      "Step 5: Finish",
    ]);
    expect(steps.filter((step) => step.getAttribute("aria-current") === "step"))
      .toEqual([steps[3]]);
    const desktopProgress = host.querySelector(
      'nav[aria-label="Recovery ceremony progress"]',
    );
    expect(desktopProgress?.querySelectorAll('[aria-current="step"]'))
      .toHaveLength(1);
  });

  it.each([
    [
      { kind: "failed", epoch: 18, code: "ACQUISITION_FAILED" } as RecoveryFlowState,
      {},
    ],
    [
      {
        kind: "revealed",
        epoch: 13,
        profileId: "DK-BIP39-24-v1",
        checkCode: "1234-5678-9ABC",
        wordEntries,
      } as RecoveryFlowState,
      { safeErrorCode: "DERIVATION_FAILED" as WalletRecoverySafeErrorCode },
    ],
  ])("shows neutral progress for a failed recovery screen", (flowState, overrides) => {
    const html = renderToString(viewElement(flowState, overrides));
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector('[aria-current="step"]')).toBeNull();
    expect(host.querySelector('ol[aria-label^="Recovery step"]')).toBeNull();
    const desktopProgress = host.querySelector(
      'nav[aria-label="Recovery ceremony progress"]',
    );
    expect(desktopProgress?.textContent).toBe(
      "Recovery stopped. No ceremony step is active.",
    );
  });

  it("uses one responsive inline metadata wrapper alongside the desktop safety rail", () => {
    const sheet = new ServerStyleSheet();
    const html = renderToString(sheet.collectStyles(viewElement({
      kind: "revealed",
      epoch: 13,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
      wordEntries,
    })));
    const css = sheet.getStyleTags();
    sheet.seal();
    const host = document.createElement("div");
    host.innerHTML = html;
    const inlineMetadata = host.querySelector(
      '[data-layout="inline-recovery-metadata"]',
    );
    expect(inlineMetadata).not.toBeNull();
    expect(inlineMetadata?.querySelectorAll(
      '[aria-label="Recovery profile metadata"]',
    )).toHaveLength(1);
    expect(host.querySelector(
      'aside[aria-label="Recovery safety and profile details"] ' +
      '[aria-label="Recovery profile metadata"]',
    )).not.toBeNull();
    expect(css).toContain("@media (min-width: 72rem)");
    expect(css).toContain("display:none");
  });

  it("uses a dual black-and-white focus indicator on paper and blue surfaces", () => {
    const sheet = new ServerStyleSheet();
    renderToString(sheet.collectStyles(viewElement({ kind: "explain", epoch: 0 })));
    const css = sheet.getStyleTags();
    sheet.seal();
    expect(css).toContain("outline:3px solid #fff");
    expect(css).toContain("box-shadow:0 0 0 6px #000");
  });

  it("does not render copy, QR, print, or network-export controls", () => {
    const html = renderToString(viewElement({
      kind: "revealed",
      epoch: 1,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
      wordEntries,
    }));
    const host = document.createElement("div");
    host.innerHTML = html;
    const controlNames = Array.from(host.querySelectorAll("button, a"))
      .map((control) => control.textContent ?? "")
      .join(" ");
    expect(controlNames).not.toMatch(/copy|clipboard|qr|print|network/i);
  });

  it("requires all three safety confirmations before scan 1", () => {
    const { viewState, spies } = makeViewState({ kind: "explain", epoch: 0 });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(React.createElement(WalletRecoveryView, {
        state: viewState,
        onExit: jest.fn(),
        onRestart: jest.fn(),
      }));
    });
    const beginButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Begin scan 1"));
    const cancelButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Cancel");
    expect(beginButton).toBeDefined();
    expect(cancelButton?.type).toBe("button");
    expect(beginButton?.disabled).toBe(true);
    const checkboxes = Array.from(host.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    ));
    expect(checkboxes).toHaveLength(3);
    act(() => checkboxes.forEach((checkbox) => checkbox.click()));
    expect(beginButton?.disabled).toBe(false);
    act(() => beginButton?.click());
    expect(spies.acceptExplanation).toHaveBeenCalledWith({
      computerIsOfflineAndTrusted: true,
      understandsWordsControlWallet: true,
      willRetainProfileWithPhysicalDiceKey: true,
    });
    act(() => root.unmount());
  });

  it.each([
    {
      name: "header exit",
      initialState: { kind: "explain", epoch: 0 } as RecoveryFlowState,
      buttonName: "Exit and clear",
    },
    {
      name: "verified finish",
      initialState: {
        kind: "verified",
        epoch: 17,
        profileId: "DK-BIP39-24-v1",
        checkCode: "1234-5678-9ABC",
        method: "six-word-challenge",
      } as RecoveryFlowState,
      buttonName: "Clear recovery data and finish",
    },
  ])("shows the neutral cleared screen before navigation for $name", ({
    initialState,
    buttonName,
  }) => {
    const { viewState, spies, setFlowState } = makeViewState(initialState);
    spies.clear.mockImplementation(() => {
      setFlowState({ kind: "cleared", epoch: initialState.epoch + 1 });
    });
    const onExit = jest.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(React.createElement(WalletRecoveryView, {
        state: viewState,
        onExit,
        onRestart: jest.fn(),
      }));
    });

    const clearButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === buttonName);
    expect(clearButton).toBeDefined();
    act(() => clearButton?.click());
    expect(spies.clear).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Recovery material is no longer available");
    expect(host.textContent).toContain(
      "JavaScript strings cannot be perfectly erased from runtime memory",
    );
    expect(host.querySelector('[aria-current="step"]')).toBeNull();
    expect(host.querySelector('ol[aria-label^="Recovery step"]')).toBeNull();
    expect(host.querySelector(
      'nav[aria-label="Recovery ceremony progress"]',
    )?.textContent).toBe("Ceremony cleared. No recovery step is active.");

    const returnHomeButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Return home");
    act(() => returnHomeButton?.click());
    expect(onExit).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("focuses each genuine destination without exposing the mnemonic through focus", () => {
    const first = makeViewState(
      { kind: "explain", epoch: 0 },
      { reviewFaces },
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const renderState = (viewState: WalletRecoveryViewState) => {
      root.render(React.createElement(WalletRecoveryView, {
        state: viewState,
        onExit: jest.fn(),
        onRestart: jest.fn(),
      }));
    };
    const expectFocusedHeading = (text: string) => {
      expect(document.activeElement?.tagName).toBe("H1");
      expect(document.activeElement?.textContent).toBe(text);
    };

    act(() => renderState(first.viewState));
    expectFocusedHeading("Create Bitcoin wallet recovery words");

    first.spies.acceptExplanation.mockImplementation(() => {
      first.setFlowState({ kind: "awaiting-first-acquisition", epoch: 1 });
      return true;
    });
    const checkboxes = Array.from(host.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    ));
    act(() => checkboxes.forEach((checkbox) => checkbox.click()));
    const beginButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Begin scan 1");
    act(() => beginButton?.click());
    expectFocusedHeading("Read the complete DiceKey");

    act(() => first.setFlowState({
      kind: "reviewing-first-acquisition",
      epoch: 2,
      reviewRequiredPositions: Object.freeze([1]),
      reviewedPositions: Object.freeze([]),
    }));
    expectFocusedHeading("Check every flagged face");

    act(() => first.setFlowState({
      kind: "awaiting-physical-break",
      epoch: 3,
      firstAcquisitionDisposed: true,
    }));
    expectFocusedHeading("Move the DiceKey before scan 2");

    act(() => first.setFlowState({
      kind: "concealed",
      epoch: 4,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
    }));
    first.spies.reveal.mockImplementation(() => {
      first.setFlowState({
        kind: "revealed",
        epoch: 5,
        profileId: "DK-BIP39-24-v1",
        checkCode: "1234-5678-9ABC",
        wordEntries,
      });
      return true;
    });
    const revealButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Reveal 24 recovery words");
    act(() => revealButton?.click());
    expectFocusedHeading("Your 24 recovery words");
    expect(document.activeElement?.textContent).not.toContain("word01");

    first.spies.continueToBackupChoice.mockImplementation(() => {
      first.setFlowState({
        kind: "backup-choice",
        epoch: 6,
        profileId: "DK-BIP39-24-v1",
        checkCode: "1234-5678-9ABC",
      });
      return true;
    });
    const continueButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "I wrote down all 24 words");
    act(() => continueButton?.click());
    expectFocusedHeading("Check what you wrote down");

    act(() => first.setFlowState({
      kind: "verified",
      epoch: 7,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
      method: "six-word-challenge",
    }));
    expectFocusedHeading("Your written recovery backup passed");

    const restarted = makeViewState({ kind: "explain", epoch: 0 });
    act(() => renderState(restarted.viewState));
    expectFocusedHeading("Create Bitcoin wallet recovery words");
    restarted.spies.clear.mockImplementation(() => {
      restarted.setFlowState({ kind: "cleared", epoch: 1 });
    });
    const headerExit = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Exit and clear");
    act(() => headerExit?.click());
    expectFocusedHeading("Recovery material is no longer available");
    act(() => root.unmount());
  });

  it("preserves review control focus across same-screen epoch and validation updates", () => {
    const reviewState: RecoveryFlowState = {
      kind: "reviewing-first-acquisition",
      epoch: 2,
      reviewRequiredPositions: Object.freeze([1]),
      reviewedPositions: Object.freeze([]),
    };
    const { viewState, setFlowState, setInlineErrorCode } = makeViewState(reviewState, {
      reviewFaces,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(React.createElement(WalletRecoveryView, {
      state: viewState,
      onExit: jest.fn(),
      onRestart: jest.fn(),
    })));
    const reviewButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Review position 1"]',
    );
    reviewButton?.focus();
    expect(document.activeElement).toBe(reviewButton);
    act(() => setFlowState({
      ...reviewState,
      epoch: 3,
      reviewedPositions: Object.freeze([1]),
    }));
    expect(document.activeElement).toBe(reviewButton);
    act(() => setInlineErrorCode("REVIEW_INCOMPLETE"));
    expect(host.textContent).toContain(
      "Confirm every flagged face before finishing this scan review",
    );
    expect(document.activeElement).toBe(reviewButton);
    act(() => root.unmount());
  });

  it("preserves the active backup input and its value when mismatch feedback advances the epoch", () => {
    const initialState: RecoveryFlowState = {
      kind: "full-entry",
      epoch: 16,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
    };
    const { viewState, setFlowState } = makeViewState(initialState);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(React.createElement(WalletRecoveryView, {
      state: viewState,
      onExit: jest.fn(),
      onRestart: jest.fn(),
    })));
    const activeInput = host.querySelector<HTMLInputElement>(
      'input[name="word-7"]',
    );
    expect(activeInput).not.toBeNull();
    if (activeInput != null) {
      activeInput.value = "preserve-me";
      activeInput.focus();
    }
    act(() => setFlowState({
      ...initialState,
      epoch: 17,
      feedbackCode: "BACKUP_WORD_MISMATCH",
    }));
    expect(host.textContent).toContain(
      "At least one entered word does not match its numbered position",
    );
    expect(document.activeElement).toBe(activeInput);
    expect(activeInput?.value).toBe("preserve-me");
    act(() => root.unmount());
  });

  it.each([
    [
      "pending" as const,
      "A previous scanner attempt is still cleaning up",
    ],
    [
      "unconfirmed" as const,
      "Close and reload this page or app",
    ],
  ])("blocks scan 1 while renderer cleanup is %s", (sessionGateStatus, copy) => {
    const { viewState, spies } = makeViewState(
      { kind: "explain", epoch: 0 },
      { sessionGateStatus },
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(React.createElement(WalletRecoveryView, {
        state: viewState,
        onExit: jest.fn(),
        onRestart: jest.fn(),
      }));
    });
    const checkboxes = Array.from(host.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    ));
    act(() => checkboxes.forEach((checkbox) => checkbox.click()));
    const beginButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Begin scan 1"));
    expect(host.textContent).toContain(copy);
    expect(beginButton?.disabled).toBe(true);
    act(() => beginButton?.click());
    expect(spies.acceptExplanation).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("always invokes ScanDiceKeyView in wallet-recovery mode", () => {
    const onExit = jest.fn();
    const { viewState, spies } = makeViewState({
      kind: "awaiting-first-acquisition",
      epoch: 3,
    });
    renderToString(React.createElement(WalletRecoveryView, {
      state: viewState,
      onExit,
      onRestart: jest.fn(),
    }));
    expect(mockScanDiceKeyView).toHaveBeenCalledTimes(1);
    const scannerProps = mockScanDiceKeyView.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(scannerProps.scanMode).toBe("wallet-recovery");
    expect(scannerProps.onWalletRecoveryScan).toBe(
      (viewState.walletScannerCallbackForCurrentAttempt as jest.Mock).mock.results[0]?.value,
    );
    expect(scannerProps.onWalletRecoveryAttemptStarted).toBe(
      viewState.registerWalletScannerAttempt,
    );
    expect(typeof scannerProps.onExit).toBe("function");
    (scannerProps.onExit as () => void)();
    expect(spies.clear).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
    expect(scannerProps.onDiceKeyRead).toBeUndefined();
    expect(scannerProps.onRetry).toBeUndefined();
  });

  it("leaves camera-state announcements to the nested scanner", () => {
    const html = renderToString(viewElement({
      kind: "awaiting-first-acquisition",
      epoch: 1,
    }));
    expect(html).not.toContain("Camera active — looking for 25 clear faces");
  });

  it("delegates mismatch restart without reusing or replacing state internally", () => {
    const { viewState, spies } = makeViewState({
      kind: "mismatch",
      epoch: 2,
      comparison: {
        kind: "mismatch",
        bestComparison: { rotation: 0, differences: Object.freeze([difference]) },
      },
    });
    const onRestart = jest.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(React.createElement(WalletRecoveryView, {
        state: viewState,
        onExit: jest.fn(),
        onRestart,
      }));
    });
    const restartButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Clear and scan both again"));
    act(() => restartButton?.click());
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(spies.createFresh).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("keeps full-entry verification usable after secure random selection fails", () => {
    const { viewState, spies } = makeViewState({
      kind: "backup-choice",
      epoch: 14,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
    }, {
      inlineErrorCode: "SECURE_RANDOM_UNAVAILABLE",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(React.createElement(WalletRecoveryView, {
        state: viewState,
        onExit: jest.fn(),
        onRestart: jest.fn(),
      }));
    });
    expect(host.textContent).toContain("Secure random selection is unavailable");
    expect(host.textContent).not.toContain("Recovery stopped safely");
    const sixWordButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Six random positions"));
    const fullEntryButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("All 24 positions"));
    expect(sixWordButton?.disabled).toBe(true);
    expect(fullEntryButton?.disabled).toBe(false);
    act(() => fullEntryButton?.click());
    expect(spies.chooseBackupVerification).toHaveBeenCalledWith("full-entry");
    act(() => root.unmount());
  });

  it("renders a disabled verification choice as muted and non-interactive", () => {
    const sheet = new ServerStyleSheet();
    const html = renderToString(sheet.collectStyles(viewElement({
      kind: "backup-choice",
      epoch: 14,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
    }, {
      inlineErrorCode: "SECURE_RANDOM_UNAVAILABLE",
    })));
    const css = sheet.getStyleTags();
    sheet.seal();
    const host = document.createElement("div");
    host.innerHTML = html;
    const disabledChoice = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Six random positions"));
    expect(disabledChoice?.disabled).toBe(true);
    expect(css).toContain(":hover:not(:disabled)");
    expect(css).toContain(
      ":disabled{color:var(--recovery-muted);background:#eef0f3;" +
      "border-color:#b8c0cd;cursor:not-allowed;opacity:0.72;}",
    );
  });

  it("submits all 24 numbered entries directly to the adapter", () => {
    const { viewState, spies } = makeViewState({
      kind: "full-entry",
      epoch: 1,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(React.createElement(WalletRecoveryView, {
        state: viewState,
        onExit: jest.fn(),
        onRestart: jest.fn(),
      }));
    });
    const inputs = Array.from(host.querySelectorAll<HTMLInputElement>(
      'input[name^="word-"]',
    ));
    expect(inputs).toHaveLength(24);
    inputs.forEach((input, index) => {
      input.value = `entry${index + 1}`;
    });
    const form = inputs[0]?.form;
    expect(form).not.toBeNull();
    const backButton = Array.from(form?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent === "Choose another method");
    expect(backButton?.type).toBe("button");
    act(() => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(spies.submitFullEntry).toHaveBeenCalledWith(
      Array.from({ length: 24 }, (_, index) => ({
        position: index + 1,
        word: `entry${index + 1}`,
      })),
    );
    act(() => root.unmount());
  });

  it("uses next/done hints and advances Enter to the next requested word", () => {
    const { viewState, spies } = makeViewState({
      kind: "six-word-challenge",
      epoch: 1,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
      positions: Object.freeze([1, 4, 7, 10, 13, 24]),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(React.createElement(WalletRecoveryView, {
      state: viewState,
      onExit: jest.fn(),
      onRestart: jest.fn(),
    })));
    const inputs = Array.from(host.querySelectorAll<HTMLInputElement>(
      'input[name^="word-"]',
    ));
    expect(inputs.map((input) => input.getAttribute("enterkeyhint"))).toEqual([
      "next", "next", "next", "next", "next", "done",
    ]);
    inputs[0]?.focus();
    const nextEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    act(() => inputs[0]?.dispatchEvent(nextEvent));
    expect(nextEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(inputs[1]);
    expect(spies.submitSixWordChallenge).not.toHaveBeenCalled();

    inputs[5]?.focus();
    const doneEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    act(() => inputs[5]?.dispatchEvent(doneEvent));
    expect(doneEvent.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(inputs[5]);
    act(() => root.unmount());
  });

  it("uses a placeholder color with at least 4.5:1 contrast on recovery paper", () => {
    const sheet = new ServerStyleSheet();
    renderToString(sheet.collectStyles(viewElement({
      kind: "full-entry",
      epoch: 16,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
    })));
    const css = sheet.getStyleTags();
    sheet.seal();
    const relativeLuminance = (hex: string): number => {
      const channels = hex.match(/[a-f\d]{2}/gi)?.map((component) => {
        const channel = Number.parseInt(component, 16) / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      if (channels == null || channels.length !== 3) return 0;
      return 0.2126 * channels[0]! +
        0.7152 * channels[1]! +
        0.0722 * channels[2]!;
    };
    const foreground = relativeLuminance("#5b6472");
    const background = relativeLuminance("#fffdf8");
    const contrast = (Math.max(foreground, background) + 0.05) /
      (Math.min(foreground, background) + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    expect(css).toContain("::placeholder{color:#5b6472;}");
  });

  it("labels the failure action as clearing before the receipt returns home", () => {
    const initialState: RecoveryFlowState = {
      kind: "failed",
      epoch: 18,
      code: "ACQUISITION_FAILED",
    };
    const { viewState, spies, setFlowState } = makeViewState(initialState);
    spies.clear.mockImplementation(() => {
      setFlowState({ kind: "cleared", epoch: 19 });
    });
    const onExit = jest.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(React.createElement(WalletRecoveryView, {
      state: viewState,
      onExit,
      onRestart: jest.fn(),
    })));
    expect(Array.from(host.querySelectorAll("button"))
      .some((button) => button.textContent === "Return home")).toBe(false);
    const clearButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Clear recovery data");
    expect(clearButton).toBeDefined();
    act(() => clearButton?.click());
    expect(onExit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Recovery material is no longer available");
    const returnHomeButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Return home");
    expect(returnHomeButton).toBeDefined();
    act(() => returnHomeButton?.click());
    expect(onExit).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("describes an unconfirmed cleanup as attempted and requires close/reload", () => {
    const html = renderToString(viewElement({
      kind: "failed",
      epoch: 1,
      code: "ACQUISITION_DISPOSAL_FAILED",
    }));
    expect(html).toContain("Scanner cleanup was attempted");
    expect(html).toContain("Close and reload this page or app");
    expect(html).not.toContain("The scanner realm was stopped");
  });

  it("uses exposure-agnostic unexpected-failure copy after words were revealed", () => {
    const html = renderToString(viewElement({
      kind: "revealed",
      epoch: 13,
      profileId: "DK-BIP39-24-v1",
      checkCode: "1234-5678-9ABC",
      wordEntries,
    }, {
      safeErrorCode: "UNEXPECTED_UI_FAILURE",
    }));
    expect(html).toContain("An unexpected screen failure cleared the active ceremony");
    expect(html).toContain(
      "Any recovery material created or revealed during this ceremony is no longer available in the active flow",
    );
    expect(html).not.toContain("without exposing recovery material");
    expect(html).not.toContain("word01");
  });

  it("clears and renders a payload-free fallback after a render exception", () => {
    const onClear = jest.fn();
    const onExit = jest.fn();
    const onRestart = jest.fn();
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const ThrowDuringRender = (): React.ReactElement => {
      throw new Error("render failed");
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    act(() => {
      root.render(React.createElement(
        RecoveryRoot,
        null,
        React.createElement(
          WalletRecoveryErrorBoundary,
          { onClear, onExit, onRestart, resetKey: {} },
          React.createElement(ThrowDuringRender),
        ),
      ));
    });
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("This recovery screen could not continue");
    expect(host.textContent).not.toContain("render failed");
    const restartButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Start again");
    act(() => restartButton?.click());
    expect(onRestart).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    consoleError.mockRestore();
  });
});
