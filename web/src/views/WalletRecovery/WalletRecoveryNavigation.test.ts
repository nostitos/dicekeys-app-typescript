/** @jest-environment jsdom */

jest.mock("../../images/Scanning a DiceKey.svg", () => "scan.svg");
jest.mock("../../images/Illustration of shaking bag.svg", () => "shake.svg");
jest.mock("../../images/Box Bottom After Roll.svg", () => "box.svg");
jest.mock("../../images/Seal Box.svg", () => "seal.svg");
jest.mock("../../state/stores/DiceKeyMemoryStore", () => ({
  DiceKeyMemoryStore: {
    keysInMemoryOrSavedToDevice: [],
    keysOnlyInMemory: [],
    keyIdForCenterLetterAndDigit: jest.fn(),
    diceKeyForKeyId: jest.fn(),
    removeAll: jest.fn(),
    load: jest.fn(),
    removeDiceKey: jest.fn(),
    addDiceKeyWithKeyId: jest.fn(),
  },
  PlatformSupportsSavingToDevice: false,
}));
jest.mock("../SVG/DiceKeyView", () => ({
  DiceKeyView: () => null,
}));
jest.mock("../AppStoreInstallNudgeView", () => ({
  AppStoreInstallNudgeView: () => null,
}));
jest.mock("../WindowHomeNavigationBar", () => ({
  WindowHomeNavigationBar: () => null,
}));
jest.mock("../Recipes/SeedHardwareKeyViewState", () => ({
  SeedHardwareKeyViewState: class SeedHardwareKeyViewState {},
}));
jest.mock("../WithSelectedDiceKey/SelectedDiceKeyViewState", () => ({
  SelectedDiceKeyViewState: class SelectedDiceKeyViewState {},
}));
jest.mock("../SaveOrDeleteDiceKeyViewState", () => ({
  SaveDiceKeyViewStateName: "SaveDiceKeyViewState",
  DeleteDiceKeyViewStateName: "DeleteDiceKeyViewState",
  SaveOrDeleteDiceKeyStateName: "SaveOrDeleteDiceKeyState",
  SaveDiceKeyViewState: class SaveDiceKeyViewState {},
  DeleteDiceKeyViewState: class DeleteDiceKeyViewState {},
  SaveOrDeleteDiceKeyViewState: class SaveOrDeleteDiceKeyViewState {},
}));
jest.mock("../SimpleSecretSharing/SecretSharingRecoveryState", () => ({
  SecretSharingRecoveryState: class SecretSharingRecoveryState {},
}));
jest.mock("../WithSelectedDiceKey/DiceKeyInMemoryStoreState", () => ({
  DiceKeyInMemoryStoreState: class DiceKeyInMemoryStoreState {
    public readonly getSetDiceKey = {};
    public readonly setDiceKey = jest.fn();
    public readonly getDiceKey = jest.fn();
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
import { ServerStyleSheet, ThemeProvider } from "styled-components";

import { lightTheme } from "../../css/lightTheme";
import { NavigationPathState } from "../../state/core/NavigationPathState";
import { DiceKeyMemoryStore } from "../../state/stores/DiceKeyMemoryStore";
import { WindowTopLevelNavigationState } from "../../state/WindowTopLevelNavigationState";
import { PathStrings } from "../Navigation/PathStrings";
import { WindowHomeView } from "../WindowHomeView";
import { WalletRecoveryViewState } from "./WalletRecoveryViewState";

const traverseHistory = async (traverse: () => void): Promise<void> => {
  const popped = new Promise<void>((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
  });
  traverse();
  await popped;
};

describe("wallet recovery navigation", () => {
  test("restart uses one constant route and a distinct fresh adapter", () => {
    const initialRecoveryState = new WalletRecoveryViewState(
      NavigationPathState.root,
    );
    expect(PathStrings.WalletRecovery).toBe("wallet-recovery");
    expect(initialRecoveryState.navState.path).toBe("/wallet-recovery");
    expect(initialRecoveryState.flowState.kind).toBe("explain");

    const restartedRecoveryState = initialRecoveryState.createFresh();
    expect(restartedRecoveryState).not.toBe(initialRecoveryState);
    expect(initialRecoveryState.flowState.kind).toBe("cleared");
    expect(restartedRecoveryState.flowState.kind).toBe("explain");
    expect(restartedRecoveryState.navState.path).toBe("/wallet-recovery");
  });

  test("home presents wallet recovery as the first primary action", () => {
    const topLevelState = {
      navigateToWalletRecovery: jest.fn(),
      navigateToLoadDiceKey: jest.fn(),
      navigateToAssemblyInstructions: jest.fn(),
      navigateToRecoverFromShares: jest.fn(),
      navigateToSelectedDiceKeyView: jest.fn(),
      loadStoredDiceKey: jest.fn(),
      autoEraseDisabled: false,
      autoEraseCountdownTimer: { secondsRemaining: 60 },
      enableAutoErase: jest.fn(),
      disableAutoErase: jest.fn(),
    } as unknown as WindowTopLevelNavigationState;
    const html = renderToString(
      React.createElement(
        ThemeProvider,
        { theme: lightTheme },
        React.createElement(WindowHomeView, { state: topLevelState }),
      ),
    );

    const recoveryActionIndex = html.indexOf(
      "Create Bitcoin wallet recovery words",
    );
    const loadActionIndex = html.indexOf("Load DiceKey");
    expect(recoveryActionIndex).toBeGreaterThanOrEqual(0);
    expect(loadActionIndex).toBeGreaterThan(recoveryActionIndex);
  });

  test("the 375px home action region remains scrollable with stored keys and a short viewport", () => {
    const topLevelState = {
      navigateToWalletRecovery: jest.fn(),
      navigateToLoadDiceKey: jest.fn(),
      navigateToAssemblyInstructions: jest.fn(),
      navigateToRecoverFromShares: jest.fn(),
      navigateToSelectedDiceKeyView: jest.fn(),
      loadStoredDiceKey: jest.fn(),
      autoEraseDisabled: false,
      autoEraseCountdownTimer: { secondsRemaining: 60 },
      enableAutoErase: jest.fn(),
      disableAutoErase: jest.fn(),
    } as unknown as WindowTopLevelNavigationState;
    const storedKeys = DiceKeyMemoryStore.keysInMemoryOrSavedToDevice as unknown as Array<{
      centerLetterAndDigit: "A1";
      keyId: string;
      savedOnDevice: boolean;
    }>;
    storedKeys.push({
      centerLetterAndDigit: "A1",
      keyId: "layout-regression-key",
      savedOnDevice: false,
    });
    const sheet = new ServerStyleSheet();
    let html = "";
    try {
      html = renderToString(sheet.collectStyles(
        React.createElement(
          ThemeProvider,
          { theme: lightTheme },
          React.createElement(WindowHomeView, { state: topLevelState }),
        ),
      ));
      const css = sheet.getStyleTags();
      expect(css).toContain("min-height:0");
      expect(css).toContain("overflow-y:auto");
      expect(css).toContain("max-height: 32rem");
      expect(css).toContain("max-width: 23.5rem");
      expect(css).toContain("env(safe-area-inset-bottom)");
    } finally {
      sheet.seal();
      storedKeys.splice(0, storedKeys.length);
    }
    const host = document.createElement("div");
    host.innerHTML = html;
    const actionRegion = host.querySelector(
      '[data-layout="home-action-scroll-region"]',
    );
    expect(actionRegion).not.toBeNull();
    expect(actionRegion?.textContent).toContain("Key A1");
    expect(actionRegion?.textContent).toContain(
      "Create Bitcoin wallet recovery words",
    );
    expect(actionRegion?.textContent).toContain("Load DiceKey");
    expect(actionRegion?.textContent).toContain("Assembly Instructions");
  });

  test("deep-link Back and Forward always install a fresh recovery adapter", async () => {
    window.history.replaceState(null, "", `/${PathStrings.WalletRecovery}`);
    const topLevelState = WindowTopLevelNavigationState.fromPath();
    const firstRecoveryState = topLevelState.subView.subViewState as WalletRecoveryViewState;

    expect(window.location.pathname).toBe(`/${PathStrings.WalletRecovery}`);
    expect(window.history.state).toEqual({ historyIndex: 0 });
    expect(firstRecoveryState).toBeInstanceOf(WalletRecoveryViewState);
    expect(firstRecoveryState.flowState.kind).toBe("explain");

    await traverseHistory(() => window.history.back());
    expect(window.location.pathname).toBe("/");
    expect(topLevelState.subView.subViewState).toBeUndefined();
    expect(firstRecoveryState.flowState.kind).toBe("cleared");

    await traverseHistory(() => window.history.forward());
    const secondRecoveryState = topLevelState.subView.subViewState as WalletRecoveryViewState;
    expect(window.location.pathname).toBe(`/${PathStrings.WalletRecovery}`);
    expect(secondRecoveryState).toBeInstanceOf(WalletRecoveryViewState);
    expect(secondRecoveryState).not.toBe(firstRecoveryState);
    expect(secondRecoveryState.flowState.kind).toBe("explain");

    topLevelState.restartWalletRecovery(secondRecoveryState);
    const restartedRecoveryState = topLevelState.subView.subViewState as WalletRecoveryViewState;
    expect(secondRecoveryState.flowState.kind).toBe("cleared");
    expect(restartedRecoveryState).not.toBe(secondRecoveryState);
    expect(restartedRecoveryState.flowState.kind).toBe("explain");

    await traverseHistory(() => window.history.back());
    expect(restartedRecoveryState.flowState.kind).toBe("cleared");
    expect(topLevelState.subView.subViewState).toBeUndefined();

    await traverseHistory(() => window.history.forward());
    const forwardRecoveryState = topLevelState.subView.subViewState as WalletRecoveryViewState;
    expect(forwardRecoveryState).toBeInstanceOf(WalletRecoveryViewState);
    expect(forwardRecoveryState).not.toBe(restartedRecoveryState);
    expect(forwardRecoveryState).not.toBe(secondRecoveryState);
    expect(forwardRecoveryState.flowState.kind).toBe("explain");

    topLevelState.exitWalletRecovery(forwardRecoveryState);
    expect(forwardRecoveryState.flowState.kind).toBe("cleared");
    expect(topLevelState.subView.subViewState).toBeUndefined();
    expect(window.location.pathname).toBe("/");
  });
});
