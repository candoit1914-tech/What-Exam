import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
  AbsoluteFill,
  Audio,
  staticFile,
  Easing,
} from "remotion";

/* ═══════════════════════════════════════════════════════════════
   DESIGN TOKENS — Cinematic dark palette with teal accents
   ═══════════════════════════════════════════════════════════════ */
const T = {
  bg: "#060B18",
  bgGrad2: "#0D1525",
  teal: "#00D4AA",
  tealDark: "#00A884",
  tealGlow: "rgba(0,212,170,0.35)",
  green: "#22C55E",
  white: "#FFFFFF",
  textPrimary: "#F1F5F9",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",
  chatBg: "#141E2E",
  chatHeader: "rgba(20,30,46,0.97)",
  chatOut: "#005C4B",
  chatIn: "#1C2840",
  chatText: "#E2E8F0",
  chatStamp: "rgba(148,163,184,0.55)",
  chatTick: "#00D4AA",
  font: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

/* ═══════════════════════════════════════════════════════════════
   3D ENVIRONMENT — Parallax depth layers
   ═══════════════════════════════════════════════════════════════ */
function DepthEnvironment({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const driftX = Math.sin(frame * 0.005) * 20;
  const driftY = Math.cos(frame * 0.004) * 15;

  return (
    <AbsoluteFill style={{ perspective: 2400, transformStyle: "preserve-3d" }}>
      {/* Layer 0: Deep background gradient */}
      <div
        style={{
          position: "absolute",
          inset: -200,
          background: `radial-gradient(ellipse 150% 100% at 50% 40%, #0F1A2E 0%, ${T.bg} 65%)`,
          transform: `translateZ(-400px) scale(1.5)`,
        }}
      />

      {/* Layer 1: Animated nebula orbs */}
      <div
        style={{
          position: "absolute",
          inset: -100,
          transform: `translateZ(-200px) translate(${driftX}px, ${driftY}px) scale(1.25)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 900,
            height: 900,
            left: "20%",
            top: "15%",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(0,212,170,0.07) 0%, transparent 65%)",
            filter: "blur(100px)",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: 700,
            height: 700,
            right: "15%",
            bottom: "20%",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(34,197,94,0.05) 0%, transparent 65%)",
            filter: "blur(100px)",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: 500,
            height: 500,
            left: "55%",
            top: "45%",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(0,180,220,0.04) 0%, transparent 65%)",
            filter: "blur(80px)",
          }}
        />
      </div>

      {/* Layer 2: Grid with perspective tilt */}
      <div
        style={{
          position: "absolute",
          inset: -50,
          transform: `translateZ(-100px) rotateX(15deg) scale(1.12)`,
          transformOrigin: "center bottom",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(rgba(0,212,170,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,170,0.03) 1px, transparent 1px)",
            backgroundSize: "80px 80px",
            maskImage: "linear-gradient(to top, rgba(0,0,0,0.4) 0%, transparent 60%)",
            WebkitMaskImage: "linear-gradient(to top, rgba(0,0,0,0.4) 0%, transparent 60%)",
          }}
        />
      </div>

      {/* Layer 3: Content plane */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          transformStyle: "preserve-3d",
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
}

/* ═══════════════════════════════════════════════════════════════
   VOLUMETRIC LIGHT RAYS
   ═══════════════════════════════════════════════════════════════ */
function LightRays({ intensity = 0.12 }: { intensity?: number }) {
  const frame = useCurrentFrame();
  const rotate = frame * 0.15;

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "-20%",
        width: 2000,
        height: 2000,
        marginLeft: -1000,
        opacity: intensity,
        transform: `rotate(${rotate}deg)`,
        pointerEvents: "none",
      }}
    >
      {Array.from({ length: 8 }, (_, i) => {
        const angle = (i / 8) * 360;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 3,
              height: 900,
              marginLeft: -1.5,
              background: `linear-gradient(to bottom, rgba(0,212,170,0.4), transparent)`,
              transformOrigin: "top center",
              transform: `rotate(${angle}deg)`,
              filter: "blur(8px)",
            }}
          />
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DEEP PARTICLES — Multi-layer bokeh with depth of field
   ═══════════════════════════════════════════════════════════════ */
function DeepParticles({ count = 16 }: { count?: number }) {
  const frame = useCurrentFrame();
  const dots = React.useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        x: (i * 137.5 + 30) % 100,
        y: (i * 97.3 + 20) % 100,
        z: -300 + (i % 5) * 150,
        size: 3 + (i % 6) * 2.5,
        speed: 0.15 + (i % 4) * 0.08,
        phase: (i * 2.1) % (Math.PI * 2),
        hue: 155 + (i % 4) * 15,
      })),
    [count]
  );

  return (
    <>
      {dots.map((d, i) => {
        const y = Math.sin(frame * d.speed * 0.03 + d.phase) * 30;
        const x = Math.cos(frame * d.speed * 0.025 + d.phase) * 18;
        const depthScale = 1 + (d.z + 300) / 600;
        const blur = 2 + Math.abs(d.z + 150) / 200;
        const opacity = 0.15 + (d.z + 300) / 800;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${d.x}%`,
              top: `${d.y}%`,
              width: d.size * depthScale,
              height: d.size * depthScale,
              borderRadius: "50%",
              background: `hsla(${d.hue}, 75%, 60%, ${opacity})`,
              transform: `translate(${x}px, ${y}px) translateZ(${d.z}px)`,
              filter: `blur(${blur}px)`,
              boxShadow: `0 0 ${d.size * 4}px hsla(${d.hue}, 75%, 60%, ${opacity * 0.6})`,
            }}
          />
        );
      })}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PREMIUM HOLLYWOOD WATERDROP TRANSITION
   Full cinematic: chromatic aberration, bokeh burst, lens flare,
   volumetric glow, and reveal mask with light sweep.
   ═══════════════════════════════════════════════════════════════ */
function WaterdropHollywood({ progress }: { progress: number }) {
  const p = Math.min(progress, 1);

  // Main circle expansion with cinematic easing
  const radius = interpolate(p, [0, 0.3, 0.7, 1], [0, 600, 1800, 3500], {
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.25, 0.46, 0.45, 0.94),
  });

  const overlayOpacity = interpolate(p, [0, 0.12, 0.88, 1], [0, 1, 1, 0], {
    extrapolateRight: "clamp",
  });

  // Chromatic ring with animated rotation
  const chromaticSize = radius * 2 + 60;
  const chromaticRotate = p * 180;

  // Bokeh burst — particles fly outward from center
  const bokehProgress = interpolate(p, [0.08, 0.5, 0.92], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Horizontal lens flare — anamorphic streak
  const flareWidth = interpolate(p, [0.15, 0.45, 0.75], [0, 1200, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const flareOpacity = interpolate(p, [0.15, 0.35, 0.55, 0.75], [0, 0.8, 0.8, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Vertical light sweep
  const sweepY = interpolate(p, [0.1, 0.9], [-200, 4200], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const sweepOpacity = interpolate(p, [0.1, 0.3, 0.7, 0.9], [0, 0.5, 0.5, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Center energy burst
  const burstScale = interpolate(p, [0.2, 0.5, 0.8], [0, 1.5, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 100 }}>
      {/* Dark radial overlay */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle ${radius}px at 50% 50%, transparent 0%, rgba(4,8,20,0.97) 60%, rgba(4,8,20,1) 100%)`,
          opacity: overlayOpacity,
        }}
      />

      {/* Chromatic aberration ring */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: chromaticSize,
          height: chromaticSize,
          marginLeft: -chromaticSize / 2,
          marginTop: -chromaticSize / 2,
          borderRadius: "50%",
          background: `conic-gradient(from ${chromaticRotate}deg, rgba(255,40,40,0.25), rgba(40,255,40,0.25), rgba(40,40,255,0.25), rgba(255,40,40,0.25))`,
          mask: "radial-gradient(circle, transparent 60%, black 62%, black 68%, transparent 70%)",
          WebkitMask: "radial-gradient(circle, transparent 60%, black 62%, black 68%, transparent 70%)",
          opacity: interpolate(p, [0.08, 0.35, 0.65, 0.92], [0, 0.7, 0.7, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          filter: "blur(3px)",
        }}
      />

      {/* Bokeh burst particles */}
      {bokehProgress > 0 && (
        <div style={{ position: "absolute", inset: 0, opacity: bokehProgress }}>
          {Array.from({ length: 24 }, (_, i) => {
            const angle = (i / 24) * Math.PI * 2;
            const dist = 120 + (i % 5) * 100 + bokehProgress * 350;
            const bx = 1080 + Math.cos(angle + p * 3) * dist;
            const by = 1920 + Math.sin(angle + p * 3) * dist;
            const size = 5 + (i % 6) * 4;
            const hue = 155 + (i % 5) * 20;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: bx,
                  top: by,
                  width: size,
                  height: size,
                  borderRadius: "50%",
                  background: `hsla(${hue}, 70%, 65%, 0.55)`,
                  filter: `blur(${2 + (i % 4)}px)`,
                  boxShadow: `0 0 ${size * 5}px hsla(${hue}, 70%, 65%, 0.35)`,
                }}
              />
            );
          })}
        </div>
      )}

      {/* Anamorphic lens flare */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: flareWidth,
          height: 4,
          marginLeft: -flareWidth / 2,
          marginTop: -2,
          background:
            "linear-gradient(90deg, transparent 0%, rgba(0,212,170,0.6) 20%, rgba(255,255,255,0.95) 50%, rgba(0,212,170,0.6) 80%, transparent 100%)",
          opacity: flareOpacity,
          filter: "blur(1px)",
        }}
      />

      {/* Vertical light sweep */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: sweepY,
          height: 120,
          background:
            "linear-gradient(to bottom, transparent, rgba(0,212,170,0.15), rgba(255,255,255,0.08), rgba(0,212,170,0.15), transparent)",
          opacity: sweepOpacity,
          filter: "blur(20px)",
        }}
      />

      {/* Center energy burst */}
      {burstScale > 0 && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 200,
            height: 200,
            marginLeft: -100,
            marginTop: -100,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(0,212,170,0.5) 0%, transparent 70%)",
            transform: `scale(${burstScale})`,
            opacity: 1 - burstScale * 0.6,
            filter: "blur(15px)",
          }}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   3D GLASS MORPHISM CARD
   ═══════════════════════════════════════════════════════════════ */
function GlassCard3D({
  children,
  rotateIntensity = 1,
}: {
  children: React.ReactNode;
  rotateIntensity?: number;
}) {
  const frame = useCurrentFrame();
  const floatY = Math.sin(frame * 0.02) * 6 * rotateIntensity;
  const rotateX = Math.sin(frame * 0.015) * 1.2 * rotateIntensity;
  const rotateY = Math.cos(frame * 0.018) * 1.5 * rotateIntensity;

  return (
    <div style={{ perspective: 1800, transformStyle: "preserve-3d" }}>
      <div
        style={{
          position: "relative",
          borderRadius: 32,
          overflow: "hidden",
          background: "rgba(255,255,255,0.04)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255,255,255,0.07)",
          boxShadow:
            "0 40px 100px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05), inset 0 1px 0 rgba(255,255,255,0.1), inset 0 -1px 0 rgba(0,0,0,0.2)",
          transform: `translateY(${floatY}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateZ(30px)`,
          transformStyle: "preserve-3d",
        }}
      >
        {/* Top specular highlight */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background:
              "linear-gradient(90deg, transparent 10%, rgba(255,255,255,0.2) 50%, transparent 90%)",
          }}
        />
        {/* Side edge light */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            bottom: 0,
            width: 1,
            background:
              "linear-gradient(to bottom, rgba(255,255,255,0.12) 20%, transparent 80%)",
          }}
        />
        {children}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   WHATSAPP CHAT — Premium dark mode
   ═══════════════════════════════════════════════════════════════ */
function ChatHeader() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "18px 20px",
        background: T.chatHeader,
        borderBottom: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: `linear-gradient(135deg, ${T.teal}, ${T.tealDark})`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: `0 0 28px ${T.tealGlow}`,
        }}
      >
        <img src={staticFile("icon.svg")} width={34} height={34} style={{ borderRadius: "50%" }} alt="" />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: T.textPrimary, fontFamily: T.font }}>Exam Bot</div>
        <div style={{ fontSize: 14, color: T.teal, fontFamily: T.font }}>online</div>
      </div>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={T.textMuted} strokeWidth="1.5">
        <circle cx="12" cy="12" r="1.5" />
        <circle cx="19" cy="12" r="1.5" />
        <circle cx="5" cy="12" r="1.5" />
      </svg>
    </div>
  );
}

function ChatBubble({
  side,
  children,
  time,
  delay = 0,
  ticks,
}: {
  side: "in" | "out";
  children: React.ReactNode;
  time: string;
  delay?: number;
  ticks?: boolean;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = side === "out";
  const p = spring({ frame: frame - delay, fps, config: { damping: 14, mass: 0.55 } });
  const opacity = interpolate(p, [0, 1], [0, 1]);
  const y = interpolate(p, [0, 1], [35, 0]);
  const scale = interpolate(p, [0, 1], [0.88, 1]);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: out ? "flex-end" : "flex-start",
        opacity,
        transform: `translateY(${y}px) scale(${scale})`,
      }}
    >
      <div
        style={{
          position: "relative",
          maxWidth: "84%",
          padding: "12px 16px 8px",
          borderRadius: 22,
          borderBottomRightRadius: out ? 8 : 22,
          borderBottomLeftRadius: out ? 22 : 8,
          background: out ? T.chatOut : T.chatIn,
          color: T.chatText,
          fontSize: 17,
          lineHeight: 1.55,
          fontFamily: T.font,
          boxShadow: "0 3px 16px rgba(0,0,0,0.3)",
          border: `1px solid ${out ? "rgba(0,92,75,0.25)" : "rgba(255,255,255,0.05)"}`,
        }}
      >
        {children}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 5, marginTop: 5 }}>
          <span style={{ fontSize: 12, color: T.chatStamp }}>{time}</span>
          {ticks && (
            <svg width="18" height="12" viewBox="0 0 18 12">
              <path d="M1 6l3.5 3.5L11 3" stroke={T.chatTick} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6 6l3.5 3.5L16 3" stroke={T.chatTick} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}

function ChipLabel({ children, color = T.teal }: { children: React.ReactNode; color?: string }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color,
        marginBottom: 5,
      }}
    >
      {children}
    </div>
  );
}

function DatePill({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", margin: "6px 0 10px" }}>
      <div
        style={{
          padding: "6px 18px",
          borderRadius: 12,
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.04)",
          fontSize: 13,
          fontWeight: 500,
          color: T.textMuted,
          fontFamily: T.font,
        }}
      >
        {text}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PREMIUM ANIMATION HOOKS
   ═══════════════════════════════════════════════════════════════ */
function useReveal(delay: number) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 13, mass: 0.65 } });
  return {
    opacity: interpolate(p, [0, 1], [0, 1]),
    transform: `translateY(${interpolate(p, [0, 1], [50, 0])}px) translateZ(${interpolate(p, [0, 1], [-80, 0])}px)`,
  };
}

function useScaleReveal(delay: number) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 11, mass: 0.5 } });
  return {
    opacity: interpolate(p, [0, 1], [0, 1]),
    transform: `scale(${interpolate(p, [0, 1], [0.6, 1])}) translateZ(${interpolate(p, [0, 1], [-120, 0])}px)`,
  };
}

function useSlideIn(delay: number, from: "left" | "right" | "bottom" = "bottom") {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 14, mass: 0.6 } });
  const x = from === "left" ? -400 : from === "right" ? 400 : 0;
  const y = from === "bottom" ? 80 : 0;
  return {
    opacity: interpolate(p, [0, 1], [0, 1]),
    transform: `translate(${interpolate(p, [0, 1], [x, 0])}px, ${interpolate(p, [0, 1], [y, 0])}px) translateZ(${interpolate(p, [0, 1], [-60, 0])}px)`,
  };
}

/* ═══════════════════════════════════════════════════════════════
   SCENE 1: INTRO — Cinematic brand reveal
   Duration: 150 frames (5s)
   ═══════════════════════════════════════════════════════════════ */
const SceneIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const iconP = spring({ frame: frame - 15, fps, config: { damping: 9, mass: 0.5 } });
  const iconScale = interpolate(iconP, [0, 1], [0.15, 1]);
  const iconOpacity = interpolate(iconP, [0, 1], [0, 1]);
  const iconRotateY = interpolate(iconP, [0, 1], [40, 0]);
  const iconZ = interpolate(iconP, [0, 1], [-300, 0]);

  const title = useReveal(30);
  const subtitle = useReveal(45);
  const tagline = useReveal(60);

  const glow = 0.2 + Math.sin(frame * 0.06) * 0.15;

  const drop = interpolate(frame, [120, 150], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <DepthEnvironment>
        <LightRays intensity={0.08 + Math.sin(frame * 0.04) * 0.04} />
        <DeepParticles count={20} />

        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            transformStyle: "preserve-3d",
          }}
        >
          {/* Icon with volumetric glow */}
          <div
            style={{
              opacity: iconOpacity,
              transform: `scale(${iconScale}) rotateY(${iconRotateY}deg) translateZ(${iconZ}px)`,
              marginBottom: 40,
              transformStyle: "preserve-3d",
            }}
          >
            <div
              style={{
                position: "relative",
                filter: `drop-shadow(0 0 ${60 + glow * 80}px rgba(0,212,170,${glow}))`,
              }}
            >
              {/* Glow ring behind icon */}
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: 260,
                  height: 260,
                  marginLeft: -130,
                  marginTop: -130,
                  borderRadius: "50%",
                  border: `2px solid rgba(0,212,170,${0.1 + glow * 0.1})`,
                  boxShadow: `0 0 40px rgba(0,212,170,${glow * 0.3}), inset 0 0 40px rgba(0,212,170,${glow * 0.1})`,
                }}
              />
              <img
                src={staticFile("icon.svg")}
                width={160}
                height={160}
                style={{
                  borderRadius: 44,
                  objectFit: "cover",
                  border: `2px solid rgba(0,212,170,0.2)`,
                  position: "relative",
                }}
                alt=""
              />
            </div>
          </div>

          {/* Title */}
          <div
            style={{
              ...title,
              fontSize: 86,
              fontWeight: 700,
              letterSpacing: "-0.04em",
              color: T.textPrimary,
              textAlign: "center",
              fontFamily: T.font,
              lineHeight: 1.05,
              textShadow: "0 4px 30px rgba(0,0,0,0.4)",
            }}
          >
            Exam Bot
          </div>

          {/* Subtitle */}
          <div
            style={{
              ...subtitle,
              fontSize: 24,
              fontWeight: 500,
              letterSpacing: "0.3em",
              textTransform: "uppercase",
              color: T.teal,
              marginTop: 20,
              fontFamily: T.font,
            }}
          >
            Start Examining — For Free
          </div>

          {/* Decorative line */}
          <div
            style={{
              ...tagline,
              width: 120,
              height: 2,
              background: `linear-gradient(90deg, transparent, ${T.teal}, transparent)`,
              marginTop: 30,
              borderRadius: 1,
            }}
          />
        </div>
      </DepthEnvironment>

      <WaterdropHollywood progress={drop} />
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 2: TAGLINE — Hero headline + 3D floating card
   Duration: 165 frames (5.5s)
   ═══════════════════════════════════════════════════════════════ */
const SceneTagline: React.FC = () => {
  const frame = useCurrentFrame();

  const headline = useReveal(8);
  const card = useScaleReveal(18);
  const sub = useReveal(35);

  const drop = interpolate(frame, [135, 165], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <DepthEnvironment>
        <LightRays intensity={0.06} />
        <DeepParticles count={14} />

        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 36,
            padding: "0 60px",
            transformStyle: "preserve-3d",
          }}
        >
          {/* Headline */}
          <div
            style={{
              ...headline,
              fontSize: 62,
              fontWeight: 700,
              letterSpacing: "-0.03em",
              color: T.textPrimary,
              textAlign: "center",
              fontFamily: T.font,
              lineHeight: 1.15,
              textShadow: "0 3px 25px rgba(0,0,0,0.35)",
            }}
          >
            Exams that
            <br />
            <span style={{ color: T.teal }}>mark themselves.</span>
          </div>

          {/* Chat card */}
          <div style={{ ...card, width: "100%", maxWidth: 560 }}>
            <GlassCard3D>
              <ChatHeader />
              <div style={{ padding: "16px 18px 22px", display: "flex", flexDirection: "column", gap: 10 }}>
                <DatePill text="TODAY" />
                <ChatBubble side="in" time="09:00" delay={25}>
                  Good morning! Your exam starts in 10 minutes.
                </ChatBubble>
                <ChatBubble side="out" time="09:01" delay={55}>
                  Ready when you are.
                </ChatBubble>
              </div>
            </GlassCard3D>
          </div>

          {/* Subtext */}
          <div
            style={{
              ...sub,
              fontSize: 20,
              fontWeight: 500,
              color: T.textSecondary,
              textAlign: "center",
              fontFamily: T.font,
            }}
          >
            Your bot delivers them — AI does the rest.
          </div>
        </div>
      </DepthEnvironment>

      <WaterdropHollywood progress={drop} />
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 3: QUESTION FLOW — Chat with options
   Duration: 180 frames (6s)
   ═══════════════════════════════════════════════════════════════ */
const SceneChat: React.FC = () => {
  const frame = useCurrentFrame();
  const card = useScaleReveal(5);

  const drop = interpolate(frame, [150, 180], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <DepthEnvironment>
        <LightRays intensity={0.05} />
        <DeepParticles count={12} />

        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 50px",
            transformStyle: "preserve-3d",
          }}
        >
          <div style={{ ...card, width: "100%", maxWidth: 580 }}>
            <GlassCard3D>
              <ChatHeader />
              <div style={{ padding: "16px 18px 22px", display: "flex", flexDirection: "column", gap: 10 }}>
                <DatePill text="TODAY" />
                <ChatBubble side="out" time="09:42" delay={10}>
                  <ChipLabel>QUESTION 1 · OBJECTIVE</ChipLabel>
                  What is the capital of Ghana?
                </ChatBubble>
                <ChatBubble side="out" time="09:42" delay={40}>
                  <ChipLabel>ANSWER OPTIONS</ChipLabel>
                  <div
                    style={{
                      borderLeft: `3px solid ${T.tealDark}`,
                      background: "rgba(0,0,0,0.25)",
                      borderRadius: 10,
                      padding: "10px 14px",
                      fontSize: 16,
                      lineHeight: 1.7,
                      whiteSpace: "pre-line",
                    }}
                  >
                    {"A. Accra\nB. Kumasi\nC. Cape Coast\nD. Tamale"}
                  </div>
                </ChatBubble>
                <ChatBubble side="in" time="09:43" delay={70}>
                  A
                </ChatBubble>
                <ChatBubble side="out" time="09:43" ticks delay={95}>
                  <ChipLabel color={T.green}>AI MARKING</ChipLabel>
                  ✓ Correct — +1 mark
                </ChatBubble>
              </div>
            </GlassCard3D>
          </div>
        </div>
      </DepthEnvironment>

      <WaterdropHollywood progress={drop} />
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 4: PHOTO ANSWER — Image submission
   Duration: 165 frames (5.5s)
   ═══════════════════════════════════════════════════════════════ */
const ScenePhotoAnswer: React.FC = () => {
  const frame = useCurrentFrame();
  const card = useScaleReveal(5);

  const drop = interpolate(frame, [135, 165], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <DepthEnvironment>
        <LightRays intensity={0.04} />
        <DeepParticles count={10} />

        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 50px",
            transformStyle: "preserve-3d",
          }}
        >
          <div style={{ ...card, width: "100%", maxWidth: 580 }}>
            <GlassCard3D>
              <ChatHeader />
              <div style={{ padding: "16px 18px 22px", display: "flex", flexDirection: "column", gap: 10 }}>
                <DatePill text="TODAY" />
                <ChatBubble side="out" time="09:44" delay={10}>
                  <ChipLabel>ANSWER · PHOTO</ChipLabel>
                  <div
                    style={{
                      position: "relative",
                      width: 340,
                      height: 220,
                      borderRadius: 14,
                      background: "linear-gradient(135deg, rgba(0,212,170,0.15), rgba(0,168,132,0.08))",
                      border: "1px solid rgba(0,212,170,0.2)",
                      display: "flex",
                      alignItems: "flex-end",
                      justifyContent: "center",
                      padding: "14px 16px",
                      marginBottom: 4,
                      overflow: "hidden",
                    }}
                  >
                    {/* Simulated chart image */}
                    <svg width="280" height="160" viewBox="0 0 280 160" fill="none">
                      <rect x="15" y="70" width="50" height="80" rx="8" fill="rgba(0,212,170,0.4)" />
                      <rect x="80" y="40" width="50" height="110" rx="8" fill="rgba(0,212,170,0.5)" />
                      <rect x="145" y="55" width="50" height="95" rx="8" fill="rgba(0,212,170,0.45)" />
                      <rect x="210" y="20" width="50" height="130" rx="8" fill="rgba(0,212,170,0.55)" />
                      <path d="M40 65 L105 35 L170 50 L235 15" stroke="rgba(255,255,255,0.3)" strokeWidth="2" fill="none" strokeDasharray="4 4" />
                    </svg>
                    <div
                      style={{
                        position: "absolute",
                        right: 10,
                        bottom: 10,
                        width: 36,
                        height: 36,
                        borderRadius: "50%",
                        background: `linear-gradient(135deg, ${T.teal}, ${T.tealDark})`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxShadow: `0 0 15px ${T.tealGlow}`,
                      }}
                    >
                      <img src={staticFile("icon.svg")} width={22} height={22} style={{ borderRadius: "50%" }} alt="" />
                    </div>
                  </div>
                </ChatBubble>
                <ChatBubble side="out" time="09:44" ticks delay={55}>
                  Answer received. Marking…
                </ChatBubble>
              </div>
            </GlassCard3D>
          </div>
        </div>
      </DepthEnvironment>

      <WaterdropHollywood progress={drop} />
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 5: AI MARKING — Theory marking showcase
   Duration: 165 frames (5.5s)
   ═══════════════════════════════════════════════════════════════ */
const SceneAIMarking: React.FC = () => {
  const frame = useCurrentFrame();
  const card = useScaleReveal(5);

  const typingDots = [0, 1, 2].map((d) => ({
    opacity: 0.25 + Math.sin(frame * 0.16 + d * 1) * 0.75,
    y: Math.sin(frame * 0.16 + d * 1) * -4,
  }));

  const drop = interpolate(frame, [135, 165], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <DepthEnvironment>
        <LightRays intensity={0.05} />
        <DeepParticles count={14} />

        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 50px",
            transformStyle: "preserve-3d",
          }}
        >
          <div style={{ ...card, width: "100%", maxWidth: 580 }}>
            <GlassCard3D>
              <ChatHeader />
              <div style={{ padding: "16px 18px 22px", display: "flex", flexDirection: "column", gap: 10 }}>
                <DatePill text="TODAY" />

                {/* Typing indicator */}
                <div style={{ display: "flex", justifyContent: "flex-start" }}>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      padding: "16px 22px",
                      background: T.chatIn,
                      borderRadius: 22,
                      borderBottomLeftRadius: 8,
                      border: "1px solid rgba(255,255,255,0.05)",
                    }}
                  >
                    {typingDots.map((dot, d) => (
                      <div
                        key={d}
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: "50%",
                          background: T.teal,
                          opacity: dot.opacity,
                          transform: `translateY(${dot.y}px)`,
                          boxShadow: `0 0 8px rgba(0,212,170,0.4)`,
                        }}
                      />
                    ))}
                  </div>
                </div>

                <ChatBubble side="out" time="09:45" ticks delay={30}>
                  <ChipLabel color={T.green}>AI THEORY MARKING</ChipLabel>
                  ✓ Marked — 4 / 5
                </ChatBubble>
                <ChatBubble side="out" time="09:45" delay={60}>
                  <div style={{ fontSize: 15, color: T.textSecondary, lineHeight: 1.6 }}>
                    Correctness · Completeness · Relevance
                  </div>
                </ChatBubble>
              </div>
            </GlassCard3D>
          </div>
        </div>
      </DepthEnvironment>

      <WaterdropHollywood progress={drop} />
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 6: RESULTS — Score reveal with celebration
   Duration: 120 frames (4s)
   ═══════════════════════════════════════════════════════════════ */
const SceneResults: React.FC = () => {
  const frame = useCurrentFrame();
  const card = useScaleReveal(5);
  const pill = useScaleReveal(20);

  // Celebration particles
  const celebOpacity = interpolate(frame, [25, 35, 85, 100], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const drop = interpolate(frame, [90, 120], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <DepthEnvironment>
        <LightRays intensity={0.07 + Math.sin(frame * 0.08) * 0.03} />
        <DeepParticles count={18} />

        {/* Celebration sparkles */}
        {celebOpacity > 0 && (
          <div style={{ position: "absolute", inset: 0, opacity: celebOpacity, zIndex: 50 }}>
            {Array.from({ length: 30 }, (_, i) => {
              const angle = (i / 30) * Math.PI * 2;
              const dist = 250 + (i % 4) * 100;
              const x = 1080 + Math.cos(angle + frame * 0.025) * dist;
              const y = 1920 + Math.sin(angle + frame * 0.025) * dist;
              const size = 5 + (i % 5) * 3;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: x,
                    top: y,
                    width: size,
                    height: size,
                    borderRadius: "50%",
                    background: i % 3 === 0 ? T.teal : i % 3 === 1 ? "#DCF8C6" : "#FFFFFF",
                    transform: `rotate(${frame * 4 + i * 12}deg)`,
                    boxShadow: `0 0 ${size * 3}px ${i % 2 === 0 ? T.tealGlow : "rgba(220,248,198,0.5)"}`,
                  }}
                />
              );
            })}
          </div>
        )}

        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 50px",
            transformStyle: "preserve-3d",
          }}
        >
          <div style={{ ...card, width: "100%", maxWidth: 580 }}>
            <GlassCard3D>
              <ChatHeader />
              <div
                style={{
                  padding: "16px 18px 26px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 18,
                }}
              >
                <DatePill text="TODAY" />
                <div style={{ alignSelf: "stretch", display: "flex", justifyContent: "flex-end" }}>
                  <ChatBubble side="out" time="09:47" ticks delay={10}>
                    Results sent to your students
                  </ChatBubble>
                </div>
                <div
                  style={{
                    borderRadius: 999,
                    padding: "14px 28px",
                    background: "linear-gradient(135deg, rgba(0,212,170,0.15), rgba(0,168,132,0.1))",
                    border: `1px solid rgba(0,212,170,0.3)`,
                    color: T.teal,
                    fontSize: 20,
                    fontWeight: 700,
                    fontFamily: T.font,
                    opacity: pill.opacity,
                    transform: pill.transform,
                    boxShadow: `0 12px 35px rgba(0,212,170,0.2)`,
                  }}
                >
                  Exam complete — 9 / 10 · Pass
                </div>
              </div>
            </GlassCard3D>
          </div>
        </div>
      </DepthEnvironment>

      <WaterdropHollywood progress={drop} />
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 7: OUTRO — Premium CTA close
   Duration: 105 frames (3.5s)
   ═══════════════════════════════════════════════════════════════ */
const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const iconP = spring({ frame: frame - 8, fps, config: { damping: 9, mass: 0.45 } });
  const iconScale = interpolate(iconP, [0, 1], [0.3, 1]);
  const iconOpacity = interpolate(iconP, [0, 1], [0, 1]);

  const title = useReveal(15);
  const url = useReveal(22);
  const tag = useReveal(30);
  const line = useReveal(38);

  const glow = 0.25 + Math.sin(frame * 0.08) * 0.2;

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <DepthEnvironment>
        <LightRays intensity={0.1 + Math.sin(frame * 0.05) * 0.05} />
        <DeepParticles count={24} />

        {/* Radial glow burst */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "42%",
            width: 1000,
            height: 1000,
            marginLeft: -500,
            marginTop: -500,
            borderRadius: "50%",
            background: `radial-gradient(circle, rgba(0,212,170,${glow * 0.12}) 0%, transparent 55%)`,
            filter: "blur(50px)",
            zIndex: 1,
          }}
        />

        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            transformStyle: "preserve-3d",
            zIndex: 2,
          }}
        >
          {/* Icon */}
          <div
            style={{
              opacity: iconOpacity,
              transform: `scale(${iconScale})`,
              marginBottom: 36,
              filter: `drop-shadow(0 0 ${70 + glow * 70}px rgba(0,212,170,${glow}))`,
            }}
          >
            <img
              src={staticFile("icon.svg")}
              width={140}
              height={140}
              style={{
                borderRadius: 38,
                objectFit: "cover",
                border: `2px solid rgba(0,212,170,0.25)`,
              }}
              alt=""
            />
          </div>

          {/* Brand name */}
          <div
            style={{
              ...title,
              fontSize: 72,
              fontWeight: 700,
              letterSpacing: "-0.04em",
              color: T.textPrimary,
              fontFamily: T.font,
              lineHeight: 1,
              textShadow: "0 4px 30px rgba(0,0,0,0.4)",
            }}
          >
            Exam Bot
          </div>

          {/* URL */}
          <div
            style={{
              ...url,
              fontSize: 28,
              fontWeight: 600,
              color: T.teal,
              marginTop: 20,
              fontFamily: T.font,
              letterSpacing: "0.03em",
            }}
          >
            whatexam.com
          </div>

          {/* Decorative line */}
          <div
            style={{
              ...line,
              width: 160,
              height: 2,
              background: `linear-gradient(90deg, transparent, ${T.teal}, transparent)`,
              marginTop: 24,
              borderRadius: 1,
            }}
          />

          {/* Tagline */}
          <div
            style={{
              ...tag,
              fontSize: 20,
              fontWeight: 500,
              color: T.textMuted,
              marginTop: 20,
              fontFamily: T.font,
            }}
          >
            Start examining — for free.
          </div>
        </div>
      </DepthEnvironment>
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPOSITION — 35s @ 30fps = 1050 frames
   7 scenes, no voiceover, premium Hollywood transitions
   ═══════════════════════════════════════════════════════════════ */
export const WhatExamAdvert: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      {/* ── Background music ── */}
      <Audio src={staticFile("audio/bgm.wav")} volume={0.28} />

      {/* ── Transition whooshes ── */}
      {[150, 315, 495, 660, 825, 945].map((from) => (
        <Sequence key={from} from={from} durationInFrames={25}>
          <Audio src={staticFile("audio/whoosh.wav")} volume={0.55} />
        </Sequence>
      ))}

      {/* ── Voiceovers ── */}
      <Sequence from={30} durationInFrames={120}>
        <Audio src={staticFile("audio/vo-01-intro.mp3")} volume={0.85} />
      </Sequence>
      <Sequence from={140} durationInFrames={175}>
        <Audio src={staticFile("audio/vo-02-tagline.mp3")} volume={0.85} />
      </Sequence>
      <Sequence from={285} durationInFrames={210}>
        <Audio src={staticFile("audio/vo-03-chat.mp3")} volume={0.85} />
      </Sequence>
      <Sequence from={495} durationInFrames={165}>
        <Audio src={staticFile("audio/vo-04-answers.mp3")} volume={0.85} />
      </Sequence>
      <Sequence from={675} durationInFrames={150}>
        <Audio src={staticFile("audio/vo-05-aimarking.mp3")} volume={0.85} />
      </Sequence>
      <Sequence from={785} durationInFrames={160}>
        <Audio src={staticFile("audio/vo-06-results.mp3")} volume={0.85} />
      </Sequence>
      <Sequence from={845} durationInFrames={205}>
        <Audio src={staticFile("audio/vo-07-outro.mp3")} volume={0.85} />
      </Sequence>

      {/* ── Accent sounds ── */}
      <Sequence from={70} durationInFrames={15}>
        <Audio src={staticFile("audio/ding.wav")} volume={0.4} />
      </Sequence>
      <Sequence from={400} durationInFrames={15}>
        <Audio src={staticFile("audio/ding.wav")} volume={0.35} />
      </Sequence>
      <Sequence from={560} durationInFrames={12}>
        <Audio src={staticFile("audio/tick.wav")} volume={0.45} />
      </Sequence>
      <Sequence from={835} durationInFrames={25}>
        <Audio src={staticFile("audio/chime.wav")} volume={0.5} />
      </Sequence>

      {/* ── Scene sequences ── */}
      <Sequence from={0} durationInFrames={150}>
        <SceneIntro />
      </Sequence>
      <Sequence from={150} durationInFrames={165}>
        <SceneTagline />
      </Sequence>
      <Sequence from={315} durationInFrames={180}>
        <SceneChat />
      </Sequence>
      <Sequence from={495} durationInFrames={165}>
        <ScenePhotoAnswer />
      </Sequence>
      <Sequence from={660} durationInFrames={165}>
        <SceneAIMarking />
      </Sequence>
      <Sequence from={825} durationInFrames={120}>
        <SceneResults />
      </Sequence>
      <Sequence from={945} durationInFrames={105}>
        <SceneOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
