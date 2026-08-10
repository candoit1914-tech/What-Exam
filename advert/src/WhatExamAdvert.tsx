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
} from "remotion";

/* ── iOS WhatsApp chat kit ─────────────────────────────────── */
const CHAT = {
  bg: "#EFEAE2",
  header: "rgba(237, 237, 237, 0.94)",
  out: "#DCF8C6",
  in: "#FFFFFF",
  text: "#111B21",
  stamp: "rgba(17, 27, 33, 0.5)",
  online: "#00A884",
  chipTeal: "#008069",
  chipGray: "#667781",
  ticks: "#34B7F1",
  scoreBg: "#DCF8C6",
  scoreText: "#005C4B",
  radius: 16,
  tail: 4,
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

// Same doodle wallpaper as the landing chat (stroke-opacity 0.06)
const WALLPAPER_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Cg fill='none' stroke='%23667C7A' stroke-opacity='0.06'%3E%3Cpath d='M10 20c0 6 4 10 10 10M90 90c6 0 10-4 10-10' stroke-width='2'/%3E%3Ccircle cx='60' cy='30' r='4'/%3E%3Ccircle cx='30' cy='80' r='3'/%3E%3Ccircle cx='92' cy='18' r='3'/%3E%3Cpath d='M18 60c4 4 8 4 12 0M70 60c4 4 8 4 12 0M40 45c0 4 3 7 7 7M88 62c0 4-3 7-7 7' stroke-width='2'/%3E%3Cpath d='M26 40l4 4M52 92l4 4M84 44l4-4M14 100l4-4' stroke-width='2'/%3E%3Cpath d='M104 40c0 3-2 5-5 5s-5-2-5-5' stroke-width='2'/%3E%3C/g%3E%3C/svg%3E";

function Wallpaper() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage: `url("${WALLPAPER_URL}")`,
        backgroundSize: "120px 120px",
      }}
    />
  );
}

function Bubble({
  side,
  children,
  time,
  ticks,
}: {
  side: "in" | "out";
  children: React.ReactNode;
  time: string;
  ticks?: boolean;
}) {
  const out = side === "out";
  return (
    <div style={{ display: "flex", justifyContent: out ? "flex-end" : "flex-start" }}>
      <div
        style={{
          position: "relative",
          maxWidth: "78%",
          padding: "7px 10px 8px",
          borderRadius: CHAT.radius,
          borderTopLeftRadius: out ? CHAT.radius : CHAT.tail,
          borderTopRightRadius: out ? CHAT.tail : CHAT.radius,
          background: out ? CHAT.out : CHAT.in,
          fontSize: 15,
          lineHeight: 1.45,
          color: CHAT.text,
          fontFamily: CHAT.font,
          boxShadow: "0 1px 0.5px rgba(17,27,33,0.13)",
        }}
      >
        {children}
        <span
          style={{
            position: "absolute",
            bottom: 0,
            [out ? "right" : "left"]: -6,
            width: 13,
            height: 13,
            background: out ? CHAT.out : CHAT.in,
            borderRadius: out ? "100% 0 0 0" : "0 100% 0 0",
          }}
        />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            margin: "8px -4px -4px 10px",
            fontSize: 11,
            color: CHAT.stamp,
          }}
        >
          {time}
          {ticks && <span style={{ color: CHAT.ticks, fontSize: 13 }}>✔✔</span>}
        </span>
      </div>
    </div>
  );
}

function Chip({ children, out }: { children: React.ReactNode; out?: boolean }) {
  return (
    <span
      style={{
        display: "block",
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.07em",
        textTransform: "uppercase",
        color: out ? CHAT.chipTeal : CHAT.chipGray,
        marginBottom: 3,
      }}
    >
      {children}
    </span>
  );
}

function DatePill({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", margin: "2px 0 6px" }}>
      <div
        style={{
          padding: "5px 12px",
          borderRadius: 7.5,
          background: "rgba(255,255,255,0.95)",
          boxShadow: "0 1px 1px rgba(0,0,0,0.05)",
          fontSize: 11.5,
          fontWeight: 500,
          color: "rgba(17,27,33,0.6)",
          fontFamily: CHAT.font,
        }}
      >
        {text}
      </div>
    </div>
  );
}

function ChatHeader({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 10px 8px",
        background: CHAT.header,
        boxShadow: "inset 0 -0.5px 0 rgba(0,0,0,0.08)",
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={CHAT.chipTeal} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 5l-7 7 7 7" />
      </svg>
      <img src={icon} style={{ width: 38, height: 38, borderRadius: "50%", objectFit: "cover" }} alt="" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16.5, fontWeight: 600, color: CHAT.text, fontFamily: CHAT.font, lineHeight: 1.2 }}>{title}</div>
        <div style={{ fontSize: 12, color: CHAT.online, fontFamily: CHAT.font }}>{subtitle}</div>
      </div>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={CHAT.chipTeal} strokeWidth="2" strokeLinecap="round">
        <rect x="2" y="6" width="13" height="12" rx="3" />
        <path d="M15 10l5-3v10l-5-3" />
      </svg>
      <svg width="20" height="20" viewBox="0 0 24 24" fill={CHAT.chipTeal}>
        <path d="M6.6 10.8a15.5 15.5 0 006.6 6.6l2.2-2.2a1 1 0 011-.24c1.1.28 2.3.44 3.5.44.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.6 21 3 13.4 3 4.1 3 3.55 3.45 3 4 3h3.5c.55 0 1 .45 1 1 0 1.2.16 2.4.44 3.5a1 1 0 01-.24 1l-2.1 2.3z" />
      </svg>
    </div>
  );
}

function ChatCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "relative",
        width: 430,
        borderRadius: 28,
        overflow: "hidden",
        background: CHAT.bg,
        boxShadow: "0 30px 70px rgba(0,0,0,0.35)",
        display: "flex",
        flexDirection: "column",
        minHeight: 560,
      }}
    >
      <Wallpaper />
      {children}
    </div>
  );
}

/* ── Helper: fade + slide in ───────────────────────────────── */
function useFadeSlide(delay: number, duration = 20) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - delay, fps, config: { damping: 14, mass: 0.8 } });
  const opacity = interpolate(progress, [0, 1], [0, 1]);
  const y = interpolate(progress, [0, 1], [40, 0]);
  return { opacity, transform: `translateY(${y}px)` };
}

/* ── Helper: scale spring ──────────────────────────────────── */
function useScale(delay: number) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - delay, fps, config: { damping: 12, mass: 0.6 } });
  return { transform: `scale(${interpolate(progress, [0, 1], [0.7, 1])})`, opacity: interpolate(progress, [0, 1], [0, 1]) };
}

/* ═══════════════════════════════════════════════════════════════
   SCENE 1: INTRO — App icon lockup (frames 0-60)
   ═══════════════════════════════════════════════════════════════ */
const SceneIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Icon spring scale from 0.3 (delay 8)
  const iconProgress = spring({ frame: frame - 8, fps, config: { damping: 10, mass: 0.8 } });
  const iconScale = interpolate(iconProgress, [0, 1], [0.3, 1]);
  const iconOpacity = interpolate(iconProgress, [0, 1], [0, 1]);

  const word = useFadeSlide(25);
  const sub = useFadeSlide(38);

  return (
    <AbsoluteFill
      style={{
        background: CHAT.bg,
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <Wallpaper />
      <div style={{ position: "relative", textAlign: "center" }}>
        <div
          style={{
            opacity: iconOpacity,
            transform: `scale(${iconScale})`,
            marginBottom: 24,
          }}
        >
          <img
            src={staticFile("icon.svg")}
            width={140}
            height={140}
            style={{ borderRadius: 36, objectFit: "cover" }}
            alt=""
          />
        </div>
        <div
          style={{
            opacity: word.opacity,
            transform: word.transform,
            fontFamily: CHAT.font,
            fontSize: 72,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: CHAT.text,
            lineHeight: 1,
          }}
        >
          Exam Bot
        </div>
        <div
          style={{
            opacity: sub.opacity,
            transform: sub.transform,
            fontFamily: CHAT.font,
            fontSize: 26,
            fontWeight: 500,
            letterSpacing: "0.3em",
            color: CHAT.chipGray,
            textTransform: "uppercase",
            marginTop: 18,
          }}
        >
          Start Examining — For Free
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 2: HERO TAGLINE — Chat greeting over "Exams that mark themselves."
   ═══════════════════════════════════════════════════════════════ */
const SceneTagline: React.FC = () => {
  const headline = useFadeSlide(5);
  const card = useScale(8);
  const sub = useFadeSlide(22);

  return (
    <AbsoluteFill
      style={{
        background: CHAT.bg,
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <Wallpaper />
      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
        <div
          style={{
            opacity: headline.opacity,
            transform: headline.transform,
            fontFamily: CHAT.font,
            fontSize: 52,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "#005C4B",
            textAlign: "center",
          }}
        >
          Exams that mark themselves.
        </div>

        <div style={{ opacity: card.opacity, transform: card.transform }}>
          <ChatCard>
            <ChatHeader icon={staticFile("icon.svg")} title="Exam Bot" subtitle="online" />
            <div
              style={{
                position: "relative",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: "12px 12px 16px",
              }}
            >
              <DatePill text="TODAY" />
              <Bubble side="in" time="09:00">
                Good morning! Your exam starts in 10 minutes.
              </Bubble>
              <Bubble side="out" time="09:01">
                Ready when you are.
              </Bubble>
            </div>
          </ChatCard>
        </div>

        <div
          style={{
            opacity: sub.opacity,
            transform: sub.transform,
            fontFamily: CHAT.font,
            fontSize: 24,
            fontWeight: 500,
            color: CHAT.chipGray,
            textAlign: "center",
          }}
        >
          Your bot delivers them — AI does the rest.
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 3: CHAT — Question, options, answer, AI marking
   ═══════════════════════════════════════════════════════════════ */
const SceneDashboard: React.FC = () => {
  const card = useFadeSlide(5);

  return (
    <AbsoluteFill
      style={{
        background: CHAT.bg,
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <Wallpaper />
      <div style={{ opacity: card.opacity, transform: card.transform }}>
        <ChatCard>
          <ChatHeader icon={staticFile("icon.svg")} title="Exam Bot" subtitle="online" />
          <div
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "12px 12px 16px",
            }}
          >
            <DatePill text="TODAY" />
            <Bubble side="out" time="09:42">
              <Chip out>QUESTION 1 · OBJECTIVE</Chip>
              What is the capital of Ghana?
            </Bubble>
            <Bubble side="out" time="09:42">
              <Chip out>ANSWER OPTIONS</Chip>
              <div
                style={{
                  borderLeft: "2px solid rgba(0,128,105,0.4)",
                  background: "rgba(11,20,26,0.04)",
                  borderRadius: 8,
                  padding: "7px 10px",
                  fontSize: 13,
                  lineHeight: 1.5,
                  whiteSpace: "pre-line",
                }}
              >
                {"A. Accra\nB. Kumasi\nC. Cape Coast\nD. Tamale"}
              </div>
            </Bubble>
            <Bubble side="in" time="09:43">
              A
            </Bubble>
            <Bubble side="out" time="09:43" ticks>
              <Chip out>AI MARKING</Chip>
              ✓ Correct — +1 mark
            </Bubble>
          </div>
        </ChatCard>
      </div>
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 4: ANSWERS — Photo answer bubble with chart
   ═══════════════════════════════════════════════════════════════ */
const SceneWhatsApp: React.FC = () => {
  const card = useFadeSlide(5);

  return (
    <AbsoluteFill
      style={{
        background: CHAT.bg,
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <Wallpaper />
      <div style={{ opacity: card.opacity, transform: card.transform }}>
        <ChatCard>
          <ChatHeader icon={staticFile("icon.svg")} title="Exam Bot" subtitle="online" />
          <div
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "12px 12px 16px",
            }}
          >
            <DatePill text="TODAY" />
            <Bubble side="out" time="09:44">
              <Chip out>ANSWER · PHOTO</Chip>
              <div
                style={{
                  position: "relative",
                  width: 240,
                  height: 160,
                  borderRadius: 10,
                  background: "linear-gradient(135deg,#DFF0DC,#E8F5E9)",
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "center",
                  padding: "10px 12px",
                  marginBottom: 2,
                }}
              >
                <svg width="190" height="120" viewBox="0 0 190 120" fill="none">
                  <rect x="10" y="52" width="34" height="58" rx="6" fill="rgba(0,128,105,0.55)" />
                  <rect x="54" y="28" width="34" height="82" rx="6" fill="rgba(0,128,105,0.55)" />
                  <rect x="98" y="42" width="34" height="68" rx="6" fill="rgba(0,128,105,0.55)" />
                  <rect x="142" y="12" width="34" height="98" rx="6" fill="rgba(0,128,105,0.55)" />
                </svg>
                <img
                  src={staticFile("icon.svg")}
                  width={28}
                  height={28}
                  style={{
                    position: "absolute",
                    right: 8,
                    bottom: 8,
                    borderRadius: "50%",
                    objectFit: "cover",
                    boxShadow: "0 0 0 1.5px #FFFFFF",
                  }}
                  alt=""
                />
              </div>
            </Bubble>
            <Bubble side="out" time="09:44" ticks>
              Answer received. Marking…
            </Bubble>
          </div>
        </ChatCard>
      </div>
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 5: AI MARKING — Theory marking in chat
   ═══════════════════════════════════════════════════════════════ */
const SceneAIMarking: React.FC = () => {
  const frame = useCurrentFrame();
  const card = useFadeSlide(5);

  return (
    <AbsoluteFill
      style={{
        background: CHAT.bg,
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <Wallpaper />
      <div style={{ opacity: card.opacity, transform: card.transform }}>
        <ChatCard>
          <ChatHeader icon={staticFile("icon.svg")} title="Exam Bot" subtitle="online" />
          <div
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "12px 12px 16px",
            }}
          >
            <DatePill text="TODAY" />
            {/* Typing indicator */}
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <div
                style={{
                  display: "flex",
                  gap: 4,
                  padding: "14px 16px",
                  background: "#FFFFFF",
                  borderRadius: 16,
                  borderTopLeftRadius: 4,
                  boxShadow: "0 1px 0.5px rgba(17,27,33,0.13)",
                }}
              >
                {[0, 1, 2].map((d) => (
                  <div
                    key={d}
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: "#7B8A93",
                      opacity: 0.5 + Math.sin(frame * 0.2 + d * 0.8) * 0.5,
                      transform: `translateY(${Math.sin(frame * 0.2 + d * 0.8) * -3}px)`,
                    }}
                  />
                ))}
              </div>
            </div>
            <Bubble side="out" time="09:45" ticks>
              <Chip out>AI THEORY MARKING</Chip>
              ✓ Marked — 4 / 5
            </Bubble>
            <Bubble side="out" time="09:45">
              <div style={{ fontSize: 13, color: "rgba(17,27,33,0.8)" }}>
                Correctness · Completeness · Relevance
              </div>
            </Bubble>
          </div>
        </ChatCard>
      </div>
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 6: RESULTS — Results sent + score pill
   ═══════════════════════════════════════════════════════════════ */
const SceneResults: React.FC = () => {
  const card = useFadeSlide(5);
  const pill = useScale(18);

  return (
    <AbsoluteFill
      style={{
        background: CHAT.bg,
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <Wallpaper />
      <div style={{ opacity: card.opacity, transform: card.transform }}>
        <ChatCard>
          <ChatHeader icon={staticFile("icon.svg")} title="Exam Bot" subtitle="online" />
          <div
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              padding: "12px 12px 20px",
            }}
          >
            <DatePill text="TODAY" />
            <div style={{ alignSelf: "stretch", display: "flex", justifyContent: "flex-end" }}>
              <Bubble side="out" time="09:47" ticks>
                Results sent to your students
              </Bubble>
            </div>
            <div
              style={{
                borderRadius: 999,
                padding: "8px 16px",
                background: CHAT.scoreBg,
                border: "1px solid rgba(7,94,84,0.2)",
                color: CHAT.scoreText,
                fontSize: 15,
                fontWeight: 700,
                fontFamily: CHAT.font,
                opacity: pill.opacity,
                transform: pill.transform,
              }}
            >
              Exam complete — 9 / 10 · Pass
            </div>
          </div>
        </ChatCard>
      </div>
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENE 7: OUTRO — App icon lockup close
   ═══════════════════════════════════════════════════════════════ */
const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const iconProgress = spring({ frame: frame - 2, fps, config: { damping: 10, mass: 0.7 } });
  const iconScale = interpolate(iconProgress, [0, 1], [0.5, 1]);
  const iconOpacity = interpolate(iconProgress, [0, 1], [0, 1]);

  const word = useFadeSlide(8);
  const url = useFadeSlide(15);
  const tag = useFadeSlide(20);

  return (
    <AbsoluteFill
      style={{
        background: CHAT.bg,
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <Wallpaper />
      <div style={{ position: "relative", textAlign: "center" }}>
        <div
          style={{
            opacity: iconOpacity,
            transform: `scale(${iconScale})`,
            marginBottom: 20,
          }}
        >
          <img
            src={staticFile("icon.svg")}
            width={120}
            height={120}
            style={{ borderRadius: 36, objectFit: "cover" }}
            alt=""
          />
        </div>
        <div
          style={{
            opacity: word.opacity,
            transform: word.transform,
            fontFamily: CHAT.font,
            fontSize: 64,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: CHAT.text,
            lineHeight: 1,
          }}
        >
          Exam Bot
        </div>
        <div
          style={{
            opacity: url.opacity,
            transform: url.transform,
            fontFamily: CHAT.font,
            fontSize: 26,
            fontWeight: 600,
            color: CHAT.chipTeal,
            marginTop: 14,
          }}
        >
          whatexam.com
        </div>
        <div
          style={{
            opacity: tag.opacity,
            transform: tag.transform,
            fontFamily: CHAT.font,
            fontSize: 26,
            fontWeight: 500,
            color: CHAT.chipGray,
            marginTop: 6,
          }}
        >
          Start examining — for free.
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPOSITION — Voiceover-driven, 26s @ 30fps = 780 frames
   ═══════════════════════════════════════════════════════════════ */
export const WhatExamAdvert: React.FC = () => {
  /*
   * Scene timing (voiceover-driven):
   *   1. Intro        0 –  60   (2s)   Icon + "Exam Bot" lockup
   *   2. Tagline     60 – 180   (4s)   Headline over chat greeting
   *   3. Chat        180 – 360  (6s)   Question, options, answer
   *   4. Answers     360 – 510  (5s)   Photo answer bubble
   *   5. AI Marking  510 – 690  (6s)   Theory marking in chat
   *   6. Results     690 – 750  (2s)   Score pill
   *   7. Outro       750 – 780  (1s)   Icon close + "for free"
   */
  return (
    <AbsoluteFill style={{ background: CHAT.bg }}>
      {/* ── Background music (full duration, low volume under voice) ── */}
      <Audio src={staticFile("audio/bgm.wav")} volume={0.15} />

      {/* ── Voiceover per scene ── */}
      <Sequence from={15} durationInFrames={60}>
        <Audio src={staticFile("audio/vo-01-intro.mp3")} volume={1} />
      </Sequence>
      <Sequence from={80} durationInFrames={120}>
        <Audio src={staticFile("audio/vo-02-tagline.mp3")} volume={1} />
      </Sequence>
      <Sequence from={200} durationInFrames={180}>
        <Audio src={staticFile("audio/vo-03-chat.mp3")} volume={1} />
      </Sequence>
      <Sequence from={375} durationInFrames={150}>
        <Audio src={staticFile("audio/vo-04-answers.mp3")} volume={1} />
      </Sequence>
      <Sequence from={525} durationInFrames={180}>
        <Audio src={staticFile("audio/vo-05-aimarking.mp3")} volume={1} />
      </Sequence>
      <Sequence from={700} durationInFrames={60}>
        <Audio src={staticFile("audio/vo-06-results.mp3")} volume={1} />
      </Sequence>
      <Sequence from={755} durationInFrames={30}>
        <Audio src={staticFile("audio/vo-07-outro.mp3")} volume={1} />
      </Sequence>

      {/* ── Sound effects ── */}
      {[60, 180, 360, 510, 690, 750].map((from) => (
        <Sequence key={from} from={from} durationInFrames={15}>
          <Audio src={staticFile("audio/whoosh.wav")} volume={0.4} />
        </Sequence>
      ))}
      <Sequence from={385} durationInFrames={15}>
        <Audio src={staticFile("audio/ding.wav")} volume={0.35} />
      </Sequence>
      <Sequence from={710} durationInFrames={20}>
        <Audio src={staticFile("audio/chime.wav")} volume={0.4} />
      </Sequence>

      {/* ── Scene sequences ── */}
      <Sequence from={0} durationInFrames={60}>
        <SceneIntro />
      </Sequence>
      <Sequence from={60} durationInFrames={120}>
        <SceneTagline />
      </Sequence>
      <Sequence from={180} durationInFrames={180}>
        <SceneDashboard />
      </Sequence>
      <Sequence from={360} durationInFrames={150}>
        <SceneWhatsApp />
      </Sequence>
      <Sequence from={510} durationInFrames={180}>
        <SceneAIMarking />
      </Sequence>
      <Sequence from={690} durationInFrames={60}>
        <SceneResults />
      </Sequence>
      <Sequence from={750} durationInFrames={30}>
        <SceneOutro />
      </Sequence>
    </AbsoluteFill>
  );
};