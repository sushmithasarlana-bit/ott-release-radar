// "Watch Next": the floating heart box (top right), the shortlist panel where
// the viewer picks a Final watch and a Next watch, and the confetti burst.
import { useEffect, useRef, type CSSProperties } from "react";
import styles from "./page.module.css";
import { clearAll, removeItem, setFinal, setNext, useWatchNext, type ShortlistItem } from "./watchNextStore";

export function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
      <path
        d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.3 2.4.7-1.3 2.2-2.4 4.3-2.4 3.7 0 5.8 3.8 4.3 7.2C19.5 16.4 12 21 12 21z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------- confetti
export interface Burst {
  id: number;
  x: number;
  y: number;
  pieces: { dx: number; dy: number; rot: number; color: string; size: number; delay: number; round: boolean }[];
}

const COLORS = ["#ff4d6d", "#f5c518", "#3ddc84", "#6ab3f3", "#ffffff", "#ff8fab"];

/** A burst of ~28 pieces flying out from (x, y). Random values are made here, in the click handler. */
export function makeBurst(x: number, y: number): Burst {
  return {
    id: Date.now() + Math.random(),
    x,
    y,
    pieces: Array.from({ length: 28 }, (_, i) => {
      const angle = (i / 28) * Math.PI * 2 + Math.random() * 0.4;
      const distance = 50 + Math.random() * 70;
      return {
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance - 20, // a little lift, then gravity in CSS
        rot: Math.random() * 540 - 270,
        color: COLORS[i % COLORS.length],
        size: 5 + Math.random() * 5,
        delay: Math.random() * 60,
        round: Math.random() < 0.35,
      };
    }),
  };
}

export function ConfettiLayer({ bursts }: { bursts: Burst[] }) {
  return (
    <div className={styles.confettiLayer} aria-hidden="true">
      {bursts.map((b) =>
        b.pieces.map((p, i) => (
          <span
            key={`${b.id}-${i}`}
            className={styles.confetti}
            style={
              {
                left: b.x,
                top: b.y,
                width: p.size,
                height: p.round ? p.size : p.size * 0.45,
                borderRadius: p.round ? "50%" : 2,
                background: p.color,
                "--dx": `${p.dx}px`,
                "--dy": `${p.dy}px`,
                "--rot": `${p.rot}deg`,
                animationDelay: `${p.delay}ms`,
              } as CSSProperties
            }
          />
        )),
      )}
    </div>
  );
}

// ---------------------------------------------------------------- floating box
export function WatchNextButton({ open, onOpen, glowKey }: { open: boolean; onOpen: () => void; glowKey: number }) {
  const { items } = useWatchNext();
  return (
    <button
      type="button"
      className={`${styles.watchNextBox} ${items.length ? styles.watchNextActive : ""}`}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Watch Next list, ${items.length} title${items.length === 1 ? "" : "s"}`}
    >
      {/* Remounts on every add (key), which replays the glow animation. */}
      {glowKey > 0 && <span key={glowKey} className={styles.watchNextGlow} aria-hidden="true" />}
      <span className={styles.watchNextHeart}>
        <HeartIcon filled={items.length > 0} />
      </span>
      <span className={styles.watchNextLabel}>Watch Next</span>
      <span key={`count-${glowKey}`} className={styles.watchNextCount}>
        {items.length}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- panel
export function WatchNextPanel({ onClose }: { onClose: () => void }) {
  const { items, finalId, nextId } = useWatchNext();
  const closeRef = useRef<HTMLButtonElement>(null);
  const finalItem = items.find((i) => i.id === finalId) ?? null;
  const nextItem = items.find((i) => i.id === nextId) ?? null;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus(); // back to the Watch Next box
    };
  }, [onClose]);

  return (
    <div className={styles.drawerBackdrop} onClick={onClose}>
      <aside
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="watch-next-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.drawerHead}>
          <h2 id="watch-next-title">
            <span className={styles.drawerHeart}>
              <HeartIcon filled />
            </span>
            Watch Next
          </h2>
          <button ref={closeRef} type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close Watch Next">
            ✕
          </button>
        </header>

        <div className={styles.slots}>
          <Slot label="🎬 Final watch" hint="Your pick for this week" item={finalItem} onClear={() => finalItem && setFinal(finalItem.id)} />
          <Slot label="⏭ Next watch" hint="Lined up after that" item={nextItem} onClear={() => nextItem && setNext(nextItem.id)} />
        </div>

        <h3 className={styles.shortlistTitle}>
          Shortlist <span>{items.length}</span>
        </h3>
        {items.length === 0 ? (
          <div className={styles.drawerEmpty}>
            <p>Tap the ♥ on any title to shortlist it for the week.</p>
            <p className={styles.muted}>Then pick your Final watch and Next watch here.</p>
          </div>
        ) : (
          <ul className={styles.shortlist}>
            {items.map((item) => (
              <li key={item.id} className={styles.shortRow}>
                <Thumb item={item} />
                <div className={styles.shortInfo}>
                  <p className={styles.shortName}>{item.title}</p>
                  <p className={styles.muted}>
                    {item.platforms}
                    {item.verdict && ` · ${item.verdict === "WATCH" ? "✓ Watch" : "✕ Skip"} ${item.score}/10`}
                  </p>
                  <div className={styles.shortActions}>
                    <button type="button" aria-pressed={finalId === item.id} onClick={() => setFinal(item.id)} data-slot="final">
                      🎬 Final
                    </button>
                    <button type="button" aria-pressed={nextId === item.id} onClick={() => setNext(item.id)} data-slot="next">
                      ⏭ Next
                    </button>
                    <button type="button" className={styles.removeBtn} onClick={() => removeItem(item.id)} aria-label={`Remove ${item.title}`}>
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <footer className={styles.drawerFoot}>
          <p className={styles.muted}>Saved in this browser only.</p>
          {items.length > 0 && (
            <button type="button" className={styles.clear} onClick={clearAll}>
              Clear list
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}

function Thumb({ item, large = false }: { item: ShortlistItem; large?: boolean }) {
  return item.poster ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className={large ? styles.slotPoster : styles.thumb} src={item.poster} alt="" loading="lazy" />
  ) : (
    <span className={large ? styles.slotPoster : styles.thumb} aria-hidden="true">
      {item.title.slice(0, 1)}
    </span>
  );
}

function Slot({ label, hint, item, onClear }: { label: string; hint: string; item: ShortlistItem | null; onClear: () => void }) {
  return (
    <div className={`${styles.slot} ${item ? styles.slotFilled : ""}`}>
      <p className={styles.slotLabel}>{label}</p>
      {item ? (
        <div className={styles.slotBody}>
          <Thumb item={item} large />
          <div>
            <p className={styles.slotName}>{item.title}</p>
            <p className={styles.muted}>{item.platforms}</p>
            <div className={styles.slotLinks}>
              {item.link && /^https?:\/\//.test(item.link) && (
                <a href={item.link} target="_blank" rel="noopener noreferrer">
                  Open ↗
                </a>
              )}
              <button type="button" onClick={onClear}>
                Clear
              </button>
            </div>
          </div>
        </div>
      ) : (
        <p className={styles.muted}>{hint}. Choose one from the shortlist below.</p>
      )}
    </div>
  );
}
