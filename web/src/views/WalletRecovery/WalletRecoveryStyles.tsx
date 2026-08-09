import styled, { css, keyframes } from "styled-components";

export const RECOVERY_BREAKPOINT_TABLET = "48rem";
export const RECOVERY_BREAKPOINT_DESKTOP = "72rem";

const focusRing = css`
  &:focus-visible {
    outline: 3px solid #fff;
    outline-offset: 2px;
    box-shadow: 0 0 0 6px #000;
  }
`;

export const RecoveryRoot = styled.div`
  --recovery-paper: #f7f5ef;
  --recovery-paper-raised: #fffdf8;
  --recovery-ink: #171a20;
  --recovery-muted: #5b6472;
  --recovery-blue: #5576c5;
  --recovery-blue-deep: #294a91;
  --recovery-blue-soft: #e8eefb;
  --recovery-rule: #c9d2e7;
  --recovery-focus: #f0b429;
  --recovery-warning: #8a4b08;
  --recovery-warning-soft: #fff2cf;
  --recovery-danger: #9f2d25;
  --recovery-danger-soft: #fbe9e7;
  --recovery-success: #17695c;
  --recovery-success-soft: #e3f4ef;
  box-sizing: border-box;
  width: 100%;
  height: 100dvh;
  min-height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  color: var(--recovery-ink);
  background-color: var(--recovery-paper);
  background-image:
    linear-gradient(rgba(85, 118, 197, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(85, 118, 197, 0.045) 1px, transparent 1px);
  background-size: 2.75rem 2.75rem;
  font-family: "Avenir Next", Avenir, "Trebuchet MS", sans-serif;
  line-height: 1.5;
  color-scheme: light;

  *, *::before, *::after {
    box-sizing: border-box;
  }

  @media print {
    display: none;
  }
`;

export const SkipLink = styled.a`
  ${focusRing}
  position: fixed;
  z-index: 1000;
  top: 0.5rem;
  left: 0.5rem;
  padding: 0.65rem 0.9rem;
  color: white;
  background: var(--recovery-blue-deep);
  transform: translateY(-160%);
  transition: transform 140ms ease-out;

  &:focus {
    transform: translateY(0);
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

export const RecoveryHeader = styled.header`
  position: sticky;
  z-index: 20;
  top: 0;
  min-height: 3.5rem;
  color: white;
  background: var(--recovery-blue-deep);
  border-bottom: 4px solid var(--recovery-blue);
`;

export const HeaderInner = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  width: min(100%, 80rem);
  min-height: 3.5rem;
  margin: 0 auto;
  padding: 0.5rem 1rem;
  gap: 0.75rem;

  @media (min-width: ${RECOVERY_BREAKPOINT_TABLET}) {
    min-height: 4rem;
    padding-inline: 2rem;
  }
`;

export const HeaderIdentity = styled.div`
  min-width: 0;
`;

export const HeaderEyebrow = styled.div`
  overflow: hidden;
  color: #dfe7fb;
  font-family: Inconsolata, monospace;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  line-height: 1.1;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
`;

export const HeaderTitle = styled.div`
  overflow: hidden;
  font-size: clamp(1rem, 0.94rem + 0.3vw, 1.25rem);
  font-weight: 700;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const HeaderExitButton = styled.button`
  ${focusRing}
  min-height: 2.75rem;
  padding: 0.55rem 0.8rem;
  color: white;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 0.35rem;
  font: inherit;
  font-size: 0.88rem;
  font-weight: 700;
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, 0.12);
  }
`;

export const MobileProgress = styled.ol`
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
  background: #203f7e;

  @media (min-width: ${RECOVERY_BREAKPOINT_DESKTOP}) {
    display: none;
  }
`;

export const MobileProgressStep = styled.li<{
  $active: boolean;
  $complete: boolean;
}>`
  height: 0.32rem;
  background: ${({ $active, $complete }) =>
    $active ? "var(--recovery-focus)" : $complete ? "#91a9df" : "transparent"};
`;

export const RecoveryLayout = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  width: min(100%, 80rem);
  min-height: calc(100dvh - 3.82rem);
  margin: 0 auto;

  @media (min-width: ${RECOVERY_BREAKPOINT_DESKTOP}) {
    grid-template-columns: 12.5rem minmax(0, 1fr) 16.25rem;
    min-height: calc(100dvh - 4.25rem);
  }
`;

export const CeremonyRail = styled.nav`
  display: none;
  padding: 2.25rem 1.25rem;
  border-right: 1px solid var(--recovery-rule);
  background: rgba(247, 245, 239, 0.88);

  @media (min-width: ${RECOVERY_BREAKPOINT_DESKTOP}) {
    display: block;
  }
`;

export const CeremonyList = styled.ol`
  position: sticky;
  top: 6.5rem;
  display: grid;
  margin: 0;
  padding: 0;
  gap: 1rem;
  list-style: none;
`;

export const CeremonyItem = styled.li<{
  $active: boolean;
  $complete: boolean;
}>`
  display: grid;
  grid-template-columns: 1.65rem minmax(0, 1fr);
  align-items: center;
  gap: 0.65rem;
  color: ${({ $active, $complete }) =>
    $active ? "var(--recovery-ink)" : $complete ? "var(--recovery-blue-deep)" : "var(--recovery-muted)"};
  font-size: 0.88rem;
  font-weight: ${({ $active }) => ($active ? 700 : 500)};

  &::before {
    display: grid;
    place-items: center;
    width: 1.65rem;
    height: 1.65rem;
    content: ${({ $complete }) => ($complete ? "'✓'" : "''")};
    color: ${({ $complete }) => ($complete ? "white" : "transparent")};
    background: ${({ $active, $complete }) =>
      $complete ? "var(--recovery-blue-deep)" : $active ? "var(--recovery-focus)" : "transparent"};
    border: 2px solid ${({ $active, $complete }) =>
      $active || $complete ? "var(--recovery-blue-deep)" : "var(--recovery-rule)"};
    border-radius: 0.28rem;
    font-size: 0.8rem;
  }
`;

export const RecoveryMain = styled.main`
  min-width: 0;
  padding: 1.25rem 1rem 7rem;

  @media (min-width: ${RECOVERY_BREAKPOINT_TABLET}) {
    padding: 2.25rem 2rem 8rem;
  }

  @media (min-width: ${RECOVERY_BREAKPOINT_DESKTOP}) {
    padding: 2.75rem 2.5rem 8rem;
  }
`;

export const SafetyRail = styled.aside`
  display: none;
  padding: 2.25rem 1.25rem;
  border-left: 1px solid var(--recovery-rule);
  background: rgba(255, 253, 248, 0.72);

  @media (min-width: ${RECOVERY_BREAKPOINT_DESKTOP}) {
    display: block;
  }
`;

export const StickyRailContent = styled.div`
  position: sticky;
  top: 6.5rem;
  display: grid;
  gap: 1rem;
`;

export const Panel = styled.section`
  width: 100%;
  max-width: 47rem;
  margin: 0 auto;
  padding: 1.25rem;
  background: var(--recovery-paper-raised);
  border: 1px solid var(--recovery-rule);
  border-top: 4px solid var(--recovery-blue);
  border-radius: 0.4rem;
  box-shadow: 0 1.25rem 3rem rgba(25, 42, 78, 0.08);

  @media (min-width: ${RECOVERY_BREAKPOINT_TABLET}) {
    padding: 2rem;
  }
`;

export const WidePanel = styled(Panel)`
  max-width: 62rem;
`;

export const PanelHeader = styled.header`
  display: grid;
  margin-bottom: 1.5rem;
  gap: 0.45rem;
`;

export const Kicker = styled.div`
  color: var(--recovery-blue-deep);
  font-family: Inconsolata, monospace;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
`;

export const Heading = styled.h1.attrs({ tabIndex: -1 })`
  ${focusRing}
  max-width: 20ch;
  margin: 0;
  font-size: clamp(1.75rem, 1.4rem + 1.4vw, 2.55rem);
  line-height: 1.08;
  letter-spacing: -0.025em;
`;

export const Subheading = styled.h2`
  margin: 0;
  font-size: clamp(1.25rem, 1.1rem + 0.6vw, 1.65rem);
  line-height: 1.2;
`;

export const Lead = styled.p`
  max-width: 62ch;
  margin: 0;
  color: var(--recovery-muted);
  font-size: clamp(1rem, 0.95rem + 0.22vw, 1.12rem);
`;

export const BodyText = styled.p`
  max-width: 66ch;
  margin: 0;
`;

export const Illustration = styled.img`
  display: block;
  width: min(100%, 22rem);
  max-height: 13rem;
  margin: 0 auto 1.5rem;
  object-fit: contain;
`;

export const ConsentList = styled.fieldset`
  display: grid;
  margin: 1.5rem 0 0;
  padding: 0;
  gap: 0.75rem;
  border: 0;

  legend {
    margin-bottom: 0.75rem;
    font-weight: 700;
  }
`;

export const ConsentLabel = styled.label`
  display: grid;
  grid-template-columns: 1.4rem minmax(0, 1fr);
  align-items: start;
  padding: 0.9rem;
  gap: 0.75rem;
  background: white;
  border: 1px solid var(--recovery-rule);
  border-radius: 0.35rem;
  cursor: pointer;

  &:focus-within {
    outline: 3px solid #fff;
    outline-offset: 2px;
    border-color: #000;
    box-shadow: 0 0 0 6px #000;
  }
`;

export const ConsentCheckbox = styled.input`
  width: 1.25rem;
  height: 1.25rem;
  margin: 0.12rem 0 0;
  accent-color: var(--recovery-blue-deep);
`;

export const ActionBar = styled.div`
  position: sticky;
  z-index: 10;
  bottom: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  margin: 1.75rem -1.25rem -1.25rem;
  padding: 0.9rem 1.25rem calc(0.9rem + env(safe-area-inset-bottom));
  gap: 0.65rem;
  background: rgba(255, 253, 248, 0.97);
  border-top: 1px solid var(--recovery-rule);
  backdrop-filter: blur(8px);

  @media (min-width: ${RECOVERY_BREAKPOINT_TABLET}) {
    grid-template-columns: repeat(2, minmax(0, max-content));
    justify-content: end;
    margin: 2rem -2rem -2rem;
    padding-inline: 2rem;
  }
`;

const buttonBase = css`
  ${focusRing}
  min-height: 3rem;
  padding: 0.7rem 1.1rem;
  border-radius: 0.35rem;
  font: inherit;
  font-weight: 700;
  line-height: 1.2;
  cursor: pointer;
  transition: transform 140ms ease-out, background-color 140ms ease-out,
    border-color 140ms ease-out;

  &:active:not(:disabled) {
    transform: translateY(1px);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

export const PrimaryButton = styled.button.attrs((props) => ({
  type: props.type ?? "button",
}))`
  ${buttonBase}
  color: white;
  background: var(--recovery-blue-deep);
  border: 2px solid var(--recovery-blue-deep);

  &:hover:not(:disabled) {
    background: #203d7a;
    border-color: #203d7a;
  }
`;

export const SecondaryButton = styled.button.attrs((props) => ({
  type: props.type ?? "button",
}))`
  ${buttonBase}
  color: var(--recovery-blue-deep);
  background: transparent;
  border: 2px solid var(--recovery-blue-deep);

  &:hover:not(:disabled) {
    background: var(--recovery-blue-soft);
  }
`;

export const QuietButton = styled.button.attrs((props) => ({
  type: props.type ?? "button",
}))`
  ${buttonBase}
  min-height: 2.75rem;
  padding-inline: 0.75rem;
  color: var(--recovery-blue-deep);
  background: transparent;
  border: 1px solid transparent;

  &:hover:not(:disabled) {
    background: var(--recovery-blue-soft);
  }
`;

export const DangerButton = styled.button.attrs((props) => ({
  type: props.type ?? "button",
}))`
  ${buttonBase}
  color: white;
  background: var(--recovery-danger);
  border: 2px solid var(--recovery-danger);

  &:hover:not(:disabled) {
    background: #7f241e;
  }
`;

export const Callout = styled.div<{
  $tone?: "info" | "warning" | "danger" | "success";
}>`
  padding: 0.9rem 1rem;
  color: ${({ $tone }) =>
    $tone === "danger" ? "var(--recovery-danger)" :
    $tone === "warning" ? "var(--recovery-warning)" :
    $tone === "success" ? "var(--recovery-success)" :
    "var(--recovery-ink)"};
  background: ${({ $tone }) =>
    $tone === "danger" ? "var(--recovery-danger-soft)" :
    $tone === "warning" ? "var(--recovery-warning-soft)" :
    $tone === "success" ? "var(--recovery-success-soft)" :
    "var(--recovery-blue-soft)"};
  border-left: 4px solid ${({ $tone }) =>
    $tone === "danger" ? "var(--recovery-danger)" :
    $tone === "warning" ? "var(--recovery-warning)" :
    $tone === "success" ? "var(--recovery-success)" :
    "var(--recovery-blue-deep)"};
  border-radius: 0.2rem;
`;

export const Stack = styled.div<{ $gap?: string }>`
  display: grid;
  gap: ${({ $gap }) => $gap ?? "1rem"};
`;

export const Split = styled.div`
  display: grid;
  gap: 1.25rem;

  @media (min-width: ${RECOVERY_BREAKPOINT_TABLET}) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
`;

export const MetadataCard = styled.div`
  display: grid;
  padding: 0.9rem;
  gap: 0.35rem;
  background: var(--recovery-blue-soft);
  border: 1px solid #b9c8ea;
  border-radius: 0.35rem;
`;

export const MetadataLabel = styled.div`
  color: var(--recovery-muted);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
`;

export const MetadataValue = styled.div`
  overflow-wrap: anywhere;
  color: var(--recovery-blue-deep);
  font-family: Inconsolata, monospace;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.04em;
`;

export const InlineRecoveryMetadata = styled.div`
  @media (min-width: ${RECOVERY_BREAKPOINT_DESKTOP}) {
    display: none;
  }
`;

export const ScannerStage = styled.div`
  display: grid;
  width: min(100%, 38.75rem);
  margin: 0 auto;
  gap: 0.75rem;
`;

export const ScannerFrame = styled.div`
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  background: #111827;
  border: 4px solid var(--recovery-blue-deep);
  border-radius: 0.4rem;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.3);
`;

export const ScanStatus = styled.div`
  display: flex;
  align-items: center;
  min-height: 2.6rem;
  padding: 0.6rem 0.75rem;
  gap: 0.55rem;
  color: var(--recovery-blue-deep);
  background: var(--recovery-blue-soft);
  border-radius: 0.3rem;
  font-weight: 700;

  &::before {
    width: 0.72rem;
    height: 0.72rem;
    content: "";
    background: var(--recovery-blue);
    border-radius: 50%;
    box-shadow: 0 0 0 0.3rem rgba(85, 118, 197, 0.16);
  }
`;

const sweep = keyframes`
  from { transform: translateX(-100%); }
  to { transform: translateX(280%); }
`;

export const IndeterminateRule = styled.div`
  position: relative;
  height: 0.35rem;
  overflow: hidden;
  background: var(--recovery-rule);
  border-radius: 1rem;

  &::after {
    position: absolute;
    inset-block: 0;
    width: 38%;
    content: "";
    background: var(--recovery-blue-deep);
    animation: ${sweep} 1.25s ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    &::after {
      width: 65%;
      animation: none;
    }
  }
`;

export const FaceReviewLayout = styled.div`
  display: grid;
  align-items: start;
  gap: 1.25rem;

  @media (min-width: ${RECOVERY_BREAKPOINT_TABLET}) {
    grid-template-columns: minmax(17rem, 1fr) minmax(15rem, 0.72fr);
  }
`;

export const DiceKeyFrame = styled.div`
  width: min(100%, 26rem);
  margin: 0 auto;
  padding: 0.6rem;
  background: #eff3fb;
  border: 1px solid var(--recovery-rule);
  border-radius: 0.4rem;
`;

export const FacePositionGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0.35rem;
`;

export const FacePositionButton = styled.button<{
  $active?: boolean;
  $reviewed?: boolean;
}>`
  ${focusRing}
  position: relative;
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  padding: 0.15rem;
  color: var(--recovery-ink);
  background: ${({ $active, $reviewed }) =>
    $active ? "var(--recovery-warning-soft)" :
    $reviewed ? "var(--recovery-success-soft)" : "white"};
  border: 2px solid ${({ $active, $reviewed }) =>
    $active ? "var(--recovery-warning)" :
    $reviewed ? "var(--recovery-success)" : "var(--recovery-rule)"};
  border-radius: 0.28rem;
  font: inherit;
  cursor: pointer;

  &::after {
    position: absolute;
    right: 0.18rem;
    bottom: 0.08rem;
    color: var(--recovery-muted);
    content: attr(data-position);
    font-family: Inconsolata, monospace;
    font-size: 0.58rem;
    font-weight: 700;
  }
`;

export const FaceEditor = styled.form`
  display: grid;
  padding: 1rem;
  gap: 0.9rem;
  background: white;
  border: 1px solid var(--recovery-rule);
  border-radius: 0.4rem;
`;

export const FieldGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.65rem;
`;

export const FieldLabel = styled.label`
  display: grid;
  gap: 0.28rem;
  color: var(--recovery-muted);
  font-size: 0.78rem;
  font-weight: 700;
`;

export const Select = styled.select`
  ${focusRing}
  width: 100%;
  min-height: 2.75rem;
  padding: 0.45rem;
  color: var(--recovery-ink);
  background: var(--recovery-paper-raised);
  border: 1px solid #8b96aa;
  border-radius: 0.3rem;
  font: inherit;
  font-family: Inconsolata, monospace;
  font-weight: 700;
`;

export const CompareGrid = styled.div`
  display: grid;
  gap: 1rem;

  @media (min-width: ${RECOVERY_BREAKPOINT_TABLET}) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
`;

export const DifferenceList = styled.ol`
  display: grid;
  max-height: 18rem;
  margin: 0;
  padding: 0;
  gap: 0.5rem;
  overflow: auto;
  list-style: none;
`;

export const DifferenceItem = styled.li`
  display: grid;
  grid-template-columns: 2.2rem minmax(0, 1fr);
  align-items: start;
  padding: 0.7rem;
  gap: 0.65rem;
  background: var(--recovery-danger-soft);
  border-left: 3px solid var(--recovery-danger);
`;

export const DifferenceNumber = styled.span`
  display: grid;
  place-items: center;
  min-height: 2rem;
  color: white;
  background: var(--recovery-danger);
  border-radius: 0.25rem;
  font-family: Inconsolata, monospace;
  font-weight: 700;
`;

export const SealedMaterial = styled.div`
  position: relative;
  display: grid;
  min-height: 15rem;
  place-items: center;
  padding: 2rem;
  overflow: hidden;
  text-align: center;
  background: var(--recovery-blue-soft);
  border: 2px solid var(--recovery-blue-deep);
  border-radius: 0.4rem;

  &::before,
  &::after {
    position: absolute;
    width: 16rem;
    height: 16rem;
    content: "";
    border: 1px solid rgba(41, 74, 145, 0.22);
    transform: rotate(45deg);
  }

  &::before { top: -10rem; left: -8rem; }
  &::after { right: -8rem; bottom: -10rem; }
`;

export const WordGrid = styled.ol`
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  margin: 0;
  padding: 0;
  gap: 0.45rem;
  list-style: none;

  @media (min-width: 30rem) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  @media (min-width: ${RECOVERY_BREAKPOINT_TABLET}) {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
`;

export const WordCell = styled.li`
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr);
  min-height: 3rem;
  align-items: center;
  background: white;
  border: 1px solid var(--recovery-rule);
  border-radius: 0.28rem;
`;

export const WordNumber = styled.span`
  display: grid;
  align-self: stretch;
  place-items: center;
  color: var(--recovery-blue-deep);
  background: var(--recovery-blue-soft);
  border-right: 1px solid var(--recovery-rule);
  font-family: Inconsolata, monospace;
  font-size: 0.78rem;
  font-weight: 700;
`;

export const WordText = styled.span`
  min-width: 0;
  padding: 0.45rem 0.55rem;
  font-size: clamp(0.95rem, 0.86rem + 0.3vw, 1.12rem);
  font-weight: 700;
  letter-spacing: 0.01em;
  overflow-wrap: anywhere;
  white-space: normal;
`;

export const ChoiceButton = styled.button`
  ${focusRing}
  display: grid;
  min-height: 9rem;
  align-content: start;
  padding: 1rem;
  gap: 0.45rem;
  color: var(--recovery-ink);
  text-align: left;
  background: white;
  border: 2px solid var(--recovery-rule);
  border-radius: 0.4rem;
  font: inherit;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: var(--recovery-blue-deep);
    background: var(--recovery-blue-soft);
  }

  &:disabled {
    color: var(--recovery-muted);
    background: #eef0f3;
    border-color: #b8c0cd;
    cursor: not-allowed;
    opacity: 0.72;
  }
`;

export const ChoiceTitle = styled.strong`
  color: var(--recovery-blue-deep);
  font-size: 1.1rem;
`;

export const EntryGrid = styled.div<{ $compact?: boolean }>`
  display: grid;
  grid-template-columns: ${({ $compact }) => $compact ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)"};
  gap: 0.6rem;

  @media (min-width: ${RECOVERY_BREAKPOINT_TABLET}) {
    grid-template-columns: ${({ $compact }) => $compact ? "repeat(3, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))"};
  }
`;

export const WordInputLabel = styled.label`
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr);
  min-width: 0;
  align-items: center;
  overflow: hidden;
  background: white;
  border: 1px solid var(--recovery-rule);
  border-radius: 0.28rem;
  color: var(--recovery-blue-deep);
  font-family: Inconsolata, monospace;
  font-size: 0.78rem;
  font-weight: 700;

  &:focus-within {
    outline: 3px solid #fff;
    outline-offset: 2px;
    box-shadow: 0 0 0 6px #000;
  }
`;

export const WordInput = styled.input`
  ${focusRing}
  width: 100%;
  min-height: 3rem;
  min-width: 0;
  padding: 0.55rem;
  color: var(--recovery-ink);
  background: var(--recovery-paper-raised);
  border: 0;
  border-left: 1px solid var(--recovery-rule);
  border-radius: 0;
  font: inherit;
  font-size: 1rem;

  &::placeholder {
    color: #5b6472;
  }
`;

export const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
`;

export const StatusMark = styled.div<{ $tone: "success" | "danger" }>`
  display: grid;
  width: 4.5rem;
  height: 4.5rem;
  margin: 0 auto;
  place-items: center;
  color: white;
  background: ${({ $tone }) =>
    $tone === "success" ? "var(--recovery-success)" : "var(--recovery-danger)"};
  border-radius: 0.4rem;
  font-family: Inconsolata, monospace;
  font-size: 2.25rem;
  font-weight: 700;
`;
