import { useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, useScroll, useSpring, useTransform, useVelocity } from 'framer-motion';
import Admissions from './Admissions';
import Brand from './Brand';
import Accordion from './Accordion';
import Photo, { photos } from './Photo';
import { useLanguage, LanguageSwitcher } from './i18n';
import { Reveal, ScrubHeading, dealCard, slideItem, slideList } from './ScrollFx';

const heroItem = { hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0, transition: { duration: .55 } } };
const experiences = [
  { name: 'Create & express', word: 'create.', text: 'Art, ideas, and imagination. Our vision gives students room to experiment, share their perspective, and discover the satisfaction of making something their own.' },
  { name: 'Move & discover', word: 'explore.', text: 'Energy, teamwork, and exploration. We envision opportunities to move, try new challenges, and build confidence alongside others.' },
  { name: 'Connect & contribute', word: 'belong.', text: 'A community to grow with. Our ambition is a place where listening, working together, and caring for others are part of everyday learning.' },
];
export default function App() {
  const { t } = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);
  const [experience, setExperience] = useState(0);
  const reduced = useReducedMotion();
  const { scrollY, scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 100, damping: 30 });

  // Hero: the copy drifts away while the photo card tilts, shrinks, and zooms as it leaves.
  const copyRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress: copyExit } = useScroll({ target: copyRef, offset: ['end 40%', 'end 10%'] });
  const copyY = useTransform(copyExit, [0, 1], [0, 50]);
  const copyOpacity = useTransform(copyExit, [0, 1], [1, 0]);
  const artRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress: artTravel } = useScroll({ target: artRef, offset: ['start end', 'end start'] });
  const art = useSpring(artTravel, { stiffness: 140, damping: 26, mass: .5 });
  const artRotate = useTransform(art, [0, .3, .65, 1], [7, 0, 0, -8]);
  const artScale = useTransform(art, [0, .3, .65, 1], [.86, 1, 1, .82]);
  const artTilt = useTransform(art, [.65, 1], [0, 18]);
  const photoZoom = useTransform(art, [.3, 1], [1, 1.35]);
  const tagTopX = useTransform(art, [.5, 1], [0, -70]);
  const tagTopRotate = useTransform(art, [.5, 1], [-5, -22]);
  const tagBottomY = useTransform(art, [.5, 1], [0, -170]);
  const tagBottomRotate = useTransform(art, [.5, 1], [3, 16]);

  // Values strip: leans with scroll speed while its stars spin with distance travelled.
  const stripSkew = useTransform(useSpring(useVelocity(scrollY), { stiffness: 300, damping: 50 }), [-3000, 3000], [7, -7]);
  const starSpin = useTransform(scrollY, value => value * .4);

  // School life: the photo opens like a portal and settles out of a zoom.
  const lifeRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress: lifeOpen } = useScroll({ target: lifeRef, offset: ['start 95%', 'start 45%'] });
  const lifeClip = useTransform(lifeOpen, value => {
    const closed = 1 - value;
    return closed <= 0 ? 'none' : `inset(${(closed * 16).toFixed(2)}% ${(closed * 22).toFixed(2)}% round ${(28 + closed * 160).toFixed(1)}px)`;
  });
  const lifeZoom = useTransform(lifeOpen, [0, 1], [1.5, 1]);
  const lifeWordX = useTransform(lifeOpen, [0, 1], [-80, 0]);

  const stages = [
    { id: 'primary', photo: photos.primary, name: 'Cambridge Primary', ages: '5–11', qualification: 'A foundation for discovery', description: 'Build strong foundations in knowledge, curiosity, and confidence, ready for the next stage of learning.' },
    { id: 'lower', photo: photos.lower, name: 'Cambridge Lower Secondary', ages: '11–14', qualification: 'Growing knowledge and independence', description: 'Deepen understanding and develop independent thinking as students prepare for upper secondary learning.' },
    { id: 'upper', photo: photos.upper, name: 'Cambridge Upper Secondary', ages: '14–16', qualification: 'IGCSE', description: 'Develop subject knowledge and skills through the Cambridge IGCSE pathway, preparing for further study.' },
    { id: 'advanced', photo: photos.advanced, name: 'Cambridge Advanced', ages: '16–19', qualification: 'AS & A Level', description: 'Explore subjects in greater depth through Cambridge AS & A Level, preparing for university and further education.' },
  ];
  return <>
    <a className="skip" href="#main">{t("Skip to content")}</a>
    <motion.div className="scroll-progress" style={{ scaleX: reduced ? scrollYProgress : progress }} />
    <header className="header"><Brand /><LanguageSwitcher /><button className="menu-toggle" aria-expanded={menuOpen} aria-controls="navigation" onClick={() => setMenuOpen(!menuOpen)}>{t("Menu")}<span>{menuOpen ? '×' : '☰'}</span></button><nav id="navigation" className={menuOpen ? 'open' : ''} aria-label={t("Main navigation")}><div className="nav-links">{[['about', 'Our school'], ['learning', 'Learning'], ['life', 'School life'], ['admissions', 'Admissions']].map(([id, title]) => <a key={id} href={`#${id}`} onClick={() => setMenuOpen(false)}>{t(title)}</a>)}</div></nav><a className="button small header-cta" href="#admissions">{t("Let’s meet")}<span>↗</span></a></header>
    <main id="main">
      <section className="hero"><motion.div ref={copyRef} className="hero-copy" style={reduced ? undefined : { y: copyY, opacity: copyOpacity }}><Reveal><motion.p variants={heroItem} className="eyebrow"><span />{t("BIG IDEAS. BRIGHT FUTURES.")}</motion.p><motion.h1 variants={heroItem}>{t("Your future.")}<br />{t("Your world.")}<br /><em>{t("Start here.")}</em></motion.h1><p className="grade-note">{t("For students in Grades 1–11")}</p><motion.p variants={heroItem} className="intro">{t("A place to ask bigger questions, discover new passions, and grow into who you’re meant to be.")}</motion.p><div className="hero-actions"><motion.a whileHover={reduced ? {} : { scale: 1.035 }} whileTap={{ scale: .98 }} className="button" href="#admissions">{t("Begin your journey")}<span>↗</span></motion.a><a className="text-link" href="#learning">{t("Explore your path")}<span>↓</span></a></div><div className="hero-foot"><span className="mini-sun">✳</span><p>{t("Rooted in curiosity.")}<br /><strong>{t("Growing beyond boundaries.")}</strong></p></div></Reveal></motion.div>
      <motion.div ref={artRef} className="hero-art" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .8 }} style={reduced ? undefined : { rotate: artRotate, scale: artScale, rotateX: artTilt, transformPerspective: 1000 }}><motion.span className="floating-tag tag-top" animate={reduced ? {} : { y: [0, -8, 0] }} transition={{ duration: 4, repeat: Infinity }} style={reduced ? undefined : { x: tagTopX, rotate: tagTopRotate }}>✦ {t("Ideas without limits")}</motion.span><motion.span className="floating-tag tag-bottom" style={reduced ? undefined : { y: tagBottomY, rotate: tagBottomRotate }}>↗ {t("Discover your next chapter")}</motion.span><div className="fx-frame"><motion.div className="fx-fill" style={reduced ? undefined : { scale: photoZoom }}><Photo photo={photos.campus} className="hero-photo" priority /></motion.div></div><a href="#learning" className="art-label"><span>{t("THE NEXT CHAPTER")}</span><strong>{t("Starts with curiosity.")}</strong><span className="label-arrow">↗</span></a></motion.div></section>
      <motion.div className="values-strip" style={reduced ? undefined : { skewX: stripSkew }}>{['Curiosity at heart', 'Confidence to explore', 'Connected to the world', 'A sense of belonging'].map((value, i) => <span key={value} className="flex items-center gap-5">{i > 0 && <motion.b aria-hidden="true" style={reduced ? undefined : { rotate: starSpin }}>✦</motion.b>}{t(value)}</span>)}</motion.div>
      <section className="about section" id="about"><Reveal><p className="eyebrow">{t("WELCOME TO BOBORAHIM MASHRAB")}</p><ScrubHeading lines={[[{ text: t("Great learning begins") }], [{ text: t("with") }, { text: t("being yourself."), em: true }]]} /></Reveal><Reveal className="about-copy" effect="right"><p>{t("Our vision for Boborahim Mashrab International School is simple: a community where young people feel known, inspired, and ready to explore the world.")}</p><p>{t("We’re shaping a school experience around thoughtful learning, meaningful connections, and the joy of discovery.")}</p><a className="text-link" href="#learning">{t("Find your starting point")}<span>↗</span></a></Reveal></section>
      <section className="learning section cambridge-section" id="learning">
        <Reveal effect="left"><div className="section-heading"><div><p className="eyebrow">{t("THE CAMBRIDGE PATHWAY")}</p><ScrubHeading lines={[[{ text: t("A world of learning.") }], [{ text: t("One step at a time."), em: true }]]} /></div><p>{t("Your child’s education develops step by step through the Cambridge pathway.")}</p></div></Reveal>
        {/* Each still cell watches the viewport, so the moving card inside it cannot shift its own trigger point. */}
        <div className="curriculum-cards">{stages.map((stage, index) => <motion.div className="curriculum-cell" key={stage.id} initial={reduced ? false : 'hidden'} whileInView="visible" viewport={{ once: true, amount: .12 }}><motion.article custom={index} variants={dealCard} className="curriculum-card" aria-labelledby={`stage-title-${stage.id}`}>
          <Photo photo={stage.photo} className="curriculum-card-photo" />
          <div className="curriculum-card-content"><div className="curriculum-card-meta"><span>{t('Ages')} {stage.ages}</span><span aria-hidden="true">0{index + 1}</span></div><h3 id={`stage-title-${stage.id}`}>{stage.name}</h3><p className="curriculum-card-qualification">{t(stage.qualification)}</p><p className="curriculum-card-description">{t(stage.description)}</p><a href="#admissions" className="curriculum-card-link" aria-label={`${t('Explore this stage')}: ${stage.name}`}>{t('Explore this stage')} <span aria-hidden="true">↗</span></a></div>
        </motion.article></motion.div>)}</div>
        <Reveal><div className="cambridge-note"><p>{t('Each stage develops knowledge and prepares students for the next step in education.')}</p><small>{t('Our school accepts students in Grades 1–11 only.')}</small></div></Reveal>
      </section>
      <section className="life section" id="life"><motion.div ref={lifeRef} className="life-visual life-with-photo" style={reduced ? undefined : { clipPath: lifeClip }}><AnimatePresence initial={false}><motion.div key={`photo-${experience}`} className="life-photo-layer" style={reduced ? undefined : { scale: lifeZoom }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .45 }}><Photo photo={[photos.writing, photos.lesson, photos.community][experience]} className="life-photo" /></motion.div></AnimatePresence><div className="life-photo-shade" aria-hidden="true" /><p className="eyebrow text-white/60">{t("A LITTLE MORE YOU, EVERY DAY")}</p><AnimatePresence mode="wait"><motion.div key={experience} className="life-word mt-12" style={reduced ? undefined : { x: lifeWordX }} initial={{ opacity: 0, y: reduced ? 0 : 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>{t(experiences[experience].word)}<br /><em>{t("at school.")}</em></motion.div></AnimatePresence><span className="life-star" aria-hidden="true">✳</span><span className="life-caption">{t("MORE THAN A CLASSROOM")}</span></motion.div><Reveal className="life-copy" effect="right"><p className="eyebrow">{t("ROOM FOR EVERY SIDE OF YOU")}</p><ScrubHeading lines={[[{ text: t("Find what") }], [{ text: t("makes you, you."), em: true }]]} /><p>{t("Learning goes beyond lessons. Explore our vision for creativity, movement, and connection.")}</p><div className="experience-list">{experiences.map((item, index) => <div key={t(item.name)} className="border-t border-brand/15"><button className="flex w-full items-center gap-4 py-5 text-left text-sm" id={`experience-${index}`} aria-expanded={experience === index} aria-controls={`experience-panel-${index}`} onClick={() => setExperience(index)}><span className="text-xs text-slate-500">0{index + 1}</span>{t(item.name)}<span className="ml-auto text-xl">{experience === index ? '−' : '+'}</span></button><motion.div id={`experience-panel-${index}`} role="region" aria-labelledby={`experience-${index}`} animate={{ height: experience === index ? 'auto' : 0, opacity: experience === index ? 1 : 0 }} transition={{ duration: reduced ? 0 : .35, ease: [.22, 1, .36, 1] }} className="overflow-hidden" inert={experience !== index}><p className="pb-5 pl-8 text-xs leading-7 text-slate-600">{t(item.text)}</p></motion.div></div>)}</div></Reveal></section>
      <section className="questions section"><Reveal effect="left"><p className="eyebrow">{t("GOOD QUESTIONS. A GREAT START.")}</p><h2>{t("A little more")}<br /><em>{t("to explore.")}</em></h2></Reveal><motion.div className="faq" variants={slideList} initial={reduced ? false : 'hidden'} whileInView="visible" viewport={{ once: true, amount: .15 }}>{[
        ['How can I ask about admissions?', 'Use the enquiry form below. In this local development version, submissions are saved to your local database and prepared for review. Nothing is emailed to the school.'],
        ['Which curriculum does the school follow?', 'Our school follows the Cambridge curriculum. Each stage develops knowledge and prepares students for the next step in education.'],
        ['Which grades does the school accept?', 'Our school accepts students in Grades 1–11 only. We do not offer preschool education.'],
        ['Can I arrange a school visit?', 'Visit arrangements and the campus address have not yet been provided. Include your interest in a visit in your enquiry.'],
      ].map(([question, answer]) => <motion.div key={question} variants={slideItem}><Accordion question={t(question)} answer={t(answer)} /></motion.div>)}</motion.div></section>
      <Admissions />
    </main><footer><Brand /><p>{t("A world of possibility.")}<br /><small>© {new Date().getFullYear()} {" "}{t("Boborahim Mashrab International School")} · {t("Website concept")}</small></p><div className="flex flex-wrap gap-5"><a className="text-link" href="/admin">{t("Admin panel")} ↗</a><a className="text-link" href="#">{t("Back to top")} ↑</a></div></footer>
  </>;
}
