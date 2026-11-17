import { useLanguage } from './i18n';

export const social = {
  instagram: { href: 'https://www.instagram.com/b_m_international_school', handle: '@b_m_international_school' },
  channel: { href: 'https://t.me/bminternationalschool', handle: '@bminternationalschool' },
  chat: { href: 'https://t.me/bminternation', handle: '@bminternation' },
};

export const InstagramIcon = () => <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.2" cy="6.8" r=".9" fill="currentColor" stroke="none" /></svg>;
export const TelegramIcon = () => <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"><path d="M21 4 3 11.2l5.6 2 2 6.3 3.2-4 4.6 3.5z" /><path d="m8.6 13.2 8.2-6" /></svg>;

function SocialLink({ href, icon, label, handle }: { href: string; icon: React.ReactNode; label: string; handle: string }) {
  return <li><a className="social-link" href={href} target="_blank" rel="noopener noreferrer"><span className="social-icon">{icon}</span><span className="social-text"><strong>{label}</strong><small>{handle}</small></span></a></li>;
}

/** Footer columns: where to follow the school, and where to write to it. */
export default function SocialLinks() {
  const { t } = useLanguage();
  return <>
    <nav className="footer-column" aria-label={t('Follow us')}><h2 className="footer-heading">{t('Follow us')}</h2><ul>
      <SocialLink href={social.instagram.href} icon={<InstagramIcon />} label="Instagram" handle={social.instagram.handle} />
      <SocialLink href={social.channel.href} icon={<TelegramIcon />} label={t('Telegram channel')} handle={social.channel.handle} />
    </ul></nav>
    <nav className="footer-column" aria-label={t('Contact us')}><h2 className="footer-heading">{t('Contact us')}</h2><ul>
      <SocialLink href={social.chat.href} icon={<TelegramIcon />} label={t('Message us on Telegram')} handle={social.chat.handle} />
    </ul></nav>
  </>;
}
