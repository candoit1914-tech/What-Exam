import React from "react";
import { Composition } from "remotion";
import { WhatExamAdvert } from "./WhatExamAdvert";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="WhatExamAdvert"
      component={WhatExamAdvert}
      durationInFrames={1050} // 35 seconds at 30fps
      fps={30}
      width={3840}
      height={2160}
    />
  );
};
