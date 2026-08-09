import { observer } from "mobx-react";
import React from "react";
import type {WindowTopLevelNavigationState} from "../state/Window";

import LoadDiceKeyImage from "../images/Scanning a DiceKey.svg";
import AssemblyImage1 from "../images/Illustration of shaking bag.svg";
import AssemblyImage2 from "../images/Box Bottom After Roll.svg";
import AssemblyImage3 from "../images/Seal Box.svg";
import { ColumnCentered } from "./basics/Layout";
import styled from "styled-components";
import { DiceKeyView } from "./SVG/DiceKeyView";
import { cssCalcTyped, cssExprWithoutCalc } from "../utilities";
import { facesFromPublicKeyDescriptor } from "../dicekeys/DiceKey";
import { WindowHomeNavigationBar } from "./WindowHomeNavigationBar";
import { BUILD_VERSION, BUILD_DATE, RUNNING_IN_ELECTRON } from "../vite-build-constants";
import {
  DiceKeyMemoryStore,
  PublicDiceKeyDescriptorWithSavedOnDevice,
} from "../state/stores/DiceKeyMemoryStore";
import { PlatformSupportsSavingToDevice  } from "../state/stores/DiceKeyMemoryStore";
import { SubViewButton, SubViewButtonCaption, SubViewButtonImage } from "../css/SubViewButton";
import { ButtonRow, PushButton } from "../css/Button";
import { AnchorButton } from "./basics/AnchorButton";
import { AppStoreInstallNudgeView } from "./AppStoreInstallNudgeView";

const ImageRow = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
`;

const WalletRecoveryAction = styled.button`
  width: min(44rem, calc(100vw - 2rem));
  min-height: 8.5rem;
  margin: 1rem auto 1.5rem;
  padding: 1rem 1.25rem;
  display: grid;
  grid-template-columns: minmax(5rem, 8rem) minmax(0, 1fr);
  gap: 1.25rem;
  align-items: center;
  border: 2px solid #294a91;
  border-left-width: 0.75rem;
  border-radius: 6px;
  background: #f7f5ef;
  color: #171a20;
  font: inherit;
  text-align: left;
  cursor: pointer;
  box-shadow: 0 0.4rem 1.2rem rgba(23, 26, 32, 0.12);
  transition: transform 160ms ease, box-shadow 160ms ease, background 160ms ease;

  &:hover {
    background: #eef2fb;
    box-shadow: 0 0.55rem 1.5rem rgba(23, 26, 32, 0.18);
    transform: translateY(-2px);
  }

  &:focus-visible {
    outline: 3px solid #171a20;
    outline-offset: 3px;
  }

  @media (max-width: 30rem) {
    grid-template-columns: 4.5rem minmax(0, 1fr);
    gap: 0.85rem;
    min-height: 7rem;
    margin-top: 0.5rem;
    padding: 0.85rem;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const WalletRecoveryActionImage = styled.img`
  width: 100%;
  max-height: 6.5rem;
  object-fit: contain;
`;

const WalletRecoveryActionText = styled.span`
  display: grid;
  gap: 0.35rem;
`;

const WalletRecoveryEyebrow = styled.span`
  color: #294a91;
  font-family: Inconsolata, monospace;
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
`;

const WalletRecoveryActionTitle = styled.span`
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  font-size: clamp(1.35rem, 3vw, 2rem);
  font-weight: 700;
  line-height: 1.05;
`;

const WalletRecoveryActionCaption = styled.span`
  color: rgba(23, 26, 32, 0.75);
  font-size: clamp(0.9rem, 1.5vw, 1.05rem);
  line-height: 1.35;
`;

export const HomeActionScrollRegion = styled(ColumnCentered)`
  box-sizing: border-box;
  width: 100%;
  min-height: 0;
  padding: 0.75rem 1rem calc(3rem + env(safe-area-inset-bottom));
  justify-content: flex-start;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable both-edges;

  @media (max-height: 32rem), (max-width: 23.5rem) {
    gap: 0.35rem;
    padding-top: 0.4rem;
  }
`;

const StoredDiceKeysRow = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  max-width: 90vw;
  overflow-x: auto;
`

const VersionInformationBar = styled.div`
  position: absolute;
  z-index: 0;
  left: 0px;
  bottom: 0px;
  /* background color that is equally offset from black or white background */
  background-color: rgba(128,128,128,0.1);
  color: ${ props => props.theme.colors.foregroundDeemphasized};
  padding-bottom: 2px;
  padding-left: 4px;
  padding-top: 4px;
  padding-right: 4px;
  border-top-right-radius: 4px;
  font-size: min(0.8rem,3vh,3vw);
`

interface TopLevelNavigationProps {
  state: WindowTopLevelNavigationState;
}

interface StoredDiceKeyProps extends TopLevelNavigationProps {
  storedDiceKeyDescriptor: PublicDiceKeyDescriptorWithSavedOnDevice;
}

const storedKeySize = `min(${cssExprWithoutCalc(`50vw`)},${cssExprWithoutCalc(`20vh`)})` as const;

// Top put the buttons for saving/deleting/removing DiceKeys
// closer to the DiceKeys themselves, remove some margins
const ButtonRowBelowDiceKeySubViewButton = styled(ButtonRow)`
  margin-top: 0;
`
const DiceKeyActionButton = styled(PushButton)`
  margin-top: 0;
`

const StoredDiceKeyButtonsView = observer ( ({storedDiceKeyDescriptor, state}: StoredDiceKeyProps) => {
  const removeFromMemory = () => { DiceKeyMemoryStore.removeDiceKey(storedDiceKeyDescriptor) };
  if (!PlatformSupportsSavingToDevice) {
    // For platforms that don't support saving DiceKeys to long-term device storage,
    // we can only allow the DiceKey currently in memory to be removed.
    return (
      <><DiceKeyActionButton onClick={removeFromMemory} >remove</DiceKeyActionButton></>
    )
  }
  if (storedDiceKeyDescriptor.savedOnDevice) {
    // As this DiceKey is already saved to the device, we can offer the option to remove it from the device.
    const navigateToDeleteFromDevice = () => { state.navigateToDeleteFromDevice(storedDiceKeyDescriptor) };
    return (
      <><DiceKeyActionButton onClick={navigateToDeleteFromDevice} >delete</DiceKeyActionButton></>
    )
  } else {
    const navigateToSaveToDevice = () => { state.navigateToSaveToDevice(storedDiceKeyDescriptor) };
    return (
      <><DiceKeyActionButton onClick={navigateToSaveToDevice} ><b>save</b></DiceKeyActionButton><DiceKeyActionButton onClick={removeFromMemory} >remove</DiceKeyActionButton></>
    )
  }
});

const StoredDiceKeyViewContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
`;

const StoredDiceKeyView = observer ( (props: StoredDiceKeyProps) => {
  const {storedDiceKeyDescriptor, state} = props;
  return (
    <StoredDiceKeyViewContainer key={storedDiceKeyDescriptor.keyId}>
      <SubViewButton
        onClick={() => state.loadStoredDiceKey(storedDiceKeyDescriptor)}
      >
        <DiceKeyView
          $size={`${cssCalcTyped(storedKeySize)}`}
          faces={ facesFromPublicKeyDescriptor(storedDiceKeyDescriptor) }
          obscureAllButCenterDie={true}
          showLidTab={true}
        />
        <SubViewButtonCaption>{
          `Key ${storedDiceKeyDescriptor.centerLetterAndDigit}`
        }</SubViewButtonCaption>
      </SubViewButton>
      <ButtonRowBelowDiceKeySubViewButton>
        <StoredDiceKeyButtonsView {...props} />
      </ButtonRowBelowDiceKeySubViewButton>
    </StoredDiceKeyViewContainer>
  )
});

const unsaved = PlatformSupportsSavingToDevice ? "unsaved " : "";
const CountdownTimerLine = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  flex-direction: row;
  font-size: calc(min(1.2rem, 2vh, 1.9vw));
  overflow: hidden;
`;

const CountdownTimerView = observer( ({state}: TopLevelNavigationProps) => {
  const numberOfKeysOnlyInMemory = DiceKeyMemoryStore.keysOnlyInMemory.length;
  if (numberOfKeysOnlyInMemory === 0) return null;
  const objectNames = (numberOfKeysOnlyInMemory === 1 ? `The ${unsaved}DiceKey ` : `All ${unsaved}DiceKeys ` );
  if (state.autoEraseDisabled) {
    return (
      <CountdownTimerLine>
        {objectNames} above will remain in memory until removed
        { RUNNING_IN_ELECTRON ?
          (<> or the application is closed.</>) :
          (<>, this tab is refreshed, or this tab is closed.</>)}
        &nbsp;&nbsp;<AnchorButton onClick={state.enableAutoErase}>start auto-erase timer</AnchorButton>
      </CountdownTimerLine>
    )
  }
  return (
    <CountdownTimerLine>
      {objectNames} above will be automatically removed from memory in {state.autoEraseCountdownTimer?.secondsRemaining}s.
      &nbsp;&nbsp;<AnchorButton onClick={state.disableAutoErase}>do not erase automatically</AnchorButton>
    </CountdownTimerLine>
  )
})

const StoredDiceKeysRowAndCountdownTimerContainer = styled.div`
`

export const WindowHomeView = observer ( ({state}: TopLevelNavigationProps) => {
  return (
    <>
      <AppStoreInstallNudgeView/>
      <VersionInformationBar>Release { BUILD_VERSION}, { BUILD_DATE }</VersionInformationBar>
      <WindowHomeNavigationBar state={state} />
      <HomeActionScrollRegion data-layout="home-action-scroll-region">
        {/*
          Row of stored DiceKeys
        */}
        <StoredDiceKeysRowAndCountdownTimerContainer>
          <StoredDiceKeysRow>{
            DiceKeyMemoryStore.keysInMemoryOrSavedToDevice.map( storedDiceKeyDescriptor => (
              <StoredDiceKeyView key={storedDiceKeyDescriptor.keyId} {...{state, storedDiceKeyDescriptor}} />
            ))
          }</StoredDiceKeysRow>
          <CountdownTimerView {...{state}} />
        </StoredDiceKeysRowAndCountdownTimerContainer>
        <WalletRecoveryAction
          type="button"
          onClick={state.navigateToWalletRecovery}
        >
          <WalletRecoveryActionImage
            src={LoadDiceKeyImage}
            alt=""
            aria-hidden="true"
          />
          <WalletRecoveryActionText>
            <WalletRecoveryEyebrow>Offline recovery</WalletRecoveryEyebrow>
            <WalletRecoveryActionTitle>
              Create Bitcoin wallet recovery words
            </WalletRecoveryActionTitle>
            <WalletRecoveryActionCaption>
              Verify the physical DiceKey twice before revealing 24 numbered words.
            </WalletRecoveryActionCaption>
          </WalletRecoveryActionText>
        </WalletRecoveryAction>
        {/* 
          Load DiceKey button
        */}
        <SubViewButton
          onClick={ state.navigateToLoadDiceKey }
        >
          <SubViewButtonImage src={LoadDiceKeyImage} />
          <SubViewButtonCaption>Load DiceKey</SubViewButtonCaption>
        </SubViewButton>
        {/* 
          Assembly instructions button
        */}
        <SubViewButton
          onClick={ state.navigateToAssemblyInstructions }
        >
          <ImageRow>
            <SubViewButtonImage src={AssemblyImage1} />
            <SubViewButtonImage src={AssemblyImage2} />
            <SubViewButtonImage src={AssemblyImage3} />
          </ImageRow>
          <SubViewButtonCaption>Assembly Instructions</SubViewButtonCaption>
        </SubViewButton>
        </HomeActionScrollRegion>
      </>
    )
});
