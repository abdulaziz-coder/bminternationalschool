import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { getNotices } from './api';
import { useLanguage } from './i18n';
import { Reveal, ScrubHeading } from './ScrollFx';
import type { Notice } from './schemas';
import './notices.css';

const filters = [['all', 'All'], ['news', 'News'], ['admission_guide', 'Admission guides']] as const;
type Filter = typeof filters[number][0];

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
  return <motion.article className={`notice-card ${notice.category}`} aria-labelledby={`${id}-title`} initial={reduced ? false : { opacity: 0, y: 44, scale: .96 }} whileInView={{ opacity: 1, y: 0, scale: 1 }} viewport={{ once: true, amount: .15 }} transition={{ type: 'spring', stiffness: 110, damping: 16, delay: (index % 2) * .08 }}>
    <div className="notice-meta"><span className="notice-badge">{t(notice.category === 'news' ? 'News' : 'Admission guide')}</span><time dateTime={notice.published_at}>{date}</time></div>
    <h3 id={`${id}-title`}>{notice.title}</h3>
    <p id={`${id}-body`} className={long && !open ? 'notice-body clamped' : 'notice-body'}><NoticeText text={notice.body} /></p>
    {long && <button type="button" className="notice-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen(!open)}>{t(open ? 'Show less' : 'Read more')} <span aria-hidden="true">{open ? '↑' : '↓'}</span></button>}
  </motion.article>;
}

export default function Notices() {
  const { t } = useLanguage();
  const [filter, setFilter] = useState<Filter>('all');
  const notices = useQuery({ queryKey: ['notices'], queryFn: getNotices });
  const shown = (notices.data ?? []).filter(notice => filter === 'all' || notice.category === filter);
  return <section className="notices section" id="notices">
    <Reveal effect="left"><div className="section-heading"><div><p className="eyebrow">{t('NEWS AND ADMISSIONS')}</p><ScrubHeading lines={[[{ text: t('News and guides') }], [{ text: t('for your family.'), em: true }]]} /></div><p>{t('School news and admission guides for the new academic year.')}</p></div></Reveal>
    {!!notices.data?.length && <div className="notice-filters" role="group" aria-label={t('Filter notices')}>{filters.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(label)}</button>)}</div>}
    {notices.isPending ? <p className="notice-state" role="status">{t('Loading…')}</p>
      : notices.isError ? <p className="notice-state" role="status">{t('Notices are unavailable right now. Please try again later.')}</p>
      : shown.length ? <div className="notice-list">{shown.map((notice, index) => <NoticeCard key={notice.id} notice={notice} index={index} />)}</div>
      : <div className="notice-state"><span aria-hidden="true">✳</span><strong>{t(filter === 'all' ? 'No notices yet.' : 'No notices in this category yet.')}</strong>{filter === 'all' && <p>{t('New announcements will appear here.')}</p>}</div>}
  </section>;
}
