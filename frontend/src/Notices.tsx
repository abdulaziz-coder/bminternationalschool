import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { getNotices } from './api';
import { useLanguage } from './i18n';
import { Reveal, ScrubHeading } from './ScrollFx';
import type { Notice } from './schemas';
import PinIcon from './PinIcon';
import { categoryTone, distinctCategories } from './notice-categories';
import './notices.css';

/** Notice text as written: line breaks are kept by CSS and web addresses become links. */
function NoticeText({ text }: { text: string }) {
  return <>{text.split(/(https?:\/\/[^\s<>"]+)/g).map((part, index) => {
    if (index % 2 === 0) return part;
    // Keep sentence punctuation that follows an address out of the link.
    const [, address, trailing] = part.match(/^(.*?)([.,;:!?)]*)$/)!;
    return <span key={index}><a href={address} target="_blank" rel="noopener noreferrer">{address}</a>{trailing}</span>;
  })}</>;
}

function NoticeCard({ notice, index }: { notice: Notice; index: number }) {
  const { t, locale } = useLanguage();
  const reduced = useReducedMotion();
  const id = useId();
  const [open, setOpen] = useState(false);
  const long = notice.body.length > 260 || notice.body.split('\n').length > 4;
  const date = new Intl.DateTimeFormat(locale === 'uz' ? 'uz-UZ' : locale === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(notice.published_at));
  return <motion.article className={`notice-card tone-${categoryTone(notice.category)}${notice.pinned ? ' pinned' : ''}`} aria-labelledby={`${id}-title`} initial={reduced ? false : { opacity: 0, y: 44, scale: .96 }} whileInView={{ opacity: 1, y: 0, scale: 1 }} viewport={{ once: true, amount: .15 }} transition={{ type: 'spring', stiffness: 110, damping: 16, delay: (index % 2) * .08 }}>
    <div className="notice-meta"><span className="notice-tags">{notice.pinned && <span className="notice-pin"><PinIcon filled />{t('Pinned')}</span>}<span className="notice-badge">{t(notice.category)}</span></span><time dateTime={notice.published_at}>{date}</time></div>
    <h3 id={`${id}-title`}>{notice.title}</h3>
    <p id={`${id}-body`} className={long && !open ? 'notice-body clamped' : 'notice-body'}><NoticeText text={notice.body} /></p>
    {long && <button type="button" className="notice-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen(!open)}>{t(open ? 'Show less' : 'Read more')} <span aria-hidden="true">{open ? '↑' : '↓'}</span></button>}
  </motion.article>;
}

export default function Notices() {
  const { t } = useLanguage();
  const [chosen, setChosen] = useState<string | null>(null);
  const notices = useQuery({ queryKey: ['notices'], queryFn: getNotices });
  // Filters follow the categories admins have actually used; a filter whose last notice was removed falls back to All.
  const categories = distinctCategories((notices.data ?? []).map(notice => notice.category));
  const filter = chosen !== null && categories.includes(chosen) ? chosen : null;
  const shown = (notices.data ?? []).filter(notice => filter === null || notice.category === filter);
  return <section className="notices section" id="notices">
    <Reveal effect="left"><div className="section-heading"><div><p className="eyebrow">{t('NEWS AND ADMISSIONS')}</p><ScrubHeading lines={[[{ text: t('News and guides') }], [{ text: t('for your family.'), em: true }]]} /></div><p>{t('School news and admission guides for the new academic year.')}</p></div></Reveal>
    {categories.length > 1 && <div className="notice-filters" role="group" aria-label={t('Filter notices')}><button type="button" aria-pressed={filter === null} onClick={() => setChosen(null)}>{t('All')}</button>{categories.map(category => <button key={category} type="button" aria-pressed={filter === category} onClick={() => setChosen(category)}>{t(category)}</button>)}</div>}
    {notices.isPending ? <p className="notice-state" role="status">{t('Loading…')}</p>
      : notices.isError ? <p className="notice-state" role="status">{t('Notices are unavailable right now. Please try again later.')}</p>
      : shown.length ? <div className="notice-list">{shown.map((notice, index) => <NoticeCard key={notice.id} notice={notice} index={index} />)}</div>
      : <div className="notice-state"><span aria-hidden="true">✳</span><strong>{t('No notices yet.')}</strong>{<p>{t('New announcements will appear here.')}</p>}</div>}
  </section>;
}
