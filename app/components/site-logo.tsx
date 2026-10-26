import { useEffect, useRef } from "react";

import {
  distanceToBox,
  LOGO_IDLE_MS,
  LOGO_IDLE_REPEAT_MS,
  type LogoCover,
  LOOK_RANGE,
  lookToward,
  nextCover,
  TOUCH_HIDE_MS,
  TOUCH_SCROLL,
  UNCOVERED,
} from "~/lib/logo";

// How long the eyes' moves last (app.css).
const PLAY_MS = 2600;
const PEEK_MS = 1200;

type Point = { x: number; y: number };

/**
 * The header's logo (owner's request, 2026-10-26): two eyes, a round human
 * one and a square machine one in the accent, so in a fan's tint too. They
 * follow the cursor, and blink and look around after a while without input.
 * As the cursor nears, the name comes down over them part way; over the logo
 * it covers them, and once the cursor leaves it lifts in one move and the
 * eyes peek out. Keyboard focus shows the name as well. A touch screen has
 * no cursor, so there it is the other way round: the name shows, and the
 * eyes come out while the page scrolls, looking the way it goes, until a
 * moment after it stops. Scrolling alone tells, since a swipe that catches
 * the page still coasting never reaches it as a touch. The motion is in
 * app.css; this only sets its state, on the element rather than through
 * React, since it follows every move.
 */
export function SiteLogo() {
  const logoRef = useRef<HTMLSpanElement>(null);
  const eyesRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const logo = logoRef.current;
    const eyes = eyesRef.current;
    if (!logo || !eyes) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    const touchy = window.matchMedia("(hover: none)");
    let cover: LogoCover = UNCOVERED;
    let pointer: Point | null = null;
    let frame = 0;
    let idle = 0;
    let sleep = 0;
    // Where the page was as this stretch of scrolling began (null while it is
    // still), and where it was at the last scroll.
    let scrolledFrom: number | null = null;
    let lastY = window.scrollY;
    const ends: Record<"play" | "peek", number> = { play: 0, peek: 0 };

    const flag = (name: string, on: boolean) => logo.toggleAttribute(`data-${name}`, on);

    // Starts one of the eyes' moves over, even while it is running.
    const run = (name: "play" | "peek", ms: number) => {
      flag(name, false);
      void logo.offsetWidth;
      flag(name, true);
      clearTimeout(ends[name]);
      ends[name] = window.setTimeout(() => flag(name, false), ms);
    };

    const look = ([x, y]: [number, number]) => {
      logo.style.setProperty("--look-x", x.toFixed(2));
      logo.style.setProperty("--look-y", y.toFixed(2));
    };

    const update = () => {
      frame = 0;
      const next = nextCover(pointer ? distanceToBox(pointer.x, pointer.y, logo.getBoundingClientRect()) : null, cover);
      if (cover.cover === 1 && next.cover < 1 && !still.matches) run("peek", PEEK_MS);
      cover = next;
      logo.style.setProperty("--cover", String(next.cover));
      flag("snap", next.snap);
      flag("shut", next.cover === 1);
      flag("near", !still.matches && next.cover > 0.12 && next.cover < 1);
      if (pointer && !still.matches) {
        const box = eyes.getBoundingClientRect();
        look(lookToward(pointer.x - (box.left + box.width / 2), pointer.y - (box.top + box.height / 2)));
      } else {
        look([0, 0]);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    const waitIdle = (ms = LOGO_IDLE_MS) => {
      clearTimeout(idle);
      idle = window.setTimeout(() => {
        if (!document.hidden && !still.matches && !touchy.matches) run("play", PLAY_MS);
        waitIdle(LOGO_IDLE_REPEAT_MS);
      }, ms);
    };

    // A mouse or pen: the name comes and goes with the cursor. A touch
    // screen's touches are left alone; its scrolling shows the eyes instead.
    const onPointer = (event: PointerEvent) => {
      if (touchy.matches) return;
      pointer = { x: event.clientX, y: event.clientY };
      schedule();
      waitIdle();
    };
    // A finger or pen lifted, or the mouse out of the window: nothing to look at.
    const onPointerGone = (event: PointerEvent) => {
      if (touchy.matches) return;
      if (event.type === "pointerout" ? event.relatedTarget !== null : event.pointerType === "mouse") return;
      pointer = null;
      schedule();
    };

    const onScroll = () => {
      waitIdle();
      const y = window.scrollY;
      const moved = y - lastY;
      lastY = y;
      if (!touchy.matches || still.matches) return;
      scrolledFrom ??= y - moved;
      if (!logo.hasAttribute("data-awake") && Math.abs(y - scrolledFrom) < TOUCH_SCROLL) return;
      flag("awake", true);
      if (moved !== 0) look([0, Math.sign(moved) * LOOK_RANGE * 0.8]);
      clearTimeout(sleep);
      sleep = window.setTimeout(() => {
        flag("awake", false);
        scrolledFrom = null;
      }, TOUCH_HIDE_MS);
    };
    const onKey = () => waitIdle();

    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });
    window.addEventListener("pointerup", onPointerGone);
    window.addEventListener("pointercancel", onPointerGone);
    document.addEventListener("pointerout", onPointerGone);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    waitIdle();

    return () => {
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("pointerup", onPointerGone);
      window.removeEventListener("pointercancel", onPointerGone);
      document.removeEventListener("pointerout", onPointerGone);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
      clearTimeout(idle);
      clearTimeout(sleep);
      clearTimeout(ends.play);
      clearTimeout(ends.peek);
    };
  }, []);

  return (
    <span ref={logoRef} className="site-logo relative flex h-full items-center overflow-hidden">
      <span className="absolute inset-y-0 left-0 flex items-center">
        <span className="logo-duck block">
          <span className="logo-wobble block">
            <svg
              ref={eyesRef}
              viewBox="0 0 48 24"
              className="block h-[0.925em] w-[1.85em]"
              fill="none"
              strokeWidth={4}
              aria-hidden
            >
              <g className="logo-eye">
                <circle className="stroke-text" cx="12" cy="12" r="8.5" />
                <g className="logo-pupil">
                  <g className="logo-look">
                    <circle className="fill-text" cx="12" cy="12" r="3.6" />
                  </g>
                </g>
              </g>
              <g className="logo-eye">
                <rect className="stroke-accent" x="27" y="3.5" width="17" height="17" rx="3.5" />
                <g className="logo-pupil">
                  <g className="logo-look">
                    <rect className="fill-accent" x="32" y="8.5" width="7" height="7" rx="1" />
                  </g>
                </g>
              </g>
            </svg>
          </span>
        </span>
      </span>
      {/* Positioned, so it paints over the eyes even when it is not moved. */}
      <span className="logo-name relative flex h-full items-center bg-bg">
        <span className="text-accent">ai</span>on.ly
      </span>
    </span>
  );
}
