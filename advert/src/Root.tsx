import React from "react";
import { Composition } from "remotion";
import { WhatExamAdvert } from "./WhatExamAdvert";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="WhatExamAdvert"
      component={WhatExamAdvert}
      durationInFrames={780} // 26 seconds at 30fps (voiceover-driven timing)
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
