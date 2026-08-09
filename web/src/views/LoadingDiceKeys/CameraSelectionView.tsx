import { observer } from "mobx-react";
import React from "react";
import { Camera } from "./CamerasOnThisDevice";
import { CenteredControls } from "../../views/basics";
import { MediaStreamState } from "./MediaStreamState";
interface CameraSelectionViewProps {
  cameras: Camera[],
  mediaStreamState: MediaStreamState
}
export const CameraSelectionView = observer ( (props: React.PropsWithoutRef<CameraSelectionViewProps>) => {
  const {cameras, mediaStreamState} = props;
  const {deviceId, defaultDevice} = mediaStreamState;
  if (cameras.length <= 1) return null;

  return (
    <CenteredControls>
      <select value={deviceId ?? defaultDevice?.deviceId} onChange={ (e) => {
        void mediaStreamState.setDeviceId(e.target.value).catch(() => {});
      }} >
        { cameras.map( camera => (
          <option key={camera.deviceId} value={camera.deviceId} >{ camera.name }</option>
        ))}
      </select>
    </CenteredControls>
  )
});
