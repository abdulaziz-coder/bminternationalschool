import { Fragment, useRef, type ReactNode } from 'react';
import { motion, useReducedMotion, useScroll, useSpring, useTransform, type MotionValue, type Variants } from 'framer-motion';

const spring = { type: 'spring', stiffness: 90, damping: 15, mass: .9 } as const;
const hiddenStates = {
  rise: { opacity: 0, y: 70, scale: .94 },
  left: { opacity: 0, x: -110, rotate: -5 },
  right: { opacity: 0, x: 110, rotate: 5 },
  flip: { opacity: 0, y: 60, rotateX: -50, transformPerspective: 900 },
};
export type RevealEffect = keyof typeof hiddenStates;

/** One-time entrance when the block scrolls into view. Children with their own variants are staggered. */
export function Reveal({ children, className = '', effect = 'rise' }: { children: ReactNode; className?: string; effect?: RevealEffect }) {
  const reduced = useReducedMotion();
  const variants: Variants = {
    hidden: hiddenStates[effect],
    visible: { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0, rotateX: 0, transition: { ...spring, staggerChildren: .09 } },
  };
  return <motion.div className={className} initial={reduced ? false : 'hidden'} whileInView="visible" variants={variants} viewport={{ once: true, amount: .1 }}>{children}</motion.div>;
}

/** Cards start stacked towards the centre of the row and are dealt out to their places. */
export const dealCard: Variants = {
  hidden: (index: number) => ({ opacity: 0, y: 100, x: `${(1.5 - index) * 40}%`, rotate: (index - 1.5) * 8, rotateX: 35, scale: .8, transformPerspective: 900 }),
  visible: (index: number) => ({ opacity: 1, y: 0, x: '0%', rotate: 0, rotateX: 0, scale: 1, transition: { type: 'spring', stiffness: 120, damping: 13, delay: index * .09 } }),
};

export const slideList: Variants = { visible: { transition: { staggerChildren: .12 } } };
export const slideItem: Variants = {
  hidden: { opacity: 0, x: 130, skewX: -12 },
  visible: { opacity: 1, x: 0, skewX: 0, transition: { type: 'spring', stiffness: 110, damping: 16 } },
};

function ScrubWord({ progress, start, children }: { progress: MotionValue<number>; start: number; children: string }) {
  const range = [start, start + .3];
  const opacity = useTransform(progress, range, [.14, 1]);
  const y = useTransform(progress, range, [16, 0]);
  // Drop the filter completely once the word is sharp so text keeps normal rendering.
  const filter = useTransform(progress, value => {
    const remaining = 1 - Math.min(1, Math.max(0, (value - start) / .3));
    return remaining > 0 ? `blur(${(remaining * 6).toFixed(2)}px)` : 'none';
  });
  return <motion.span className="scrub-word" style={{ opacity, y, filter }}>{children}</motion.span>;
}

export type HeadingPiece = { text: string; em?: boolean };

/** A heading whose words sharpen one by one as it travels up the screen. */
export function ScrubHeading({ lines }: { lines: HeadingPiece[][] }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 92%', 'start 42%'] });
  const total = lines.flat().reduce((count, piece) => count + piece.text.split(/\s+/).filter(Boolean).length, 0);
  let index = 0;
  return <h2 ref={ref}>{lines.map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{line.map((piece, pieceIndex) => {
    const words = reduced ? piece.text : piece.text.split(/\s+/).filter(Boolean).map((word, wordIndex) => {
      const start = (index++ / total) * .7;
      return <Fragment key={wordIndex}>{wordIndex > 0 && ' '}<ScrubWord progress={scrollYProgress} start={start}>{word}</ScrubWord></Fragment>;
    });
    return <Fragment key={pieceIndex}>{pieceIndex > 0 && ' '}{piece.em ? <em>{words}</em> : words}</Fragment>;
  })}</Fragment>)}</h2>;
}

/** Scales and tilts a panel into place as its top edge rises through the lower part of the screen. */
export function useScrollZoom<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'start 65%'] });
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 26, mass: .5 });
  const scale = useTransform(progress, [0, 1], [.82, 1]);
  const y = useTransform(progress, [0, 1], [90, 0]);
  const rotateX = useTransform(progress, [0, 1], [16, 0]);
  return { ref, style: reduced ? undefined : { scale, y, rotateX, transformPerspective: 1200 } };
}
